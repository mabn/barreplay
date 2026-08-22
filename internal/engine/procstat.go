package engine

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// userHZ is the kernel's clock-tick rate, which is what /proc/<pid>/stat counts
// CPU time in. It is a compile-time constant of the kernel (USER_HZ), readable
// only through sysconf(_SC_CLK_TCK) — a libc call, and this repo is cgo-free —
// but it has been 100 on every Linux/amd64 build for decades and the value is
// part of the /proc ABI (procps hardcodes it the same way). A wrong value here
// would only ever scale the reported CPU percentage, never break a run.
const userHZ = 100

// ProcSample is one reading of a running process's resource use, taken from
// /proc. It is a raw, cumulative reading: CPUSec counts the process's total CPU
// time since it started, so a PERCENTAGE needs two samples (see CPUPercent).
type ProcSample struct {
	// RSSBytes is resident set size — the physical memory the process is
	// actually holding, which for the engine is dominated by the map, the unit
	// models it never draws, and the sim state.
	RSSBytes int64
	// SwapBytes is how much of the process has been pushed OUT to swap. Zero is
	// the healthy answer and the usual one; anything else is the direct
	// explanation for a re-simulation that has gone slow, since a sim frame
	// that has to fault its own state back in is doing disk I/O per frame.
	// Also zero on a host with no swap configured, which reads the same and
	// means the same thing for the run.
	SwapBytes int64
	// CPUSec is user+system CPU time consumed since the process started. The
	// engine is threaded, so this grows faster than wall time when its worker
	// pool is busy.
	CPUSec float64
	// At is when the sample was taken, which is what turns two CPUSec readings
	// into a rate.
	At time.Time
}

// CPUPercent is the CPU the process used between two samples, as a percentage
// of ONE core — so a fully busy 4-thread engine reports ~400. Returns 0 when
// the samples cannot bracket an interval (same instant, or reversed).
func CPUPercent(prev, cur ProcSample) float64 {
	dt := cur.At.Sub(prev.At).Seconds()
	if dt <= 0 {
		return 0
	}
	d := cur.CPUSec - prev.CPUSec
	if d < 0 {
		return 0 // the pid was reused, or the counter went backwards; report nothing
	}
	return 100 * d / dt
}

// SampleProcess reads pid's current memory and CPU use. It is best-effort by
// design: the caller is a progress reporter, and a process that has just exited
// (or a platform with no /proc) must cost nothing more than a missing number,
// so every failure is ok=false rather than an error.
func SampleProcess(pid int) (ProcSample, bool) {
	if pid <= 0 {
		return ProcSample{}, false
	}
	dir := "/proc/" + strconv.Itoa(pid)
	b, err := os.ReadFile(dir + "/stat")
	if err != nil {
		return ProcSample{}, false
	}
	s, ok := parseProcStat(string(b), time.Now())
	if !ok {
		return ProcSample{}, false
	}
	// Swap lives in the OTHER file: /proc/<pid>/stat has no field for it, and
	// status is the only place the kernel publishes it per process. Its absence
	// is not a failure — a kernel built without swap support has no VmSwap line
	// at all — so a missing reading is zero, which is also what it would say.
	if st, serr := os.ReadFile(dir + "/status"); serr == nil {
		s.SwapBytes = parseProcStatusSwap(string(st))
	}
	return s, true
}

// parseProcStatusSwap pulls the VmSwap line out of /proc/<pid>/status, in
// bytes. The file is "Key:\t<n> kB" lines; the unit is always kB for the Vm*
// entries, which is why it is multiplied rather than parsed. Returns 0 for a
// missing or unreadable line — see the note at the call site.
func parseProcStatusSwap(status string) int64 {
	for _, line := range strings.Split(status, "\n") {
		rest, ok := strings.CutPrefix(line, "VmSwap:")
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

// parseProcStat pulls RSS and CPU time out of one /proc/<pid>/stat line.
//
// The comm field (2) is the executable name in parentheses and may contain
// BOTH spaces and parentheses, so the line cannot be split on whitespace from
// the start — everything is indexed from the LAST ')' instead, which is how
// the kernel documents the file and how procps reads it. From there, field 14
// is utime, 15 stime and 24 rss (in pages).
func parseProcStat(line string, at time.Time) (ProcSample, bool) {
	close := strings.LastIndexByte(line, ')')
	if close < 0 {
		return ProcSample{}, false
	}
	// Fields after comm, so f[0] is field 3 (state) and field N is f[N-3].
	f := strings.Fields(line[close+1:])
	const (
		utime = 14 - 3
		stime = 15 - 3
		rss   = 24 - 3
	)
	if len(f) <= rss {
		return ProcSample{}, false
	}
	ut, err1 := strconv.ParseInt(f[utime], 10, 64)
	st, err2 := strconv.ParseInt(f[stime], 10, 64)
	pages, err3 := strconv.ParseInt(f[rss], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return ProcSample{}, false
	}
	return ProcSample{
		RSSBytes: pages * int64(os.Getpagesize()),
		CPUSec:   float64(ut+st) / userHZ,
		At:       at,
	}, true
}
