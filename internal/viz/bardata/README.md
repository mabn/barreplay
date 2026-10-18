# Vendored Beyond All Reason assets

These files are game content from **Beyond All Reason** (BAR), vendored here so
the viewer can render real unit icons instead of plain dots. They are not
part of the barreplay capture format or pipeline — only the viewer uses them
(`internal/viz/icons.go` turns `icontypes.lua` into the viewer's icon table,
`icons/icontypes.json`, and `worker/tools/sync-assets.mjs` copies the bitmaps and
that table into the worker's assets).

- `icons/` — minimap unit-icon PNGs (including the `inverted/` scavenger set), plus
  `icontypes.json`, GENERATED from `icontypes.lua` (do not edit by hand: run
  `go test ./internal/viz -run IconTypes -update`; that test fails while it is stale).
- `icontypes.lua` — BAR's gamedata table mapping each unit's internal name to
  its icon bitmap. `internal/viz/icons.go` parses the data table directly (no Lua
  VM) into a name→bitmap map.
- `ranks/` — player rank badge PNGs (`1.png`..`8.png`) shown in the sidebar
  player list. These are the chevron/star icons from BAR's in-game player-list
  widget (`luaui/images/advplayerslist/ranks/`); rank levels 0..7 map to files
  1..8 exactly as the widget's `rankPics` table does.

Source: https://github.com/beyond-all-reason/Beyond-All-Reason (also mirrored in
https://github.com/mabn/claudebar under `optimizer/Beyond-All-Reason`).

## Licences (NOT barreplay's own licence)

These files keep their upstream licences, whatever licence the rest of this
repository carries. As stated by BAR itself (checked 2026-10-18):

- `icons/` — BAR's `license_icons.txt`: "Icons made for Beyond All Reason. By
  IceXuick/Floris/PtaQ, all rights reserved (CC BY NC ND)", i.e. CC BY-NC-ND 4.0.
  That allows sharing them unmodified, non-commercially, with attribution. The
  viewer only tints them at draw time; the files themselves are unmodified.
- `ranks/` — BAR's `luaui/images/license.txt`, subfolder `advplayerlist/ranks`:
  "All textures in this folder were made for Beyond All Reason by IceXuick, all
  rights reserved." No licence grant: using them needs IceXuick's permission.
- `icontypes.lua` — BAR game code, GPL v2 (BAR's `LICENSE.md`: "BAR game code
  is released under the GPL v2 licence").

The viewer credits them in its Credits dialog (worker/index.html
`#creditsdialog`); keep that text in step with this list.
