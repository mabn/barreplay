package engine

import (
	"fmt"
	"os"
	"path/filepath"
)

// BAR's widget handler (luaui/barwidgets.lua) only auto-runs a user widget whose
// name is already present in its saved order list. A fresh drop-in with
// enabled=true in GetInfo is scanned from the write-dir but left disabled: in a
// replay the auto-enable clause (`self.allowUserWidgets and not allowuserwidgets`)
// is false because replays force allowuserwidgets=true. So we seed one order-list
// entry that enables our widget, then restore the user's original config afterward.
const (
	// widgetName must match GetInfo().name in assets/lua/snapshot_widget.lua.
	widgetName = "BAR Replay Snapshotter"
	// barGameShortName is BAR's Game.gameShortName; it names the widget config file.
	barGameShortName = "BYAR"
)

// EnableWidget writes a LuaUI widget-config that force-enables the snapshot widget,
// backing up and restoring any existing config so the user's real widget layout is
// preserved. It returns a restore function the caller must run (defer) after the
// engine exits. The config lives in the write-dir under LuaUI/Config/<shortname>.lua.
func (e *Engine) EnableWidget() (func() error, error) {
	cfg := filepath.Join(e.cfg.DataDir, "LuaUI", "Config", barGameShortName+".lua")
	bak := cfg + ".barreplay-bak"
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		return nil, err
	}

	// Self-heal: a leftover backup means a previous run was interrupted before it
	// could restore. That backup is the real user config — put it back first.
	if _, err := os.Stat(bak); err == nil {
		if b, rerr := os.ReadFile(bak); rerr == nil {
			_ = os.WriteFile(cfg, b, 0o644)
		}
		_ = os.Remove(bak)
	}

	existed := false
	if b, err := os.ReadFile(cfg); err == nil {
		existed = true
		if werr := os.WriteFile(bak, b, 0o644); werr != nil {
			return nil, werr
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	if err := os.WriteFile(cfg, []byte(widgetConfigLua(widgetName)), 0o644); err != nil {
		return nil, err
	}

	restore := func() error {
		defer os.Remove(bak)
		if !existed {
			return ignoreNotExist(os.Remove(cfg))
		}
		b, err := os.ReadFile(bak)
		if err != nil {
			return err
		}
		return os.WriteFile(cfg, b, 0o644)
	}
	return restore, nil
}

// widgetConfigLua renders the minimal widget-config that enables name. BAR's
// LoadConfigData loads it with loadfile and reads chunk().order, so the file just
// has to return a table with a positive order entry for the widget.
func widgetConfigLua(name string) string {
	return fmt.Sprintf(`-- Written by barreplay to force-enable its read-only snapshot widget for a
-- headless replay. BAR only auto-runs user widgets already present in this order
-- list, so enabled=true in the widget's GetInfo is not enough on its own. The
-- original config (if any) is restored after the run.
return {
	order = { [%q] = 1 },
	data = {},
	allowUserWidgets = true,
}
`, name)
}

func ignoreNotExist(err error) error {
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
