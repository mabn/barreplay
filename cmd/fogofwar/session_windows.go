package main

import (
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32               = windows.NewLazySystemDLL("user32.dll")
	procRegisterClassExW = user32.NewProc("RegisterClassExW")
	procCreateWindowExW  = user32.NewProc("CreateWindowExW")
	procDefWindowProcW   = user32.NewProc("DefWindowProcW")
	procGetMessageW      = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessageW = user32.NewProc("DispatchMessageW")
	procGetTickCount64   = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetTickCount64")
)

// bootTime is when Windows started: now less the milliseconds since boot.
func bootTime() time.Time {
	ms, _, _ := procGetTickCount64.Call()
	if ms == 0 {
		return time.Time{}
	}
	return time.Now().Add(-time.Duration(ms) * time.Millisecond).Truncate(time.Second)
}

const (
	wmQueryEndSession = 0x0011
	wmEndSession      = 0x0016

	endSessionCloseApp = 0x00000001 // the app is being closed to update or restart it
	endSessionCritical = 0x40000000 // forced: the app cannot refuse
	endSessionLogoff   = 0x80000000 // the user signs out
)

type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   windows.Handle
	icon       windows.Handle
	cursor     windows.Handle
	background windows.Handle
	menuName   *uint16
	className  *uint16
	iconSm     windows.Handle
}

type winMsg struct {
	hwnd    windows.HWND
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
}

// endSessionReason says why Windows is ending the session, from the
// WM_QUERYENDSESSION/WM_ENDSESSION flags.
func endSessionReason(lParam uintptr) string {
	var s string
	switch {
	case lParam&endSessionLogoff != 0:
		s = "Windows signed the user out"
	case lParam&endSessionCloseApp != 0:
		s = "Windows closed the app (an update or restart that needed it closed)"
	default:
		s = "Windows shut down or restarted"
	}
	if lParam&endSessionCritical != 0 {
		s += ", forced"
	}
	return s
}

// watchEndSession logs and records a Windows shutdown, restart or sign-out.
// Windows tells every top-level window before it ends the session and then
// terminates the process, so neither Wails's close hooks nor the deferred
// writes ever run; a hidden window of our own hears it. It is a top-level
// window, not a message-only one, because those get no broadcasts.
func (a *App) watchEndSession() {
	go func() {
		runtime.LockOSThread()
		proc := syscall.NewCallback(func(hwnd windows.HWND, msg uint32, wParam, lParam uintptr) uintptr {
			switch msg {
			case wmQueryEndSession:
				a.logf("%s; closing", endSessionReason(lParam))
				return 1 // never hold up the shutdown
			case wmEndSession:
				if wParam != 0 {
					a.endSession(endSessionReason(lParam))
				} else {
					a.logf("Windows cancelled the shutdown")
				}
				return 0
			}
			r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
			return r
		})
		name, _ := windows.UTF16PtrFromString("FogOfWarSessionWatch")
		var inst windows.Handle
		windows.GetModuleHandleEx(0, nil, &inst)
		wc := wndClassEx{wndProc: proc, instance: inst, className: name}
		wc.size = uint32(unsafe.Sizeof(wc))
		if r, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
			a.logf("could not watch for Windows shutting down: %v", err)
			return
		}
		hwnd, _, err := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(name)),
			0, 0, 0, 0, 0, 0, 0, uintptr(inst), 0)
		if hwnd == 0 {
			a.logf("could not watch for Windows shutting down: %v", err)
			return
		}
		var m winMsg
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(r) <= 0 {
				return
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
	}()
}
