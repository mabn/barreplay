package viz

import (
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed web/index.html web/app.js web/style.css
var webFS embed.FS

// Server serves the playback UI and a small JSON API over a directory of
// snapshot files.
type Server struct {
	// Dir is the directory scanned for .jsonl/.brsnap snapshot files.
	Dir string
}

// replayInfo is one entry in the /api/replays listing.
type replayInfo struct {
	File   string `json:"file"`   // basename, used as the ?file= key
	GameID string `json:"gameId"` // filename without extension
	Format string `json:"format"` // "jsonl" or "brsnap"
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
	mux.HandleFunc("/api/replays", s.handleList)
	mux.HandleFunc("/api/replay", s.handleReplay)
	return mux
}

// handleList returns the snapshot files available in Dir.
func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	infos, err := s.list()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, infos)
}

// handleReplay loads one snapshot file (?file=<basename>) and returns its wire
// payload. The file is confined to Dir — the basename is taken to avoid path
// traversal.
func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("file")
	if name == "" {
		http.Error(w, "missing ?file=", http.StatusBadRequest)
		return
	}
	// Confine to Dir: reject any path component, only accept a bare filename.
	if name != filepath.Base(name) || strings.Contains(name, string(filepath.Separator)) {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	path := filepath.Join(s.Dir, name)
	rep, err := Load(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, rep.toWire())
}

// list scans Dir for snapshot files, newest first.
func (s *Server) list() ([]replayInfo, error) {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return nil, fmt.Errorf("viz: reading snapshots dir %q: %w", s.Dir, err)
	}
	var infos []replayInfo
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		format := ""
		switch ext {
		case ".jsonl":
			format = "jsonl"
		case ".brsnap":
			format = "brsnap"
		default:
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		infos = append(infos, replayInfo{
			File:   e.Name(),
			GameID: strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())),
			Format: format,
			Size:   info.Size(),
		})
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].File < infos[j].File })
	return infos, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Cache-Control", "no-store, must-revalidate")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
