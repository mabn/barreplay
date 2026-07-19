// Package packer is the capture-to-published-replay pipeline shared by
// cmd/pack (manual/CLI use) and cmd/barreplay-ingest (the drag&drop upload
// daemon): parse a raw widget stream (.brsnap/.brepstream), enrich it with
// the demo's startscript metadata from the BAR API, write the .brp, and
// optionally upload the static-hosting pieces to the worker's R2 bucket and
// register the replay in its catalog.
package packer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/capture"
	"github.com/mabn/barreplay/internal/demofile"
	"github.com/mabn/barreplay/internal/viz"
	"github.com/mabn/barreplay/snapshot"
)

// ErrDemoUnavailable marks a Pack failure caused by the demo lookup/download
// (the BAR API doesn't know the game, network trouble, …) rather than the
// stream itself. Callers that can degrade — like the ingest daemon — retry
// with noDemo and publish the stream's own metadata instead of failing the
// upload outright.
var ErrDemoUnavailable = errors.New("demo metadata unavailable")

// loaded is an in-memory capture; it doubles as the snapshot.Writer sink when
// re-parsing a raw .brsnap through internal/capture.
type loaded struct {
	meta   snapshot.Meta
	frames []snapshot.Frame
	events []snapshot.Event
}

func (l *loaded) WriteMeta(m snapshot.Meta) error { l.meta = m; return nil }
func (l *loaded) WriteFrame(f snapshot.Frame) error {
	l.frames = append(l.frames, f)
	return nil
}
func (l *loaded) WriteEvent(e snapshot.Event) error {
	l.events = append(l.events, e)
	return nil
}
func (l *loaded) Close() error { return nil }

// load reads a raw capture stream. .brsnap (the text widget stream) re-parses
// through internal/capture — the exact parser the capture pipeline uses —
// seeded with base, which carries whatever demo metadata the caller obtained;
// .brepstream is its binary sibling.
func load(path string, base snapshot.Meta) (*loaded, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	l := &loaded{}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".brsnap":
		if err := capture.Consume(f, base, l); err != nil {
			return nil, fmt.Errorf("parsing brsnap: %w", err)
		}
	case ".brepstream":
		if err := capture.ConsumeBrep(f, base, l); err != nil {
			return nil, fmt.Errorf("parsing brepstream: %w", err)
		}
	default:
		return nil, fmt.Errorf("unsupported input type %q (want .brsnap or .brepstream)", filepath.Ext(path))
	}
	return l, nil
}

// demoMeta resolves id (a gameId or replay link) via the BAR API, downloads the
// .sdfz demo to a temp dir, and parses its header + startscript into the base
// capture metadata — the same seeding cmd/barreplay performs, minus the engine
// run. The demo is only needed for its first few KB (header + startscript), but
// the download is whole-file; a demo is a few MB, so this stays cheap.
// The raw [modoptions] map is returned alongside: it is deliberately NOT part
// of snapshot.Meta (never persisted in the .brp) — its only consumer is the
// catalog PUT, which distills it into settings flags (viz.SettingsFlags).
func demoMeta(ctx context.Context, client *barapi.Client, id string) (snapshot.Meta, map[string]string, error) {
	r, err := client.Resolve(ctx, id)
	if err != nil {
		return snapshot.Meta{}, nil, err
	}
	tmp, err := os.MkdirTemp("", "pack-demo-")
	if err != nil {
		return snapshot.Meta{}, nil, err
	}
	defer os.RemoveAll(tmp)
	p, err := client.Download(ctx, r, tmp)
	if err != nil {
		return snapshot.Meta{}, nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		return snapshot.Meta{}, nil, err
	}
	demo, err := demofile.Parse(f)
	f.Close()
	if err != nil {
		return snapshot.Meta{}, nil, fmt.Errorf("parsing demo %s: %w", r.FileName, err)
	}
	return demofile.BaseMeta(demo), demo.Startscript.ModOptions, nil
}

// inferSampleEvery returns the sampling interval implied by the frame stream:
// the smallest positive gap between consecutive sampled sim frames. A raw
// .brsnap does not record the capture's -every choice, and the .brp codec
// needs it (velocity displacement is quantized per sample interval).
func inferSampleEvery(frames []snapshot.Frame) int32 {
	best := int32(0)
	for i := 1; i < len(frames); i++ {
		if d := frames[i].Frame - frames[i-1].Frame; d > 0 && (best == 0 || d < best) {
			best = d
		}
	}
	return best
}

// Pack converts one input into <gameId>.brp (gameId = the input's basename,
// or the demo's when idArg redirects the lookup) next to the input or in
// outDir, and returns the written path plus the demo's raw modoptions (nil
// with noDemo) for the catalog upload.
func Pack(ctx context.Context, client *barapi.Client, in, outDir, idArg string, noDemo bool) (string, map[string]string, error) {
	gameID := strings.TrimSuffix(filepath.Base(in), filepath.Ext(in))
	base := snapshot.Meta{GameID: gameID}
	var modOptions map[string]string
	ext := strings.ToLower(filepath.Ext(in))
	if (ext == ".brsnap" || ext == ".brepstream") && !noDemo {
		id := idArg
		if id == "" {
			id = gameID
		}
		m, mo, err := demoMeta(ctx, client, id)
		if err != nil {
			return "", nil, fmt.Errorf("fetching demo metadata for %q: %w: %v (pass -id <gameId|link> if the file name is not the gameId, or -no-demo to pack without map/version/player metadata)", id, ErrDemoUnavailable, err)
		}
		fmt.Fprintf(os.Stderr, "%s: demo metadata: map %q, game %q, engine %s, %d players\n",
			in, m.MapName, m.GameVersion, m.EngineVersion, len(m.Players))
		base = m
		modOptions = mo
	}
	l, err := load(in, base)
	if err != nil {
		return "", nil, err
	}
	if l.meta.GameID == "" {
		l.meta.GameID = gameID
	}
	if l.meta.SampleEvery == 0 {
		l.meta.SampleEvery = inferSampleEvery(l.frames)
	}
	dir := outDir
	if dir == "" {
		dir = filepath.Dir(in)
	}
	w, err := snapshot.NewBRPWriter(dir, gameID)
	if err != nil {
		return "", nil, err
	}
	if err := w.WriteMeta(l.meta); err != nil {
		w.Close()
		return "", nil, err
	}
	for _, fr := range l.frames {
		if err := w.WriteFrame(fr); err != nil {
			w.Close()
			return "", nil, err
		}
	}
	for _, e := range l.events {
		if err := w.WriteEvent(e); err != nil {
			w.Close()
			return "", nil, err
		}
	}
	if err := w.Close(); err != nil {
		return "", nil, err
	}

	outPath := filepath.Join(dir, gameID+".brp")
	inSize, outSize := fileSize(in), fileSize(outPath)
	ratio := ""
	if outSize > 0 {
		ratio = fmt.Sprintf(", %.0fx smaller", float64(inSize)/float64(outSize))
	}
	fmt.Fprintf(os.Stderr, "%s (%.1f MB) -> %s (%.2f MB%s): %d frames, %d events\n",
		in, mb(inSize), outPath, mb(outSize), ratio, len(l.frames), len(l.events))
	return outPath, modOptions, nil
}

// StreamRev derives a capture's revision id: the first 8 hex chars of the raw
// stream file's SHA-256. Content-addressed, so re-publishing the same bytes
// lands under the same revision (idempotent) while any change gets a fresh
// one — which is what lets /replays/* stay immutable-cacheable: revisioned
// publishes never overwrite a served object.
func StreamRev(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil))[:8], nil
}

// UploadOptions configures UploadStatic.
type UploadOptions struct {
	// Target is "r2" (the real bucket) or "local" (the wrangler/vite dev
	// simulator's preview bucket).
	Target string
	// WorkerDir is the Cloudflare worker project directory whose upload
	// tooling (npx tsx tools/upload.ts) performs the R2 puts.
	WorkerDir string
	// IndexURL is the deployed worker's base URL for the catalog PUT;
	// empty skips the registration with a warning.
	IndexURL string
	// Rev, when non-empty, publishes the pieces under the revisioned id
	// "<gameId>-<rev>" (see StreamRev) and records it as the catalog row's
	// rid. Empty publishes under the bare gameId (the pre-revisioning
	// layout). Nothing is ever deleted either way — superseded revisions
	// stay servable.
	Rev string
	// ModOptions is the demo startscript's raw [modoptions] map (nil when
	// packed with noDemo); it contributes the catalog's settings flags.
	ModOptions map[string]string
}

// UploadStatic uploads one packed replay's static files to the worker's R2
// bucket: it writes the static bundle (viz.WriteStaticBundle — the same bytes
// cmd/barreplay-static writes) into a temp dir and uploads it. For "r2" with
// R2 API credentials in the environment (R2_ACCESS_KEY_ID +
// R2_SECRET_ACCESS_KEY) the upload is NATIVE Go — concurrent SigV4 PUTs
// straight against the bucket's S3 endpoint (r2.go), no node tooling
// involved. Otherwise (no credentials, or the "local" dev simulator, which
// only wrangler can write) it shells into the worker's uploader (npx tsx
// tools/upload.ts). After the upload it registers the replay in the worker's
// catalog (the Durable Object SQLite table behind GET /api/replays) via
// PUT <IndexURL>/api/replays/<id>.
func UploadStatic(ctx context.Context, brpPath string, o UploadOptions) error {
	var native *R2Client
	if o.Target == "r2" {
		native = r2ClientFromEnv(o.WorkerDir)
	}
	if native == nil {
		// The node-tooling path needs the worker project on disk.
		if err := checkWorkerDir(o.WorkerDir); err != nil {
			return err
		}
	}
	gameID := strings.TrimSuffix(filepath.Base(brpPath), filepath.Ext(brpPath))
	tmp, err := os.MkdirTemp("", "pack-upload-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	// The bundle's URL id is the source .brp's basename, so a revisioned
	// publish stages the file under its "<gameId>-<rev>" name first.
	src, uploadID := brpPath, gameID
	if o.Rev != "" {
		uploadID = gameID + "-" + o.Rev
		src = filepath.Join(tmp, uploadID+".brp")
		if err := copyFile(brpPath, src); err != nil {
			return err
		}
	}
	bundleDir := filepath.Join(tmp, "bundle")
	if _, err := viz.WriteStaticBundle(src, bundleDir); err != nil {
		return err
	}

	if native != nil {
		fmt.Fprintf(os.Stderr, "uploading %q to %s/%s (native S3, %d in flight)\n",
			uploadID, native.Endpoint, native.Bucket, uploadConcurrency)
		if err := native.UploadBundle(ctx, bundleDir); err != nil {
			return fmt.Errorf("uploading %s: %w", uploadID, err)
		}
	} else {
		args := []string{"tsx", "tools/upload.ts", bundleDir, uploadID}
		if o.Target == "local" {
			// --preview: the local dev servers (vite dev and wrangler dev) bind the
			// preview bucket, so that is where a "local" upload must land to show up.
			args = append(args, "--local", "--preview")
		}
		cmd := exec.CommandContext(ctx, "npx", args...)
		cmd.Dir = o.WorkerDir
		cmd.Stdout = os.Stderr
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("uploading %s: %w (is the worker project installed? npm install in %s)", uploadID, err, o.WorkerDir)
		}
	}
	if o.IndexURL == "" {
		fmt.Fprintf(os.Stderr, "%s: uploaded, but NOT registered in the replay catalog: no index URL (pass -index-url or set BARREPLAY_INDEX_URL to the deployed worker)\n", uploadID)
		return nil
	}
	rid := ""
	if o.Rev != "" {
		rid = uploadID
	}
	if err := putCatalogEntry(ctx, o.IndexURL, gameID, rid, brpPath, dirSize(bundleDir), o.ModOptions); err != nil {
		return fmt.Errorf("registering %s in the replay catalog at %s: %w", gameID, o.IndexURL, err)
	}
	fmt.Fprintf(os.Stderr, "%s: registered in the replay catalog at %s\n", gameID, o.IndexURL)
	return nil
}

// checkWorkerDir verifies workerDir holds the Cloudflare worker project the
// upload paths shell into.
func checkWorkerDir(workerDir string) error {
	if _, err := os.Stat(filepath.Join(workerDir, "wrangler.jsonc")); err != nil {
		return fmt.Errorf("uploading needs the Cloudflare worker project: %w (run from the repo root, or point -worker-dir at it)", err)
	}
	return nil
}

// putCatalogEntry upserts one replay's stats (start time, duration, map,
// team-size spec, bundle byte size — derived from the packed .brp — plus the
// settings flags distilled from the demo's modoptions) into the worker's
// catalog, keyed by the bare gameId with rid naming the served revision. If
// the worker guards writes (its REPLAY_PUT_TOKEN secret), the same-named env
// var supplies the bearer token.
func putCatalogEntry(ctx context.Context, indexURL, gameID, rid, brpPath string, sizeBytes int64, modOptions map[string]string) error {
	f, err := os.Open(brpPath)
	if err != nil {
		return err
	}
	bf, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		return err
	}
	entry := viz.BuildCatalogEntry(gameID, bf, sizeBytes)
	if rid != "" {
		entry.Rid = &rid
	}
	entry.Settings = viz.SettingsFlags(modOptions)
	body, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	endpoint := strings.TrimSuffix(indexURL, "/") + "/api/replays/" + url.PathEscape(gameID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token := os.Getenv("REPLAY_PUT_TOKEN"); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("PUT %s: %s: %s", endpoint, resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// dirSize sums every file under root — the static bundle's download
// footprint, shown as the catalog's data size. Best-effort (errors count 0).
func dirSize(root string) int64 {
	var total int64
	filepath.WalkDir(root, func(_ string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if fi, err := d.Info(); err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total
}

func fileSize(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return fi.Size()
}

func mb(n int64) float64 { return float64(n) / (1024 * 1024) }
