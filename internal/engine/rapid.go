package engine

import (
	"bufio"
	"compress/gzip"
	"context"
	"net/http"
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
// It is best-effort: any failure returns ok=false and the caller falls back to
// passing the springname as-is (or an explicit -game override).
func (e *Engine) resolveRapidGameTag(ctx context.Context, springname string) (string, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.versionsURL(), nil)
	if err != nil {
		return "", false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		return "", false
	}
	defer gz.Close()

	sc := bufio.NewScanner(gz)
	sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for sc.Scan() {
		if tag, ok := matchRapidLine(sc.Text(), springname); ok {
			return tag, true
		}
	}
	return "", false
}

// matchRapidLine parses one rapid versions.gz line ("tag,md5,depends,springname")
// and returns the tag when the springname (the last comma-separated field) matches
// exactly. Taking the field after the last comma keeps it correct even if the
// depends field itself contains commas; BAR springnames never do.
func matchRapidLine(line, springname string) (string, bool) {
	last := strings.LastIndexByte(line, ',')
	if last < 0 || line[last+1:] != springname {
		return "", false
	}
	first := strings.IndexByte(line, ',')
	if first < 0 || first >= last { // need at least tag,...,name
		return "", false
	}
	return line[:first], true
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
