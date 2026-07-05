package viz

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// mapAPIBase is the Beyond All Reason maps API. The viz server fetches a map's
// diffuse texture and dimensions from here on demand (by map name) so the viewer
// can draw the real terrain behind the units. Overridable in tests.
var mapAPIBase = "https://api.bar-rts.com"

// mapElmosPerUnit converts the API's map width/height (in map units) to world
// elmos: a Spring/Recoil map unit is 512 elmos.
const mapElmosPerUnit = 512

// barMapMeta is the subset of the API's /maps/<name> response we use.
type barMapMeta struct {
	FileName string `json:"fileName"`
	Width    int    `json:"width"`  // map units
	Height   int    `json:"height"` // map units
}

// mapInfo is what /api/mapinfo returns to the browser: the world extent in elmos
// and whether a texture is available to draw.
type mapInfo struct {
	Name    string `json:"name"`
	Width   int    `json:"width"`  // elmos (0 if unknown)
	Height  int    `json:"height"` // elmos
	Texture bool   `json:"texture"`
}

// mapEntry is a cached fetch for one map.
type mapEntry struct {
	info    mapInfo
	texture []byte // JPEG bytes, nil if none/unavailable
}

var (
	mapMu    sync.Mutex
	mapCache = map[string]*mapEntry{} // key: normalized map file name
)

// normalizeMapName turns a demo's display map name ("Supreme Isthmus v2.1") into
// the API's file-name form ("supreme_isthmus_v2.1").
func normalizeMapName(display string) string {
	s := strings.ToLower(strings.TrimSpace(display))
	return strings.ReplaceAll(s, " ", "_")
}

// mapForName fetches (and caches) the map's metadata + texture from the BAR API.
// It is best-effort: on any failure the returned entry simply has no texture
// and/or zero dimensions, and the viewer falls back to a plain background.
func mapForName(display string) *mapEntry {
	key := normalizeMapName(display)
	if key == "" {
		return &mapEntry{}
	}
	mapMu.Lock()
	if e := mapCache[key]; e != nil {
		mapMu.Unlock()
		return e
	}
	mapMu.Unlock()

	e := &mapEntry{info: mapInfo{Name: display}}
	client := &http.Client{Timeout: 25 * time.Second}
	base := mapAPIBase + "/maps/" + url.PathEscape(key)

	if resp, err := client.Get(base); err == nil {
		if resp.StatusCode == http.StatusOK {
			var m barMapMeta
			if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&m) == nil {
				e.info.Width = m.Width * mapElmosPerUnit
				e.info.Height = m.Height * mapElmosPerUnit
			}
		}
		resp.Body.Close()
	}

	if resp, err := client.Get(base + "/texture-mq.jpg"); err == nil {
		if resp.StatusCode == http.StatusOK {
			if b, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20)); err == nil && len(b) > 0 {
				e.texture = b
			}
		}
		resp.Body.Close()
	}
	e.info.Texture = e.texture != nil

	mapMu.Lock()
	mapCache[key] = e
	mapMu.Unlock()
	return e
}

// handleMapInfo returns the world extent + texture availability for ?map=<name>.
func (s *Server) handleMapInfo(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("map")
	if name == "" {
		writeJSON(w, mapInfo{})
		return
	}
	writeJSON(w, mapForName(name).info)
}

// handleMapTexture serves the cached JPEG texture for ?map=<name>, or 404.
func (s *Server) handleMapTexture(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("map")
	if name == "" {
		http.NotFound(w, r)
		return
	}
	e := mapForName(name)
	if e.texture == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	w.Write(e.texture)
}
