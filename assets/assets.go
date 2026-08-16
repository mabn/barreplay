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

// ReplayUploaderLua is the player-installable live-game widget. Nothing in the
// pipeline injects it (players drop it into their own LuaUI/Widgets), but the
// viz server offers it for download from its /setup guide — the same file the
// Cloudflare worker emits, so both hosts hand out identical bytes.
//
//go:embed lua/replay_uploader.lua
var ReplayUploaderLua string
