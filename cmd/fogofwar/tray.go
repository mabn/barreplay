package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"image/png"
	"math"

	"github.com/tc-hib/winres"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// FogOfWar lives in the notification area ("tray"): minimising the window
// hides it and its taskbar button, the tray icon brings it back, and closing
// asks first. Auto-replay is meant to run for hours out of the way, and a
// window that has to sit in the taskbar the whole time, one click from being
// closed, is in the way.
//
// The icon itself is platform code (tray_windows.go); everything here only
// moves the window. When the icon never came up, nothing is ever hidden: a
// hidden window with no icon to bring it back would leave the app running
// with no way to reach it.

// HideToTray is the page's minimise button.
func (a *App) HideToTray() {
	if !trayUp() {
		wruntime.WindowMinimise(a.ctx)
		return
	}
	a.mu.Lock()
	a.hidden = true
	a.mu.Unlock()
	wruntime.WindowHide(a.ctx)
}

// showWindow brings the window back from the tray (or from minimised).
func (a *App) showWindow() {
	a.mu.Lock()
	a.hidden = false
	a.mu.Unlock()
	wruntime.WindowShow(a.ctx)
	wruntime.WindowUnminimise(a.ctx)
}

// askQuit is the tray menu's Quit: the window comes back and the page asks,
// with the same question as its close button.
func (a *App) askQuit() {
	a.showWindow()
	wruntime.EventsEmit(a.ctx, "askQuit")
}

// trayTick runs with the pump. A window minimised some other way than the
// page's button (its taskbar button, Win+Down) goes to the tray too.
func (a *App) trayTick() {
	if !trayUp() {
		return
	}
	a.mu.Lock()
	hidden := a.hidden
	a.mu.Unlock()
	if !hidden && wruntime.WindowIsMinimised(a.ctx) {
		a.HideToTray()
	}
}

// trayTooltip is what pointing at the icon says.
func trayTooltip(mode string, job *JobView) string {
	switch mode {
	case modeSetup:
		return "FogOfWar: setting up"
	case modeRunning:
		if job != nil && job.Percent > 0 {
			return fmt.Sprintf("FogOfWar: re-simulating, %d%%", int(math.Floor(job.Percent)))
		}
		return "FogOfWar: re-simulating"
	}
	return "FogOfWar"
}

// quitQuestion is what closing asks.
func quitQuestion(running bool) (title, text string) {
	if running {
		return "Stop the re-simulation?", "Closing FogOfWar stops the game being re-simulated, and its replay will not be saved. Minimise it instead to keep it running in the tray."
	}
	return "Close FogOfWar?", "FogOfWar stops re-simulating games while it is closed. Minimise it instead to keep it running in the tray."
}

//go:embed winres/icon.png
var iconPNG []byte

// trayIcon is the app's icon as a small .ico, the one format the tray loads.
func trayIcon() ([]byte, error) {
	img, err := png.Decode(bytes.NewReader(iconPNG))
	if err != nil {
		return nil, err
	}
	ico, err := winres.NewIconFromResizedImage(img, []int{48, 32, 24, 20, 16})
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	if err := ico.SaveICO(&b); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}
