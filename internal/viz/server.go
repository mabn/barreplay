package viz

import (
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
	webassets "github.com/mabn/barreplay/worker"
)

// Server serves the playback UI and the replay data over a directory of .brp
// snapshot files, using the SAME URL scheme as the static/R2 deployment (see
// worker/): /index.json, /replays/<id>.brw, /replays/<id>.resources,
// /replays/<id>.keys, /replays/<id>/c<n>. One front-end (worker/public,
// embedded here) therefore works against both backends. It reads the current
// .brp format ONLY — convert legacy captures once with pack.
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
	// resources is the gzipped /api/replay/resources body, built lazily on the
	// first request (decoding every chunk's economy) and reused thereafter.
	resources []byte
	etag      string
	lastUse   time.Time
}

// replayInfo is one entry in the /index.json listing. File (== GameID, the
// basename without .brp) is the key the viewer builds every replay URL from,
// matching the R2 object naming.
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
			b, err := webassets.Assets.ReadFile(name)
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
	mux.HandleFunc("/app.js", serveAsset("public/app.js", "text/javascript; charset=utf-8"))
	mux.HandleFunc("/style.css", serveAsset("public/style.css", "text/css; charset=utf-8"))
	// The browser auto-requests a favicon; answer it so it isn't a 404 in logs.
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	// Vendored BAR unit icons, served at /icons/<file> to match the bitmap paths
	// in the wire payload. Icons are immutable, so let the browser cache them.
	if sub, err := iconsSubFS(); err == nil {
		mux.Handle("/icons/", http.StripPrefix("/icons/", cacheForever(http.FileServer(http.FS(sub)))))
	}
	// Vendored BAR player rank icons, served at /ranks/<n>.png (also immutable).
	if sub, err := ranksSubFS(); err == nil {
		mux.Handle("/ranks/", http.StripPrefix("/ranks/", cacheForever(http.FileServer(http.FS(sub)))))
	}
	mux.HandleFunc("/index.json", s.handleList)
	mux.HandleFunc("/replays/", s.handleReplays)
	return mux
}

// handleReplays routes the static-shaped replay URLs:
//
//	/replays/<id>.brw        head payload (meta, teams, icons, chunk index)
//	/replays/<id>.resources  per-frame team economy (gzipped JSON)
//	/replays/<id>.keys       the K section byte-for-byte (all core keyframes)
//	/replays/<id>/c<n>       chunk n's delta bytes, byte-for-byte
//
// <id> is the capture's basename without the .brp extension; the same paths
// resolve to plain objects in the R2 deployment (see worker/).
func (s *Server) handleReplays(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/replays/")
	if id, n, ok := strings.Cut(rest, "/"); ok {
		if !strings.HasPrefix(n, "c") {
			http.NotFound(w, r)
			return
		}
		s.handleChunk(w, r, id, n[1:])
		return
	}
	switch {
	case strings.HasSuffix(rest, ".brw"):
		s.handleReplay(w, r, strings.TrimSuffix(rest, ".brw"))
	case strings.HasSuffix(rest, ".resources"):
		s.handleResources(w, r, strings.TrimSuffix(rest, ".resources"))
	case strings.HasSuffix(rest, ".keys"):
		s.handleKeys(w, r, strings.TrimSuffix(rest, ".keys"))
	default:
		http.NotFound(w, r)
	}
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

// get returns the parsed .brp for a validated id, from cache when the file
// hasn't changed.
func (s *Server) get(name string) (*cacheEntry, error) {
	path := filepath.Join(s.Dir, name+".brp")
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

// validID confines a /replays/<id>… path segment to a bare name that maps to
// "<id>.brp" inside Dir (no separators, no traversal, no hidden files).
func validID(id string) bool {
	return id != "" && !strings.HasPrefix(id, ".") &&
		id+".brp" == filepath.Base(id+".brp") &&
		!strings.ContainsAny(id, "/\\")
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

// handleReplay returns one capture's head payload (/replays/<id>.brw): the
// BRW1 container of head JSON (meta, teams, icons, bounds, chunk index) plus
// the events section — small, so the page is interactive immediately. Frame
// data arrives via the .keys stream and the per-chunk delta files.
func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request, id string) {
	if !validID(id) {
		http.Error(w, "invalid replay id", http.StatusBadRequest)
		return
	}
	e, err := s.get(id)
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

// handleChunk returns chunk n's DELTA bytes (/replays/<id>/c<n>), sliced
// straight out of the stored file — chunks are independently gzipped exactly
// so this needs no re-encoding. Keyframes are not here: they are served
// together, as /replays/<id>.keys.
func (s *Server) handleChunk(w http.ResponseWriter, r *http.Request, id, num string) {
	if !validID(id) {
		http.Error(w, "invalid replay id", http.StatusBadRequest)
		return
	}
	e, err := s.get(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	i, err := strconv.Atoi(num)
	if err != nil || i < 0 || i >= len(e.brp.Chunks) {
		http.Error(w, fmt.Sprintf("invalid chunk (file has %d chunks)", len(e.brp.Chunks)), http.StatusBadRequest)
		return
	}
	c := e.brp.Chunks[i]
	sec := e.brp.Sections[snapshot.SecFrames]
	if c.FOff < 0 || c.FOff+c.FLen > int64(len(sec)) {
		http.Error(w, "chunk range outside frames section", http.StatusInternalServerError)
		return
	}
	if notModified(w, r, e.etag) {
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(sec[c.FOff : c.FOff+c.FLen])
}

// handleKeys returns the file's K section byte-for-byte
// (/replays/<id>.keys): every chunk's core keyframe as ONE gzip stream. The
// viewer fetches this right after the head and decodes it progressively while
// it downloads, which is what makes the whole timeline scrubbable within the
// first seconds.
func (s *Server) handleKeys(w http.ResponseWriter, r *http.Request, id string) {
	if !validID(id) {
		http.Error(w, "invalid replay id", http.StatusBadRequest)
		return
	}
	e, err := s.get(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	sec, ok := e.brp.Sections[snapshot.SecKeyframes]
	if !ok {
		http.Error(w, "capture has no keyframes section", http.StatusInternalServerError)
		return
	}
	if notModified(w, r, e.etag) {
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(sec)
}

// handleResources returns the per-frame team economy for a capture
// (/replays/<id>.resources), a gzipped JSON array of {f, r} the sidebar
// player list turns into metal/energy bars. Frame resources live in the .brp
// X stream, which the frame paths never fetch, so this decodes them once and
// caches the compressed body on the entry. Sent with Content-Encoding: gzip
// so the browser inflates it.
func (s *Server) handleResources(w http.ResponseWriter, r *http.Request, id string) {
	if !validID(id) {
		http.Error(w, "invalid replay id", http.StatusBadRequest)
		return
	}
	e, err := s.get(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.mu.Lock()
	body := e.resources
	if body == nil {
		body, err = brpResourcesPayload(e.brp)
		if err == nil {
			e.resources = body
		}
	}
	s.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if notModified(w, r, e.etag) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Encoding", "gzip")
	w.Write(body)
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
		id := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		infos = append(infos, replayInfo{File: id, GameID: id, Size: info.Size()})
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
