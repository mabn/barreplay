package engine

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// EngineOOMScoreAdj is what Run stamps on the engine process, telling the
// kernel's OOM killer to take it before anything else on the machine.
//
// The maximum, deliberately. A headless re-simulation is the most disposable
// thing on a host by a wide margin — it is batch work that can simply be run
// again — while everything it shares the machine with (the daemon, the login
// session, sshd) is not. Without this the kernel picks by badness score, which
// happens to choose the engine anyway because it is the biggest, but "happens
// to" is not a guarantee: a run that has only just started is small, and the
// process that gets killed instead would be somebody's shell.
//
// Raising the value needs no privilege (lowering below the inherited value
// needs CAP_SYS_RESOURCE), so this works for an unprivileged daemon.
//
// NOTE what this does NOT fix: systemd stops an entire unit when a member is
// OOM-killed if that unit's OOMPolicy is "stop", which is the default for the
// scopes a user manager creates (a tmux pane, for instance). Being the chosen
// victim does not help there — the fix for that is not being killed at all,
// which is what WatchMemory is for.
const EngineOOMScoreAdj = 1000

// SetOOMScoreAdj marks a process for the OOM killer's attention. Best-effort:
// the file is absent on a non-Linux kernel and the write can be refused, and
// neither is worth failing a run over — it is a preference, not a requirement.
func SetOOMScoreAdj(pid, adj int) error {
	path := "/proc/" + strconv.Itoa(pid) + "/oom_score_adj"
	return os.WriteFile(path, []byte(strconv.Itoa(adj)), 0o644)
}

// DefaultMinFreeBytes is how little memory the host may have left before
// WatchMemory stops the engine.
//
// 512 MiB is chosen to be comfortably more than the engine can allocate between
// two samples (it grows at single-digit MB/s even late in a big game, against a
// sample every few seconds) and comfortably more than the rest of a small
// machine needs to stay responsive — but small enough that a run which would
// have fitted is not stopped for nothing.
const DefaultMinFreeBytes int64 = 512 << 20

// MemAvailable is the kernel's own estimate of how much memory can still be
// handed out without swapping — /proc/meminfo's MemAvailable, which already
// accounts for reclaimable page cache, and is therefore the right number to
// watch rather than MemFree. Best-effort: ok=false where there is no
// /proc/meminfo, or no such line on an ancient kernel.
func MemAvailable() (int64, bool) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, false
	}
	return parseMemAvailable(string(b))
}

// parseMemAvailable pulls MemAvailable out of /proc/meminfo, in bytes. The
// file's lines are "Key:<space>N kB"; the unit is always kB for these entries.
func parseMemAvailable(meminfo string) (int64, bool) {
	for _, line := range strings.Split(meminfo, "\n") {
		rest, ok := strings.CutPrefix(line, "MemAvailable:")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			return 0, false
		}
		kb, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil || kb < 0 {
			return 0, false
		}
		return kb * 1024, true
	}
	return 0, false
}

// WatchMemory stops a run before the kernel does.
//
// It polls the host's free memory every interval and, the first time it falls
// below minFree, calls stop and returns. The caller's stop is what actually
// ends the engine — cancelling the context it was launched with, which sends it
// a SIGKILL.
//
// Being killed by US rather than by the kernel is the entire point, and it is
// worth being precise about why, because the two look identical from the
// engine's side. A kernel OOM kill is a machine-wide event: it fires only once
// memory is genuinely exhausted, by which time everything on the box has been
// thrashing for a while, and systemd tears down whole units around it whenever
// their OOMPolicy is "stop" — which is the default for the scopes a user
// manager creates, so an OOM-killed engine takes the tmux pane it was started
// from with it. Stopping first means none of that happens: no global OOM, no
// collateral, and a run that ends with an explanation instead of a process that
// vanished.
//
// It watches the HOST, not the engine, deliberately. What matters is whether
// the machine is about to run out, and the engine is the disposable thing on it
// either way — the same judgement EngineOOMScoreAdj encodes. minFree <= 0
// disables the watch entirely.
func WatchMemory(ctx context.Context, minFree int64, interval time.Duration, stop func(avail int64)) {
	if minFree <= 0 {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			avail, ok := MemAvailable()
			// A reading we cannot take is not a reason to stop a run: the guard
			// is a safety net, and a net that fires on "I do not know" would
			// kill every run on a kernel that does not publish the number.
			if !ok || avail >= minFree {
				continue
			}
			stop(avail)
			return
		}
	}
}

// FormatBytes renders a byte count the way these messages want it: a couple of
// significant figures and a unit, since they are read by a person deciding
// whether a machine is big enough.
func FormatBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.0f MB", float64(n)/(1<<20))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
