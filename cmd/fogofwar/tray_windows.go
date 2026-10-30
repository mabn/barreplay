package main

import (
	"runtime"
	"sync/atomic"

	"github.com/energye/systray"
)

var trayReady atomic.Bool

func trayUp() bool { return trayReady.Load() }

// startTray puts the icon in the notification area. It runs its own message
// loop on a thread of its own, which is how a second window procedure lives
// beside Wails' without touching it.
func (a *App) startTray() {
	ico, err := trayIcon()
	if err != nil {
		a.logf("tray icon: %v", err)
		return
	}
	go func() {
		runtime.LockOSThread()
		systray.Run(func() {
			systray.SetIcon(ico)
			systray.SetTooltip("FogOfWar")
			systray.SetOnClick(func(systray.IMenu) { a.showWindow() })
			systray.SetOnDClick(func(systray.IMenu) { a.showWindow() })
			systray.AddMenuItem("Open FogOfWar", "").Click(a.showWindow)
			systray.AddSeparator()
			systray.AddMenuItem("Quit", "").Click(a.askQuit)
			trayReady.Store(true)
		}, nil)
	}()
}

func setTrayTooltip(s string) {
	if trayUp() {
		systray.SetTooltip(s)
	}
}

// stopTray takes the icon away; left behind it lingers until the mouse
// passes over it.
func stopTray() {
	if trayReady.Swap(false) {
		systray.Quit()
	}
}
