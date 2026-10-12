// Package assets embeds static files shipped with the tool (currently the Lua
// capture widget) so the binary is self-contained.
package assets

import (
	_ "embed"
	"regexp"
)

// WidgetLua is the capture widget: the player-installable Replay uploader,
// which the re-simulation injects into the engine's write-dir with its
// re-simulation tokens substituted (see internal/engine WriteWidget). One
// file, so the two capture paths cannot drift apart.
//
//go:embed lua/replay_uploader.lua
var WidgetLua string

// widgetVersionRE finds the widget's version constant. The widget declares it
// once, as a plain string literal, and every capture it writes reports it.
var widgetVersionRE = regexp.MustCompile(`(?m)^local widgetVersion = "([^"]+)"`)

// WidgetVersion is the version of the EMBEDDED widget — the one a
// re-simulation run by this binary injects. A re-sim capture records no widget
// build of its own (only the uploader mode does), so this is the only place
// that fact can come from. Empty if the constant cannot be found.
func WidgetVersion() string {
	if m := widgetVersionRE.FindStringSubmatch(WidgetLua); m != nil {
		return m[1]
	}
	return ""
}
