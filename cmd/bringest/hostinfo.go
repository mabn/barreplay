package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// hostInfo says WHERE a job ran. It rides on every job's stats beside the
// build, because the daemon runs on somebody's machine behind NAT and the
// queue page is the only place anyone else sees it: a re-sim's timings and
// its out-of-memory failures mean nothing without the box that produced them.
type hostInfo struct {
	Hostname string `json:"hostname,omitempty"`
	// MemBytes is the host's total RAM (MemTotal), not what was free.
	MemBytes int64 `json:"memBytes,omitempty"`
	// Cores is physical cores where /proc/cpuinfo says, Threads the logical
	// CPUs the Go runtime sees.
	Cores    int    `json:"cores,omitempty"`
	Threads  int    `json:"threads,omitempty"`
	CPUModel string `json:"cpuModel,omitempty"`
	OS       string `json:"os,omitempty"`
}

// readHostInfo looks the host up once, at startup. Best-effort: anything it
// cannot read (no /proc off Linux) is simply left out.
func readHostInfo() hostInfo {
	h := hostInfo{Threads: runtime.NumCPU(), OS: runtime.GOOS + "/" + runtime.GOARCH}
	h.Hostname, _ = os.Hostname()
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		h.MemBytes = parseMemTotal(string(b))
	}
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		h.CPUModel, h.Cores = parseCPUInfo(string(b))
	}
	return h
}

// parseMemTotal reads MemTotal (kB) out of /proc/meminfo, in bytes; 0 if absent.
func parseMemTotal(meminfo string) int64 {
	for _, line := range strings.Split(meminfo, "\n") {
		rest, ok := strings.CutPrefix(line, "MemTotal:")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			return 0
		}
		kb, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil || kb < 0 {
			return 0
		}
		return kb * 1024
	}
	return 0
}

// parseCPUInfo reads the CPU model and the PHYSICAL core count out of
// /proc/cpuinfo: distinct (physical id, core id) pairs, which is right across
// sockets and with SMT. A file without those fields (some VMs, ARM) gives 0
// cores, and the logical count stands alone.
func parseCPUInfo(cpuinfo string) (model string, cores int) {
	seen := map[string]bool{}
	phys, core := "", ""
	flush := func() {
		if core != "" {
			seen[phys+"/"+core] = true
		}
		phys, core = "", ""
	}
	for _, line := range strings.Split(cpuinfo, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			if strings.TrimSpace(line) == "" {
				flush()
			}
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "model name", "Model", "cpu model":
			if model == "" {
				model = v
			}
		case "physical id":
			phys = v
		case "core id":
			core = v
		}
	}
	flush()
	return model, len(seen)
}

// String is the one-line form for the startup log.
func (h hostInfo) String() string {
	s := h.Hostname
	if s == "" {
		s = "unknown host"
	}
	if h.MemBytes > 0 {
		s += fmt.Sprintf(", %.1f GiB RAM", float64(h.MemBytes)/(1<<30))
	}
	if h.Cores > 0 {
		s += fmt.Sprintf(", %d cores/%d threads", h.Cores, h.Threads)
	} else {
		s += fmt.Sprintf(", %d CPUs", h.Threads)
	}
	if h.CPUModel != "" {
		s += ", " + h.CPUModel
	}
	return s
}
