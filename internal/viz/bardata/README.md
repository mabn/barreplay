# Vendored Beyond All Reason assets

These files are game content from **Beyond All Reason** (BAR), vendored here so
`barreplay-viz` can render real unit icons instead of plain dots. They are not
part of the barreplay capture format or pipeline — only the viewer uses them.

- `icons/` — minimap unit-icon PNGs (including the `inverted/` scavenger set).
- `icontypes.lua` — BAR's gamedata table mapping each unit's internal name to
  its icon bitmap. `internal/viz/icons.go` parses the data table directly (no Lua
  VM) into a name→bitmap map.

Source: https://github.com/beyond-all-reason/Beyond-All-Reason (also mirrored in
https://github.com/mabn/claudebar under `optimizer/Beyond-All-Reason`). BAR
content is distributed under its own licenses; see the upstream repository.
