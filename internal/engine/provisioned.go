package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// provisionedCache records which games/maps pr-downloader has already fetched into
// this data dir, keyed by springname (the demo's gameVersion / mapName). pr-downloader
// re-queries and can re-download content on every call even when it is present, so the
// tool consults this cache to skip repeat provisioning. It is written under
// <data>/cache/ next to the rapid versions cache.
type provisionedCache struct {
	Games map[string]bool `json:"games"`
	Maps  map[string]bool `json:"maps"`
}

func (e *Engine) provisionedPath() string {
	return filepath.Join(e.cfg.DataDir, "cache", "barreplay-provisioned.json")
}

// loadProvisioned reads the cache, returning an empty (non-nil) one on any error so
// callers can use it unconditionally.
func (e *Engine) loadProvisioned() *provisionedCache {
	pc := &provisionedCache{Games: map[string]bool{}, Maps: map[string]bool{}}
	if b, err := os.ReadFile(e.provisionedPath()); err == nil {
		_ = json.Unmarshal(b, pc)
		if pc.Games == nil {
			pc.Games = map[string]bool{}
		}
		if pc.Maps == nil {
			pc.Maps = map[string]bool{}
		}
	}
	return pc
}

// saveProvisioned writes the cache (best-effort; a failure just means the next run
// re-checks with pr-downloader).
func (e *Engine) saveProvisioned(pc *provisionedCache) {
	if err := os.MkdirAll(filepath.Dir(e.provisionedPath()), 0o755); err != nil {
		return
	}
	if b, err := json.MarshalIndent(pc, "", "  "); err == nil {
		_ = os.WriteFile(e.provisionedPath(), b, 0o644)
	}
}
