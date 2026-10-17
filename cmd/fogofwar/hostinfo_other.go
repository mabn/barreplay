//go:build !windows

package main

import (
	"os"
	"runtime"
	"strings"
	"syscall"
)

// cpuInfo reads the CPU model and physical core count from /proc/cpuinfo
// (the app is a Windows program; this is what its tests and a Linux dev
// build see).
func cpuInfo() (model string, cores int) {
	b, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return "", 0
	}
	seen := map[string]bool{}
	phys := ""
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "model name":
			if model == "" {
				model = v
			}
		case "physical id":
			phys = v
		case "core id":
			seen[phys+"/"+v] = true
		}
	}
	return model, len(seen)
}

func osInfo() (name, build string) { return runtime.GOOS + "/" + runtime.GOARCH, "" }

// diskFree is the space free to this user on dir's filesystem; 0 if unknown.
func diskFree(dir string) int64 {
	var st syscall.Statfs_t
	if syscall.Statfs(dir, &st) != nil {
		return 0
	}
	return int64(st.Bavail) * int64(st.Bsize)
}
