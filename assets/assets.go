// Package assets embeds static files shipped with the tool (currently the Lua
// snapshot widget) so the binary is self-contained.
package assets

import _ "embed"

// SnapshotWidgetLua is the source of the Lua widget injected into the engine's
// write-dir before launching a headless replay. The token __SAMPLE_EVERY__ is
// substituted at write time.
//
//go:embed lua/snapshot_widget.lua
var SnapshotWidgetLua string
