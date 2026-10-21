//go:build !windows

package engine

import (
	"os"
	"os/exec"
)

// hideChild is a no-op off Windows: a child there shares the terminal the
// way it always has, and a re-sim's priority is the operator's to set.
func hideChild(*exec.Cmd, bool) {}

func memAvailable() (int64, bool) { return memAvailableProc() }

func sampleProcess(pid int) (ProcSample, bool) { return sampleProcessProc(pid) }

// MemTotal is the machine's physical memory (/proc/meminfo MemTotal).
func MemTotal() (int64, bool) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, false
	}
	return parseMeminfo(string(b), "MemTotal:")
}
