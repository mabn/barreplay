package main

import (
	"fmt"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// cpuInfo reads the CPU's name from the registry and counts its physical
// cores with GetLogicalProcessorInformationEx. Neither needs admin rights.
func cpuInfo() (model string, cores int) {
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`HARDWARE\DESCRIPTION\System\CentralProcessor\0`, registry.QUERY_VALUE); err == nil {
		model, _, _ = k.GetStringValue("ProcessorNameString")
		k.Close()
	}
	return trimSpaces(model), physicalCores()
}

var procGetLogicalProcessorInformationEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetLogicalProcessorInformationEx")

// physicalCores counts the RelationProcessorCore records the system reports;
// 0 when it cannot be asked.
func physicalCores() int {
	const relationProcessorCore = 0
	var size uint32
	procGetLogicalProcessorInformationEx.Call(relationProcessorCore, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return 0
	}
	buf := make([]byte, size)
	r, _, _ := procGetLogicalProcessorInformationEx.Call(relationProcessorCore,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r == 0 {
		return 0
	}
	// Variable-size records, each starting with Relationship and Size (u32).
	n := 0
	for off := uint32(0); off+8 <= size; {
		rec := *(*uint32)(unsafe.Pointer(&buf[off+4]))
		if rec == 0 {
			break
		}
		if *(*uint32)(unsafe.Pointer(&buf[off])) == relationProcessorCore {
			n++
		}
		off += rec
	}
	return n
}

// osInfo names Windows as Settings does ("Windows 11 Pro 23H2") and its full
// build ("10.0.22631.4317"). ProductName still says "Windows 10" on Windows
// 11, so the build number decides which.
func osInfo() (name, build string) {
	v := windows.RtlGetVersion()
	build = fmt.Sprintf("%d.%d.%d", v.MajorVersion, v.MinorVersion, v.BuildNumber)
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		return "Windows", build
	}
	defer k.Close()
	product, _, _ := k.GetStringValue("ProductName")
	display, _, _ := k.GetStringValue("DisplayVersion")
	if ubr, _, err := k.GetIntegerValue("UBR"); err == nil {
		build += "." + strconv.FormatUint(ubr, 10)
	}
	if product == "" {
		product = "Windows"
	}
	if v.BuildNumber >= 22000 && len(product) >= 10 && product[:10] == "Windows 10" {
		product = "Windows 11" + product[10:]
	}
	if display != "" {
		product += " " + display
	}
	return product, build
}

// diskFree is the space free to this user on dir's drive; 0 if unknown.
func diskFree(dir string) int64 {
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return 0
	}
	var free, total, all uint64
	if windows.GetDiskFreeSpaceEx(p, &free, &total, &all) != nil {
		return 0
	}
	return int64(free)
}
