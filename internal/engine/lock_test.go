package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLockDataDirExcludesASecondRun(t *testing.T) {
	dir := t.TempDir()
	release, err := LockDataDir(dir)
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}
	// A second attempt while the first holder (this process) is alive must fail.
	if _, err := LockDataDir(dir); err == nil {
		t.Fatal("second lock succeeded; concurrent runs would corrupt the data dir")
	} else if !strings.Contains(err.Error(), fmt.Sprint(os.Getpid())) {
		t.Errorf("error should name the holding pid, got: %v", err)
	}
	// After release the dir is free again, and the file is gone.
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, serr := os.Stat(filepath.Join(dir, LockName)); serr == nil {
		t.Error("release left the lock file behind")
	}
	release2, err := LockDataDir(dir)
	if err != nil {
		t.Fatalf("re-lock after release: %v", err)
	}
	release2()
}

// A crash or kill -9 must not wedge the data dir forever: a lock naming a dead
// process is stale and gets taken over.
func TestLockDataDirTakesOverStaleLock(t *testing.T) {
	dir := t.TempDir()
	// PID 0 is never a live user process, and readLock treats a malformed pid
	// as stale too — both paths must be recoverable.
	for _, content := range []string{"0\nsome old command\n", "garbage\n", ""} {
		if err := os.WriteFile(filepath.Join(dir, LockName), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		release, err := LockDataDir(dir)
		if err != nil {
			t.Fatalf("lock over stale content %q: %v", content, err)
		}
		if err := release(); err != nil {
			t.Fatalf("release: %v", err)
		}
	}
}

func TestLockDataDirRecordsPidAndCommand(t *testing.T) {
	dir := t.TempDir()
	release, err := LockDataDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	pid, cmd := readLock(filepath.Join(dir, LockName))
	if pid != os.Getpid() {
		t.Errorf("recorded pid = %d, want %d", pid, os.Getpid())
	}
	if cmd == "" {
		t.Error("lock file should record the command line for the error message")
	}
	if !processAlive(os.Getpid()) {
		t.Error("processAlive says this very process is dead")
	}
}
