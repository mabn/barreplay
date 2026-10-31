// FogOfWar re-simulates a Beyond All Reason game on the user's own computer
// and writes the replay as a .brp — the same file the replay site publishes.
//
// It is a Wails app (a Go program whose window is a WebView2 page): the page
// lives in frontend/dist and is embedded; app.go is everything it may call.
// Everything it keeps lives in one folder, by default the exe's own;
// %LOCALAPPDATA%\FogOfWar holds only config.json, naming that folder
// (config.go), so it needs no installer and no admin rights.
package main

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"github.com/mabn/barreplay/internal/engine"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	if err := run(); err != nil {
		fatal(err)
	}
}

func run() error {
	root, err := appRoot()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	// The engine and pr-downloader must not outlive the window, even when it
	// is killed rather than closed.
	killChildrenWithUs()

	// The log lives in the FogOfWar folder, which config.json names, so the
	// config is read before anything can be logged; what it has to say waits.
	cfg, old, prev, cerr := loadConfig(root, defaultHome(root))
	var notes []string
	if err := os.MkdirAll(cfg.Home, 0o755); err != nil {
		// A folder on a drive that is gone: keep the app usable beside
		// config.json until the folder is back or changed.
		notes = append(notes, fmt.Sprintf("FogOfWar folder %s unavailable (%v); using %s", cfg.Home, err, root))
		cfg.setHome(root)
		old = nil
	}
	dataMoved := true
	if old != nil {
		var n []string
		n, dataMoved = relocate(cfg.Home, *old, cfg.History)
		notes = append(notes, n...)
	}
	if prev != "" && !samePath(prev, cfg.Home) {
		// Moved while running last time: what was held open then goes now.
		tidyOldAppDir(prev, true)
	}
	home := cfg.Home

	var app *App
	log, err := startLogTee(filepath.Join(home, "fogofwar.log"), func(line string) {
		if app != nil {
			app.onLogLine(line)
		}
	})
	if err != nil {
		return err
	}
	// A panic or fatal error is written by the runtime straight to the
	// process's own stderr, which a windowed program does not have, so a crash
	// left the log ending mid-sentence with no reason. Send it to the log.
	log.crashToLog()
	fresh := cfg.InstallID == ""
	if fresh {
		cfg.InstallID = newInstallID()
	}
	app = NewApp(root, cfg, log)
	app.setHome(home)
	for _, n := range notes {
		app.logf("%s", n)
	}
	if cerr != nil {
		app.logf("the config could not be read (%v); using defaults", cerr)
	}
	if old != nil && !dataMoved {
		cfg.Setup = SetupRecord{}
		app.cfg.Setup = SetupRecord{}
	}
	if (fresh || old != nil || prev != "") && cerr == nil {
		if err := saveConfig(root, app.config()); err != nil {
			app.logf("save config: %v", err)
		} else if old != nil {
			app.logf("everything now lives in %s", cfg.Home)
			for _, d := range old.appDirs {
				if !samePath(d, cfg.Home) {
					tidyOldAppDir(d, true)
				}
			}
			tidyOldAppDir(filepath.Join(cfg.Home, "data", "fogofwar"), true)
			os.RemoveAll(filepath.Join(root, "work"))
		}
	}
	app.logf("FogOfWar %s, folder %s, data %s, install %s", version, cfg.Home, cfg.DataDir, cfg.InstallID)

	// The engine download is a 7z, which Windows cannot open by itself.
	engine.Extract7z = extract7z
	engine.DownloadProgress = app.onDownload

	return wails.Run(&options.App{
		Title:            "FogOfWar",
		Width:            1080,
		Height:           740,
		MinWidth:         820,
		MinHeight:        600,
		Frameless:        true,
		BackgroundColour: &options.RGBA{R: 0x17, G: 0x0d, B: 0x10, A: 255},
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnBeforeClose:    app.beforeClose,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "fogofwar.dev.resim",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) {
				if app.ctx != nil {
					app.showWindow()
				}
			},
		},
		Windows: &windows.Options{
			Theme:               windows.Dark,
			WebviewUserDataPath: filepath.Join(home, "webview"),
			DisablePinchZoom:    true,
			// A gap in the log is often the PC asleep; say so.
			OnSuspend: func() { app.logf("Windows is going to sleep") },
			OnResume:  func() { app.logf("Windows woke up") },
		},
	})
}
