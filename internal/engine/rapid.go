package engine

import (
	"bufio"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// A BAR replay pins one exact game build. The demo's gameVersion is that build's
// *springname* (e.g. "Beyond All Reason test-30541-1efcf40"), but it carries only
// the short git sha, so we cannot construct the rapid tag from it — and
// pr-downloader will not reliably resolve a game by springname. Handing it the
// display name (or the moving "byar:test" tag) installs the wrong build, and the
// engine then aborts with content_error: the dependent archive the demo requires
// is not found.
//
// resolveRapidGameTag consults BAR's rapid versions index and maps the springname
// to its precise "byar:git:<full-sha>" tag, which pr-downloader resolves exactly.
//
// The index is cached under <DataDir>/cache/versions.gz: the cached copy is used
// when it already knows the build, and only re-downloaded (replacing the cache)
// when the build is absent from it — new builds appear over time, so a stale cache
// must trigger exactly one refresh. It is best-effort: any failure returns ok=false
// and the caller falls back to passing the springname as-is (or a -game override).
func (e *Engine) resolveRapidGameTag(ctx context.Context, springname string) (tag, md5 string, ok bool) {
	cachePath := e.versionsCachePath()

	// Fast path: the cached index already knows this build.
	if tag, md5, ok, _ := searchVersionsFile(cachePath, springname); ok {
		return tag, md5, true
	}

	// Cache is absent or predates this build — refresh it, then look again.
	fmt.Fprintf(os.Stderr, "engine: refreshing rapid index (%s)...\n", e.versionsURL())
	if err := e.downloadVersions(ctx, cachePath); err != nil {
		fmt.Fprintf(os.Stderr, "engine: could not fetch rapid index: %v\n", err)
		return "", "", false
	}
	tag, md5, ok, _ = searchVersionsFile(cachePath, springname)
	return tag, md5, ok
}

// searchVersionsFile opens a cached versions.gz and searches it for springname.
func searchVersionsFile(path, springname string) (tag, md5 string, ok bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", false, err
	}
	defer f.Close()
	return searchVersions(f, springname)
}

// searchVersions scans a gzipped rapid index for an exact springname match and
// returns its tag and package md5.
func searchVersions(r io.Reader, springname string) (tag, md5 string, ok bool, err error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return "", "", false, err
	}
	defer gz.Close()
	sc := bufio.NewScanner(gz)
	sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for sc.Scan() {
		if tag, md5, ok := matchRapidLine(sc.Text(), springname); ok {
			return tag, md5, true, nil
		}
	}
	return "", "", false, sc.Err()
}

// downloadVersions fetches the rapid index and writes it to dest atomically (a
// temp file + rename), validating it is real gzip first so a proxy/error page
// never poisons the cache.
func (e *Engine) downloadVersions(ctx context.Context, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.versionsURL(), nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("versions index: HTTP %d", resp.StatusCode)
	}
	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "versions-*.gz.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := verifyGzip(tmpName); err != nil {
		return fmt.Errorf("versions index: %w", err)
	}
	return os.Rename(tmpName, dest)
}

// verifyGzip confirms path is a readable gzip stream.
func verifyGzip(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	return gz.Close()
}

// matchRapidLine parses one rapid versions.gz line ("tag,md5,depends,springname")
// and returns the tag and package md5 when the springname (the last comma-separated
// field) matches exactly. Taking the field after the last comma keeps it correct even
// if the depends field itself contains commas; BAR springnames never do.
func matchRapidLine(line, springname string) (tag, md5 string, ok bool) {
	last := strings.LastIndexByte(line, ',')
	if last < 0 || line[last+1:] != springname {
		return "", "", false
	}
	first := strings.IndexByte(line, ',')
	if first < 0 || first >= last { // need at least tag,...,name
		return "", "", false
	}
	tag = line[:first]
	// md5 is the next field, between the 1st and 2nd comma.
	if rest := line[first+1 : last]; rest != "" {
		if j := strings.IndexByte(rest, ','); j >= 0 {
			md5 = rest[:j]
		} else {
			md5 = rest
		}
	}
	return tag, md5, true
}

// versionsCachePath is where the rapid index is cached, under the data dir.
func (e *Engine) versionsCachePath() string {
	return filepath.Join(e.cfg.DataDir, "cache", "versions.gz")
}

// versionsURL derives the byar rapid versions index URL from the configured rapid
// master repo (".../repos.gz" -> ".../byar/versions.gz").
func (e *Engine) versionsURL() string {
	master := e.cfg.RapidRepoMaster
	if master == "" {
		master = barRapidRepoMaster
	}
	base := strings.TrimSuffix(master, "repos.gz")
	return base + "byar/versions.gz"
}
