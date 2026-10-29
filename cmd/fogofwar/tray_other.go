//go:build !windows

package main

// Elsewhere (a development build) there is no tray, so the window minimises
// as usual.

func trayUp() bool          { return false }
func (a *App) startTray()   {}
func setTrayTooltip(string) {}
func stopTray()             {}
