package viz

import (
	"embed"
	"io/fs"
	"regexp"
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

// iconEntry opens a top-level table entry: `name = {` with tolerant spacing
// (the real file has both `name = {` and `legjam ={`).
var iconEntryRe = regexp.MustCompile(`^([A-Za-z0-9_]+)\s*=\s*\{`)

// iconBitmapRe extracts a bitmap path: `bitmap = "icons/foo.png"`.
var iconBitmapRe = regexp.MustCompile(`bitmap\s*=\s*"([^"]+)"`)

var (
	iconOnce   sync.Once
	iconByName map[string]string // unit name -> bitmap path present on disk, e.g. "icons/mex_t1.png"
)

// unitIcon returns the served icon path for a unit's internal name (as recorded
// in Meta.UnitDefs), or "" if there is no icon for it. The path is relative
// ("icons/foo.png") and is served under /icons/ by the server, so the browser
// requests "/" + path.
func unitIcon(name string) string {
	iconOnce.Do(loadIcons)
	return iconByName[name]
}

// loadIcons parses icontypes.lua into a name->bitmap map, keeping only entries
// whose bitmap file actually exists in the embedded FS (so the payload never
// advertises a 404). The trailing Lua loop in the file synthesises "<name>_scav"
// variants pointing at icons/inverted/<foo>.png; we replicate that here rather
// than evaluating Lua, keeping the tool stdlib-only.
func loadIcons() {
	iconByName = map[string]string{}
	exists := func(bitmap string) bool {
		if bitmap == "" {
			return false
		}
		_, err := fs.Stat(iconsFS, "bardata/"+bitmap)
		return err == nil
	}

	base := map[string]string{}
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
			if m := iconBitmapRe.FindStringSubmatch(line); m != nil {
				base[cur] = m[1]
			}
		}
		depth += strings.Count(raw, "{") - strings.Count(raw, "}")
		if depth <= 1 {
			cur = ""
		}
	}

	for name, bitmap := range base {
		if exists(bitmap) {
			iconByName[name] = bitmap
		}
		// Scavenger variant: same bitmap under an inverted/ path.
		scav := strings.Replace(bitmap, "/", "/inverted/", 1)
		if exists(scav) {
			iconByName[name+"_scav"] = scav
		}
	}
}

// iconsSubFS returns the embedded icons directory rooted so files are served as
// /icons/<file> (matching the "icons/..." bitmap paths in the wire payload).
func iconsSubFS() (fs.FS, error) {
	return fs.Sub(iconsFS, "bardata/icons")
}
