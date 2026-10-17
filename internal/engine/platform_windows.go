//go:build windows

package engine

import (
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

const (
	createNoWindow           = 0x08000000
	belowNormalPriorityClass = 0x00004000
	processQueryLimitedInfo  = 0x1000
)

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetProcessMemoryInfo = kernel32.NewProc("K32GetProcessMemoryInfo")
)

// hideChild keeps a console child (the engine, pr-downloader, 7z) from
// opening a console window over a GUI program, and runs a long batch job (the
// engine) below normal priority, so a re-sim in the background never makes the
// machine feel slow.
func hideChild(cmd *exec.Cmd, lowPriority bool) {
	flags := uint32(createNoWindow)
	if lowPriority {
		flags |= belowNormalPriorityClass
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
}

// memoryStatusEx is MEMORYSTATUSEX.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func globalMemoryStatus() (memoryStatusEx, bool) {
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m)))
	return m, r != 0
}

// memAvailable is the physical memory Windows can still hand out. Windows has
// no OOM killer — past this it pages until the commit limit and the machine
// stops responding — so the guard matters more here, not less.
func memAvailable() (int64, bool) {
	m, ok := globalMemoryStatus()
	return int64(m.AvailPhys), ok
}

// MemTotal is the machine's physical memory, for showing the user what the
// largest games need against what they have. ok=false when it cannot be read.
func MemTotal() (int64, bool) {
	m, ok := globalMemoryStatus()
	return int64(m.TotalPhys), ok
}

// processMemoryCounters is PROCESS_MEMORY_COUNTERS.
type processMemoryCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

// sampleProcess reads the engine's working set (Windows' RSS) and its CPU
// time. Swap has no per-process equivalent worth reporting and stays zero.
func sampleProcess(pid int) (ProcSample, bool) {
	h, err := syscall.OpenProcess(processQueryLimitedInfo, false, uint32(pid))
	if err != nil {
		return ProcSample{}, false
	}
	defer syscall.CloseHandle(h)
	var c, e, k, u syscall.Filetime
	if err := syscall.GetProcessTimes(h, &c, &e, &k, &u); err != nil {
		return ProcSample{}, false
	}
	var pmc processMemoryCounters
	pmc.CB = uint32(unsafe.Sizeof(pmc))
	r, _, _ := procGetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&pmc)), uintptr(pmc.CB))
	if r == 0 {
		return ProcSample{}, false
	}
	// FILETIME counts 100 ns ticks.
	ticks := func(f syscall.Filetime) float64 {
		return float64(uint64(f.HighDateTime)<<32|uint64(f.LowDateTime)) / 1e7
	}
	return ProcSample{
		RSSBytes: int64(pmc.WorkingSetSize),
		CPUSec:   ticks(k) + ticks(u),
		At:       time.Now(),
	}, true
}
