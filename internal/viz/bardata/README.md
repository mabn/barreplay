# Vendored Beyond All Reason assets

These files are game content from **Beyond All Reason** (BAR), vendored here so
`barreplay-viz` can render real unit icons instead of plain dots. They are not
part of the barreplay capture format or pipeline — only the viewer uses them.

- `icons/` — minimap unit-icon PNGs (including the `inverted/` scavenger set).
- `icontypes.lua` — BAR's gamedata table mapping each unit's internal name to
  its icon bitmap. `internal/viz/icons.go` parses the data table directly (no Lua
  VM) into a name→bitmap map.
- `ranks/` — player rank badge PNGs (`1.png`..`8.png`) shown in the sidebar
  player list. These are the chevron/star icons from BAR's in-game player-list
  widget (`luaui/images/advplayerslist/ranks/`); rank levels 0..7 map to files
  1..8 exactly as the widget's `rankPics` table does.

Source: https://github.com/beyond-all-reason/Beyond-All-Reason (also mirrored in
https://github.com/mabn/claudebar under `optimizer/Beyond-All-Reason`). BAR
content is distributed under its own licenses; see the upstream repository.
