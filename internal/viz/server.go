package viz

import (
	"embed"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed web/index.html web/app.js web/style.css
var webFS embed.FS

// Server serves the browser viewer over a directory of .brp captures. It is the
// local counterpart of the worker/ Cloudflare host and runs the SAME viewer
// (web/app.js): the browser reads each .brp directly with HTTP Range requests.
// The server only lists the directory, streams the .brp files (with Range), and
// serves the vendored icons + icon table. It never decodes a frame.
type Server struct {
	// Dir is the directory scanned for .brp captures.
	Dir string
}

// replayInfo is one entry in the /index.json listing. File is the gameId (the
// picker key); the browser fetches /replays/<file>.brp.
type replayInfo struct {
	File   string `json:"file"`
	GameID string `json:"gameId"`
	Size   int64  `json:"size"`
}

// Handler returns the HTTP handler for the viewer.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	serveAsset := func(name, ctype string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			b, err := webFS.ReadFile("web/" + name)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			// The UI changes between builds; never serve a stale cached copy.
			w.Header().Set("Cache-Control", "no-store, must-revalidate")
			w.Header().Set("Content-Type", ctype)
			w.Write(b)
		}
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		serveAsset("index.html", "text/html; charset=utf-8")(w, r)
	})
	mux.HandleFunc("/app.js", serveAsset("app.js", "text/javascript; charset=utf-8"))
	mux.HandleFunc("/style.css", serveAsset("style.css", "text/css; charset=utf-8"))
	// The browser auto-requests a favicon; answer it so it isn't a 404 in logs.
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	// Vendored BAR unit icons, served at /icons/<file> to match the "icons/..."
	// paths in the icon table. Immutable, so let the browser cache them.
	if sub, err := iconsSubFS(); err == nil {
		mux.Handle("/icons/", http.StripPrefix("/icons/", cacheForever(http.FileServer(http.FS(sub)))))
	}
	// Vendored BAR player rank icons, served at /ranks/<n>.png (also immutable).
	if sub, err := ranksSubFS(); err == nil {
		mux.Handle("/ranks/", http.StripPrefix("/ranks/", cacheForever(http.FileServer(http.FS(sub)))))
	}
	// The icon table the browser uses to resolve unit icons when building the head.
	mux.HandleFunc("/icontypes.json", s.handleIconTypes)
	// The replay listing and the captures themselves.
	mux.HandleFunc("/index.json", s.handleIndex)
	mux.HandleFunc("/replays/", s.handleReplay)
	return mux
}

// handleIconTypes serves the unit-icon table (name -> {p,s}); same data the
// worker ships as a static asset.
func (s *Server) handleIconTypes(w http.ResponseWriter, r *http.Request) {
	b, err := IconTableJSON()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

// handleIndex lists the .brp captures in Dir (one entry per file); the browser
// turns each into a picker option and fetches /replays/<file>.brp.
func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	infos := []replayInfo{}
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".brp") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		var size int64
		if fi, err := e.Info(); err == nil {
			size = fi.Size()
		}
		infos = append(infos, replayInfo{File: id, GameID: id, Size: size})
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].File < infos[j].File })
	w.Header().Set("Cache-Control", "no-store, must-revalidate")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(infos)
}

// handleReplay streams /replays/<id>.brp out of Dir with Range support (via
// http.ServeContent, which also handles conditional requests and HEAD). The
// browser Range-reads the meta block and each chunk out of this one file.
func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/replays/")
	if !validName(name) {
		http.Error(w, "invalid replay name (want a .brp basename)", http.StatusBadRequest)
		return
	}
	f, err := os.Open(filepath.Join(s.Dir, name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, name, fi.ModTime(), f)
}

// validName confines a replay name to a bare .brp basename inside Dir.
func validName(name string) bool {
	return name != "" && name == filepath.Base(name) &&
		!strings.Contains(name, string(filepath.Separator)) &&
		strings.EqualFold(filepath.Ext(name), ".brp")
}

// cacheForever wraps a handler with a long-lived immutable cache header, for the
// embedded icon assets (they never change for a given binary).
func cacheForever(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
		h.ServeHTTP(w, r)
	})
}
