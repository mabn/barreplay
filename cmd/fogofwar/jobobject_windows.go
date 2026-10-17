package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// killChildrenWithUs puts this process in a job object that kills everything
// in it when the last handle closes — which happens when this process exits,
// however it exits. Children inherit the job, so a closed, crashed or
// task-manager-killed FogOfWar takes its engine with it instead of leaving a
// headless engine burning a core for the next hour.
func killChildrenWithUs() {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return
	}
	// The handle is deliberately never closed: closing it is the kill.
	_ = windows.AssignProcessToJobObject(job, windows.CurrentProcess())
}
