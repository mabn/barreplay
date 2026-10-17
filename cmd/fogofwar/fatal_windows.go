package main

import (
	"syscall"
	"unsafe"
)

// fatal reports a startup failure in a message box: a windowed program has no
// console to print it to.
func fatal(err error) {
	user32 := syscall.NewLazyDLL("user32.dll")
	title, _ := syscall.UTF16PtrFromString("FogOfWar")
	msg, _ := syscall.UTF16PtrFromString("FogOfWar could not start:\n\n" + err.Error())
	const mbIconError = 0x10
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(msg)), uintptr(unsafe.Pointer(title)), mbIconError)
	syscall.Exit(1)
}
