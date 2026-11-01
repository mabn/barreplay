package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
)

// The site can talk back to an app. Every request the app makes carries
// its version in the User-Agent ("FogOfWar/0.2.22 (windows; ...)"), so the
// site can tell an outdated app apart, and a refusal whose JSON body names
// an "error" is a MESSAGE FOR THE USER, shown as written:
//
//	HTTP 426 Upgrade Required
//	{"error": "Please upgrade FogOfWar to 0.3.0", "url": "https://replay.fogofwar.dev/setup"}
//
// On the work poll (auto-replay's games list) the message goes up as a
// banner and auto-replay waits, asking again every minute, so it resumes
// by itself once the site lets it. 426 marks it as an upgrade request (the
// banner offers the download); any other status is just a message. "url"
// is optional. A refusal without a JSON "error" (a proxy's HTML 502) stays
// an ordinary error.

// siteError is the site refusing a request with a message for the user.
type siteError struct {
	Status  int    `json:"status"`
	Message string `json:"message"`
	URL     string `json:"url,omitempty"`
}

func (e *siteError) Error() string { return e.Message }

// upgrade is true when the site says this version cannot be used.
func (e *siteError) upgrade() bool { return e.Status == http.StatusUpgradeRequired }

// siteRefusal turns a non-200 answer into an error: a *siteError when the
// body carries a message, else "<what>: <status>".
func siteRefusal(resp *http.Response, what string) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var out struct {
		Error string `json:"error"`
		URL   string `json:"url"`
	}
	if json.Unmarshal(b, &out) == nil && strings.TrimSpace(out.Error) != "" {
		e := &siteError{Status: resp.StatusCode, Message: clip(strings.TrimSpace(out.Error), 500)}
		if u := strings.TrimSpace(out.URL); strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
			e.URL = clip(u, 500)
		}
		return e
	}
	return fmt.Errorf("%s: %s", what, resp.Status)
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// userAgent names the app and its version on every request.
func userAgent() string {
	return fmt.Sprintf("FogOfWar/%s (%s; +https://replay.fogofwar.dev/setup)", version, runtime.GOOS)
}

// uaTransport sets the User-Agent on requests that name none.
type uaTransport struct{ base http.RoundTripper }

func (t uaTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Header.Get("User-Agent") == "" {
		r = r.Clone(r.Context())
		r.Header.Set("User-Agent", userAgent())
	}
	return t.base.RoundTrip(r)
}

// installUserAgent wraps http.DefaultTransport, which every client in the
// app uses (http.DefaultClient, barapi's own client, the engine and
// patched-engine downloads), so no request goes out without the version.
// pr-downloader is a separate program and sends its own.
func installUserAgent() {
	if _, ok := http.DefaultTransport.(uaTransport); ok {
		return
	}
	http.DefaultTransport = uaTransport{base: http.DefaultTransport}
}
