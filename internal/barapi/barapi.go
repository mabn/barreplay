// Package barapi resolves a Beyond All Reason replay link or gameId to replay
// metadata and downloads the .sdfz demo file.
//
// The public site (beyondallreason.info/replays) is only a frontend; the real
// backend is api.bar-rts.com. The metadata JSON does NOT contain a download URL
// for the demo -- it is built by convention from the returned fileName against
// the OVH object-storage bucket the project uploads replays to.
package barapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	// apiBase is the replay metadata API.
	apiBase = "https://api.bar-rts.com"
	// storageBase is the OVH Swift bucket where demos live. The full URL is
	// storageBase + "/" + PathEscape(fileName).
	storageBase = "https://storage.uk.cloud.ovh.net/v1/AUTH_10286efc0d334efd917d476d7183232e/BAR/demos"
)

// Replay is the subset of the api.bar-rts.com /replays/{id} response we use.
type Replay struct {
	ID            string `json:"id"`
	FileName      string `json:"fileName"`
	EngineVersion string `json:"engineVersion"`
	GameVersion   string `json:"gameVersion"`
	DurationMs    int64  `json:"durationMs"`
	Map           struct {
		ScriptName string `json:"scriptName"`
		FileName   string `json:"fileName"`
	} `json:"Map"`
}

// MapName returns the map's script (display) name, used for map provisioning.
func (r *Replay) MapName() string { return r.Map.ScriptName }

// Client talks to the BAR replay API. The zero value is not usable; use New.
type Client struct {
	http        *http.Client
	apiBase     string
	storageBase string
}

// Option customizes a Client (primarily for tests).
type Option func(*Client)

// WithHTTPClient overrides the underlying *http.Client.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithBaseURLs overrides the API and storage base URLs (for tests).
func WithBaseURLs(api, storage string) Option {
	return func(c *Client) { c.apiBase, c.storageBase = api, storage }
}

// New returns a Client with sensible defaults.
func New(opts ...Option) *Client {
	c := &Client{
		http:        &http.Client{Timeout: 60 * time.Second},
		apiBase:     apiBase,
		storageBase: storageBase,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// gameIDRe matches a 32-hex-char BAR gameId.
var gameIDRe = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

// ParseGameID extracts a gameId from a bare id, a full replays URL
// (…/replays?gameId=…), or an api.bar-rts.com/replays/<id> URL.
func ParseGameID(input string) (string, error) {
	s := strings.TrimSpace(input)
	if gameIDRe.MatchString(s) {
		return strings.ToLower(s), nil
	}
	if u, err := url.Parse(s); err == nil {
		if v := u.Query().Get("gameId"); gameIDRe.MatchString(v) {
			return strings.ToLower(v), nil
		}
		// Trailing path segment, e.g. /replays/<id>.
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) > 0 {
			last := parts[len(parts)-1]
			if gameIDRe.MatchString(last) {
				return strings.ToLower(last), nil
			}
		}
	}
	return "", fmt.Errorf("barapi: could not find a gameId in %q", input)
}

// Resolve fetches replay metadata for a gameId or replay link.
func (c *Client) Resolve(ctx context.Context, input string) (*Replay, error) {
	id, err := ParseGameID(input)
	if err != nil {
		return nil, err
	}
	endpoint := c.apiBase + "/replays/" + id
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("barapi: GET %s: %w", endpoint, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("barapi: GET %s: unexpected status %s", endpoint, resp.Status)
	}
	var r Replay
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("barapi: decode replay metadata: %w", err)
	}
	if r.FileName == "" {
		return nil, errors.New("barapi: replay metadata has empty fileName")
	}
	return &r, nil
}

// DownloadURL builds the direct .sdfz download URL for a fileName. The fileName
// contains spaces and must be URL-escaped.
func (c *Client) DownloadURL(fileName string) string {
	return c.storageBase + "/" + url.PathEscape(fileName)
}

// Download streams the replay's .sdfz into destDir (created if needed) under its
// original fileName and returns the local path. If the file already exists with a
// matching size it is reused. It retries transient network failures with backoff.
func (c *Client) Download(ctx context.Context, r *Replay, destDir string) (string, error) {
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(destDir, r.FileName)
	dlURL := c.DownloadURL(r.FileName)

	var lastErr error
	for attempt, backoff := 0, 2*time.Second; attempt < 5; attempt, backoff = attempt+1, backoff*2 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(backoff):
			}
		}
		err := c.downloadOnce(ctx, dlURL, dest)
		if err == nil {
			return dest, nil
		}
		lastErr = err
	}
	return "", fmt.Errorf("barapi: download %s: %w", r.FileName, lastErr)
}

func (c *Client) downloadOnce(ctx context.Context, dlURL, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, dlURL, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %s", resp.Status)
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dest)
}
