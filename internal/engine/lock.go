// Data-dir mutual exclusion. A run is NOT isolated within its data dir: it
// rewrites shared state there — the widget order config (EnableWidget backs the
// user's up and restores it afterwards), _barreplay_script.txt, the merged
// springsettings, infolog.txt, and the widget's stream under barreplay/. Two
// concurrent runs therefore corrupt each other, and the symptom is remote from
// the cause: the second run's teardown restores the widget config out from
// under the first, whose widget then never loads, so it fails minutes later
// with "open widget output ...: no such file or directory" and no hint that
// another process was involved. Observed for real, killing a re-sim 17% in.
//
// So take an advisory lock and fail fast with a message that names the culprit.
package engine

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// LockName is the lock file's name inside the data dir.
const LockName = ".barreplay.lock"

// LockDataDir takes an exclusive advisory lock on dataDir and returns a release
// func. It fails when another live process holds it; a lock left by a process
// that has since died is stale and gets taken over, so a crash or a kill -9
// never wedges the data dir permanently.
//
// Advisory by design: it only guards this tool's own runs against each other,
// which is the collision that actually happens.
func LockDataDir(dataDir string) (func() error, error) {
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(abs, LockName)
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(f, "%d\n%s\n", os.Getpid(), strings.Join(os.Args, " "))
			f.Close()
			return func() error { return os.Remove(path) }, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
		// Held — by a live process, or left behind by a dead one?
		pid, cmdline := readLock(path)
		if pid > 0 && processAlive(pid) {
			return nil, fmt.Errorf("another barreplay run (pid %d%s) is using the data dir %s — "+
				"runs share the widget config, startscript and stream dir there, so they would "+
				"corrupt each other; wait for it, or use a separate -data directory",
				pid, cmdline, abs)
		}
		// Stale: whoever wrote it is gone. Clear it and retry once. A racing
		// third process may win that retry, which is correct — it then holds a
		// lock we will report on the next pass.
		if rerr := os.Remove(path); rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
			return nil, fmt.Errorf("removing stale lock %s: %w", path, rerr)
		}
		fmt.Fprintf(os.Stderr, "engine: cleared a stale lock in %s (pid %d is gone)\n", abs, pid)
	}
	return nil, fmt.Errorf("could not lock the data dir %s: it kept being re-locked", abs)
}

// readLock returns the pid recorded in the lock file and a " running <cmd>"
// suffix for the error message. A malformed file yields pid 0, which the caller
// treats as stale.
func readLock(path string) (int, string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, ""
	}
	lines := strings.SplitN(strings.TrimSpace(string(b)), "\n", 2)
	pid, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil {
		return 0, ""
	}
	cmd := ""
	if len(lines) > 1 && strings.TrimSpace(lines[1]) != "" {
		cmd = ", running " + strings.TrimSpace(lines[1])
	}
	return pid, cmd
}

// processAlive reports whether pid is a running process.
func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		// Windows: FindProcess fails when the process does not exist.
		return false
	}
	if runtime.GOOS == "windows" {
		// ...and succeeds only when it does; Signal is not supported there.
		return true
	}
	// Unix: FindProcess always succeeds, so probe with signal 0.
	return p.Signal(syscall.Signal(0)) == nil
}
