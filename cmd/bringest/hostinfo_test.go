package main

import "testing"

func TestParseMemTotal(t *testing.T) {
	if got := parseMemTotal("MemTotal:       16318412 kB\nMemFree: 1 kB\n"); got != 16318412*1024 {
		t.Errorf("MemTotal = %d", got)
	}
	if got := parseMemTotal("MemFree: 1 kB\n"); got != 0 {
		t.Errorf("missing MemTotal = %d, want 0", got)
	}
}

func TestParseCPUInfo(t *testing.T) {
	// Two SMT siblings per core, two cores: 4 logical CPUs, 2 physical cores.
	const info = `processor	: 0
model name	: AMD Ryzen 7 5800X 8-Core Processor
physical id	: 0
core id		: 0

processor	: 1
model name	: AMD Ryzen 7 5800X 8-Core Processor
physical id	: 0
core id		: 1

processor	: 2
model name	: AMD Ryzen 7 5800X 8-Core Processor
physical id	: 0
core id		: 0

processor	: 3
model name	: AMD Ryzen 7 5800X 8-Core Processor
physical id	: 0
core id		: 1
`
	model, cores := parseCPUInfo(info)
	if model != "AMD Ryzen 7 5800X 8-Core Processor" || cores != 2 {
		t.Errorf("got %q, %d cores", model, cores)
	}
	// No topology fields (some VMs): the model still reads, cores stay unknown.
	model, cores = parseCPUInfo("processor : 0\nmodel name : Some CPU\n")
	if model != "Some CPU" || cores != 0 {
		t.Errorf("got %q, %d cores", model, cores)
	}
}

func TestNewJobStatsCarriesHost(t *testing.T) {
	defer func(h hostInfo) { thisHost = h }(thisHost)
	thisHost = hostInfo{Hostname: "box", MemBytes: 1 << 34, Cores: 8, Threads: 16, CPUModel: "X"}
	st := newJobStats(kindResim)
	if st.Host == nil || st.Host.Hostname != "box" || st.Host.Cores != 8 {
		t.Errorf("host = %+v", st.Host)
	}
}

func TestReadHostInfo(t *testing.T) {
	h := readHostInfo()
	if h.Threads < 1 || h.OS == "" {
		t.Errorf("host = %+v", h)
	}
}
