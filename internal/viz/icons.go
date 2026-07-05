package viz

import (
	"embed"
	"io/fs"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// bardata holds vendored Beyond All Reason assets used only to render nicer
// unit markers: the icon PNGs and icontypes.lua (BAR's gamedata table mapping a
// unit's internal name to its minimap-icon bitmap). See bardata/README.md for
// provenance. These are game content, not part of the capture format.
//
//go:embed bardata/icons
var iconsFS embed.FS

//go:embed bardata/icontypes.lua
var iconTypesLua string

// ranksFS holds BAR's player rank icons (the chevron/star badges shown left of a
// player's name in the in-game player list). Files are named 1.png..8.png for
// rank levels 0..7. Served at /ranks/<n>.png.
//
//go:embed bardata/ranks
var ranksFS embed.FS

// iconEntry opens a top-level table entry: `name = {` with tolerant spacing
// (the real file has both `name = {` and `legjam ={`).
var iconEntryRe = regexp.MustCompile(`^([A-Za-z0-9_]+)\s*=\s*\{`)

// iconBitmapRe extracts a bitmap path: `bitmap = "icons/foo.png"`.
var iconBitmapRe = regexp.MustCompile(`bitmap\s*=\s*"([^"]+)"`)

// iconSizeRe extracts the icon size multiplier: `size = 1.05`.
var iconSizeRe = regexp.MustCompile(`size\s*=\s*([0-9.]+)`)

// iconInfo is one unit type's icon: the served bitmap path and BAR's per-type
// size multiplier (relative icon scale; ~0.8 for a mex, ~1.8 for a commander).
type iconInfo struct {
	Path string
	Size float64
}

var (
	iconOnce   sync.Once
	iconByName map[string]iconInfo // icontype key -> icon path (present on disk) + size
)

// unitIcon returns the icon path and size multiplier for an icontype key (the
// top-level keys of icontypes.lua — usually, but not always, a unit's own name).
// ok is false if there is no icon for it. The path is relative ("icons/foo.png")
// and is served under /icons/, so the browser requests "/" + path. Size defaults
// to 1 when the entry omits it.
func unitIcon(key string) (path string, size float64, ok bool) {
	iconOnce.Do(loadIcons)
	ic, ok := iconByName[key]
	return ic.Path, ic.Size, ok
}

// unitIconFor resolves a unit's icon by its icontype key first (the authoritative
// icontypes.lua key the engine uses to pick the icon), falling back to its
// internal name. The name fallback covers captures with no IconType and units
// whose name is itself an icontype key (incl. the synthesised "<name>_scav"
// variants). ok is false if neither resolves to an icon present on disk.
func unitIconFor(iconType, name string) (path string, size float64, ok bool) {
	if iconType != "" {
		if path, size, ok = unitIcon(iconType); ok {
			return path, size, true
		}
	}
	return unitIcon(name)
}

// loadIcons parses icontypes.lua into a name->{bitmap,size} map, keeping only
// entries whose bitmap file actually exists in the embedded FS (so the payload
// never advertises a 404). The trailing Lua loop in the file synthesises
// "<name>_scav" variants pointing at icons/inverted/<foo>.png; we replicate that
// here rather than evaluating Lua, keeping the tool stdlib-only.
func loadIcons() {
	iconByName = map[string]iconInfo{}
	exists := func(bitmap string) bool {
		if bitmap == "" {
			return false
		}
		_, err := fs.Stat(iconsFS, "bardata/"+bitmap)
		return err == nil
	}

	base := map[string]iconInfo{}
	var cur string
	depth := 0
	for _, raw := range strings.Split(iconTypesLua, "\n") {
		// The name-synthesis loop at the end of the file is code, not data.
		if strings.Contains(raw, "local newIcontypes") {
			break
		}
		line := strings.TrimSpace(raw)
		if depth == 1 {
			if m := iconEntryRe.FindStringSubmatch(line); m != nil {
				cur = m[1]
			}
		} else if depth == 2 && cur != "" {
			ic := base[cur]
			if m := iconBitmapRe.FindStringSubmatch(line); m != nil {
				ic.Path = m[1]
			}
			if m := iconSizeRe.FindStringSubmatch(line); m != nil {
				if s, err := strconv.ParseFloat(m[1], 64); err == nil {
					ic.Size = s
				}
			}
			base[cur] = ic
		}
		depth += strings.Count(raw, "{") - strings.Count(raw, "}")
		if depth <= 1 {
			cur = ""
		}
	}

	norm := func(size float64) float64 {
		if size <= 0 {
			return 1
		}
		return size
	}
	for name, ic := range base {
		if exists(ic.Path) {
			iconByName[name] = iconInfo{Path: ic.Path, Size: norm(ic.Size)}
		}
		// Scavenger variant: same bitmap under an inverted/ path, same size.
		scav := strings.Replace(ic.Path, "/", "/inverted/", 1)
		if exists(scav) {
			iconByName[name+"_scav"] = iconInfo{Path: scav, Size: norm(ic.Size)}
		}
	}
}

// iconsSubFS returns the embedded icons directory rooted so files are served as
// /icons/<file> (matching the "icons/..." bitmap paths in the wire payload).
func iconsSubFS() (fs.FS, error) {
	return fs.Sub(iconsFS, "bardata/icons")
}

// ranksSubFS returns the embedded rank-icon directory rooted so files are served
// as /ranks/<n>.png.
func ranksSubFS() (fs.FS, error) {
	return fs.Sub(ranksFS, "bardata/ranks")
}
