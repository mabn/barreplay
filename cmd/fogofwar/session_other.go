//go:build !windows

package main

import "time"

// bootTime is when the OS started; unknown off Windows.
func bootTime() time.Time { return time.Time{} }

// watchEndSession is Windows-only: elsewhere nothing announces a shutdown.
func (a *App) watchEndSession() {}
