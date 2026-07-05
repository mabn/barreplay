package viz

import (
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mabn/barreplay/snapshot"
)

//go:embed web/index.html web/app.js web/style.css
var webFS embed.FS

// Server serves the playback UI and a small API over a directory of .brp
// snapshot files. It supports the .brp v2 format ONLY — convert legacy
// .jsonl/.brsnap captures once with barreplay-pack.
type Server struct {
	// Dir is the directory scanned for .brp snapshot files.
	Dir string

	// mu guards cache: parsed .brp files keyed by basename, so a play session's
	// many chunk requests don't re-read/re-parse the file each time. Entries are
	// invalidated by mtime+size and the cache is kept small (a viewer looks at
	// one or two replays at a time).
	mu    sync.Mutex
	cache map[string]*cacheEntry
}

const cacheMaxEntries = 4

type cacheEntry struct {
	mtime   time.Time
	size    int64
	brp     *snapshot.BRPFile
	payload []byte // the /api/replay head payload, built once
	etag    string
	lastUse time.Time
}

// replayInfo is one entry in the /api/replays listing.
type replayInfo struct {
	File   string `json:"file"`   // basename, used as the ?file= key
	GameID string `json:"gameId"` // filename without extension
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
	// Vendored BAR unit icons, served at /icons/<file> to match the bitmap paths
	// in the wire payload. Icons are immutable, so let the browser cache them.
	if sub, err := iconsSubFS(); err == nil {
		mux.Handle("/icons/", http.StripPrefix("/icons/", cacheForever(http.FileServer(http.FS(sub)))))
	}
	mux.HandleFunc("/api/replays", s.handleList)
	mux.HandleFunc("/api/replay", s.handleReplay)
	mux.HandleFunc("/api/replay/chunk", s.handleChunk)
	mux.HandleFunc("/api/mapinfo", s.handleMapInfo)
	mux.HandleFunc("/api/maptex", s.handleMapTexture)
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

// get returns the parsed .brp for a validated basename, from cache when the
// file hasn't changed.
func (s *Server) get(name string) (*cacheEntry, error) {
	path := filepath.Join(s.Dir, name)
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil {
		s.cache = map[string]*cacheEntry{}
	}
	if e, ok := s.cache[name]; ok && e.mtime.Equal(fi.ModTime()) && e.size == fi.Size() {
		e.lastUse = time.Now()
		return e, nil
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	bf, perr := snapshot.ParseBRP(f)
	f.Close()
	if perr != nil {
		return nil, perr
	}
	payload, err := brpWirePayload(bf)
	if err != nil {
		return nil, err
	}
	e := &cacheEntry{
		mtime:   fi.ModTime(),
		size:    fi.Size(),
		brp:     bf,
		payload: payload,
		etag:    fmt.Sprintf(`"%x-%x"`, fi.Size(), fi.ModTime().UnixNano()),
		lastUse: time.Now(),
	}
	s.cache[name] = e
	for len(s.cache) > cacheMaxEntries {
		oldest, oldestT := "", time.Now().Add(time.Hour)
		for k, v := range s.cache {
			if k != name && v.lastUse.Before(oldestT) {
				oldest, oldestT = k, v.lastUse
			}
		}
		delete(s.cache, oldest)
	}
	return e, nil
}

// validName confines ?file= to a bare .brp basename inside Dir.
func validName(name string) bool {
	return name != "" && name == filepath.Base(name) &&
		!strings.Contains(name, string(filepath.Separator)) &&
		strings.EqualFold(filepath.Ext(name), ".brp")
}

// notModified handles ETag revalidation; chunk data is immutable for a given
// file version, so a match saves the transfer entirely.
func notModified(w http.ResponseWriter, r *http.Request, etag string) bool {
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache") // always revalidate, 304 when unchanged
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	return false
}

// handleReplay returns one capture's head payload (?file=<basename>): the BRW1
// container of head JSON (meta, teams, icons, bounds, chunk index) plus the
// events section — small, so the page is interactive immediately. Frame data
// is fetched per chunk via /api/replay/chunk.
func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("file")
	if !validName(name) {
		http.Error(w, "missing or invalid ?file= (want a .brp basename)", http.StatusBadRequest)
		return
	}
	e, err := s.get(name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if notModified(w, r, e.etag) {
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(e.payload)
}

// handleChunk returns one chunk's bytes (?file=<basename>&i=<n>[&key=1]),
// sliced straight out of the stored file — chunks are independently gzipped
// exactly so this needs no re-encoding. &key=1 returns only the keyframe
// stream (the cheap skim path).
func (s *Server) handleChunk(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("file")
	if !validName(name) {
		http.Error(w, "missing or invalid ?file= (want a .brp basename)", http.StatusBadRequest)
		return
	}
	e, err := s.get(name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	i, err := strconv.Atoi(r.URL.Query().Get("i"))
	if err != nil || i < 0 || i >= len(e.brp.Chunks) {
		http.Error(w, fmt.Sprintf("invalid ?i= (file has %d chunks)", len(e.brp.Chunks)), http.StatusBadRequest)
		return
	}
	c := e.brp.Chunks[i]
	sec := e.brp.Sections[snapshot.SecFrames]
	end := c.FOff + c.FLen
	if r.URL.Query().Get("key") == "1" {
		end = c.FOff + c.FKeyLen
	}
	if c.FOff < 0 || end > int64(len(sec)) {
		http.Error(w, "chunk range outside frames section", http.StatusInternalServerError)
		return
	}
	if notModified(w, r, e.etag) {
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(sec[c.FOff:end])
}

// list scans Dir for .brp files.
func (s *Server) list() ([]replayInfo, error) {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return nil, fmt.Errorf("viz: reading snapshots dir %q: %w", s.Dir, err)
	}
	var infos []replayInfo
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".brp") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		infos = append(infos, replayInfo{
			File:   e.Name(),
			GameID: strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())),
			Size:   info.Size(),
		})
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].File < infos[j].File })
	return infos, nil
}

// cacheForever wraps a handler with a long-lived immutable cache header, for
// the embedded icon assets (they never change for a given binary).
func cacheForever(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Cache-Control", "no-store, must-revalidate")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
