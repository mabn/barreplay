// Package assets embeds static files shipped with the tool (currently the Lua
// capture widget) so the binary is self-contained.
package assets

import _ "embed"

// WidgetLua is the capture widget: the player-installable Replay uploader,
// which the re-simulation injects into the engine's write-dir with its
// re-simulation tokens substituted (see internal/engine WriteWidget). One
// file, so the two capture paths cannot drift apart.
//
//go:embed lua/replay_uploader.lua
var WidgetLua string
