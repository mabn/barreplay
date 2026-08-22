package engine

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParseMemAvailable(t *testing.T) {
	const meminfo = "MemTotal:        8136016 kB\nMemFree:          123456 kB\n" +
		"MemAvailable:    1649536 kB\nBuffers:            2048 kB\n"
	got, ok := parseMemAvailable(meminfo)
	if !ok {
		t.Fatal("parseMemAvailable: not ok")
	}
	if want := int64(1649536) * 1024; got != want {
		t.Errorf("parseMemAvailable = %d, want %d", got, want)
	}
	// MemFree comes FIRST in the file and is a different number; a parser that
	// matched loosely would return it.
	if got == int64(123456)*1024 {
		t.Error("parseMemAvailable returned MemFree")
	}

	// Anything unusable is "no reading", never a made-up number: the guard
	// treats "I do not know" as "do not stop the run", so a wrong value here
	// would kill runs rather than merely fail to protect them.
	for name, in := range map[string]string{
		"missing":      "MemTotal: 100 kB\n",
		"empty":        "",
		"no value":     "MemAvailable:\n",
		"not a number": "MemAvailable:   plenty kB\n",
		"negative":     "MemAvailable:   -1 kB\n",
		"prefix only":  "MemAvailableFoo:   64 kB\n",
	} {
		if _, ok := parseMemAvailable(in); ok {
			t.Errorf("parseMemAvailable(%s) = ok, want not ok", name)
		}
	}
}

func TestFormatBytes(t *testing.T) {
	for in, want := range map[int64]string{
		512 << 20:     "512 MB",
		3 << 30:       "3.0 GB",
		6_890_908_000: "6.4 GB",
		400:           "400 B",
	} {
		if got := FormatBytes(in); got != want {
			t.Errorf("FormatBytes(%d) = %q, want %q", in, got, want)
		}
	}
}

// The guard's whole contract in one test: it fires below the floor, stays quiet
// above it, fires ONCE, and — the case that matters most — does nothing at all
// when the reading is unavailable, since a net that trips on "I do not know"
// would kill every run on a kernel that publishes no such number.
func TestWatchMemoryFiresOnceBelowTheFloor(t *testing.T) {
	t.Run("below the floor", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		got := make(chan int64, 4)
		// A floor above anything the machine can report: MemAvailable is always
		// less than "everything", so this trips on the first tick.
		go WatchMemory(ctx, 1<<62, time.Millisecond, func(avail int64) { got <- avail })
		select {
		case avail := <-got:
			if avail <= 0 {
				t.Errorf("stopped with avail = %d, want the real reading", avail)
			}
		case <-ctx.Done():
			t.Fatal("the guard never fired")
		}
		// ...and only once: it returns after stopping, so a second reading
		// cannot arrive to overwrite the one that explains the decision.
		select {
		case avail := <-got:
			t.Errorf("the guard fired twice (second reading %d)", avail)
		case <-time.After(50 * time.Millisecond):
		}
	})

	t.Run("above the floor", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		fired := make(chan int64, 1)
		go WatchMemory(ctx, 1, time.Millisecond, func(avail int64) { fired <- avail })
		select {
		case <-fired:
			t.Error("the guard fired with memory to spare")
		case <-ctx.Done():
		}
	})

	t.Run("disabled", func(t *testing.T) {
		fired := make(chan int64, 1)
		// Returns immediately rather than polling: 0 and below mean off.
		WatchMemory(context.Background(), 0, time.Millisecond, func(avail int64) { fired <- avail })
		select {
		case <-fired:
			t.Error("a disabled guard fired")
		default:
		}
	})
}

// Against a real child process, because the thing being checked is a kernel
// permission rule: raising oom_score_adj is allowed unprivileged, which is what
// lets an ordinary daemon mark its engine as the OOM killer's first choice.
func TestSetOOMScoreAdj(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("no /proc")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, "sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a child: %v", err)
	}
	defer cmd.Wait()
	pid := cmd.Process.Pid

	if err := SetOOMScoreAdj(pid, EngineOOMScoreAdj); err != nil {
		t.Fatalf("SetOOMScoreAdj: %v", err)
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/oom_score_adj")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(b)); got != strconv.Itoa(EngineOOMScoreAdj) {
		t.Errorf("oom_score_adj = %s, want %d", got, EngineOOMScoreAdj)
	}
	cancel()
}

// A pid that is gone is a warning, not a failure — Run treats this as a
// preference it could not express, never a reason to abandon a re-simulation.
func TestSetOOMScoreAdjMissingPid(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("no /proc")
	}
	if err := SetOOMScoreAdj(1<<30, EngineOOMScoreAdj); err == nil {
		t.Error("SetOOMScoreAdj on a dead pid = nil, want an error for the caller to warn about")
	}
}
