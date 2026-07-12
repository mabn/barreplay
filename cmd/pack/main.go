// Command pack converts raw widget captures (.brsnap, or the Replay
// uploader widget's binary .brepstream) into the compact binary .brp
// format — the only format the viewer serves. Use it once per capture.
//
// A raw .brsnap/.brepstream is just the widget's stream: it carries frames,
// unit defs and teams, but the player roster from the demo startscript is
// richer (rank/OpenSkill/country). To still produce a FULL .brp without
// re-running the simulation, pack takes the replay's gameId (from the input's
// file name, which is how the pipeline names widget streams, or from -id),
// downloads the demo from the BAR API, and seeds its startscript metadata
// exactly like cmd/barreplay does. -no-demo skips that (offline; the .brp
// then keeps whatever metadata the stream itself carries — a .brepstream's
// GAME line has map/version but no rich roster).
//
// Usage:
//
//	pack [flags] <capture.brsnap|capture.brepstream> [...]
//	pack -out ./snapshots ./caps/*.brsnap
//	pack -id 6da7496aca487581a12b7a6d5bd99bc0 ./renamed.brsnap
//	pack -upload r2 ./caps/<gameId>.brepstream
//
// Each input produces "<gameId>.brp" (gameId = the input's basename) in the
// input's own directory, or in -out when set. Inputs are processed
// independently; a failure on one is reported and the rest continue.
//
// -upload r2|local additionally uploads each input's packed .brp static-
// hosting files (viz.WriteStaticBundle — the same bytes cmd/barreplay-static
// writes) to the worker's R2 bucket, targeting the real bucket ("r2") or the
// local `npm run dev` simulator ("local"). The viewer serves ONLY the .brp
// wire format, so every input — including a raw .brepstream — is converted
// first and uploads the efficient v4 pieces. No index.json is uploaded — the
// Worker lists the bucket live. Needs the worker/ project on disk with
// node_modules installed (-worker-dir if it is not ./worker) and, for "r2",
// either R2 API credentials (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY, the fast
// S3 path) or wrangler auth (`npx wrangler login` / CLOUDFLARE_API_TOKEN).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/capture"
	"github.com/mabn/barreplay/internal/demofile"
	"github.com/mabn/barreplay/internal/viz"
	"github.com/mabn/barreplay/snapshot"
)

func main() {
	var (
		outDir    = flag.String("out", "", "output directory (default: next to each input)")
		idArg     = flag.String("id", "", "replay gameId or link used to fetch the demo metadata for a .brsnap/.brepstream input (default: the input's file name; only valid with a single input)")
		noDemo    = flag.Bool("no-demo", false, "do not fetch the demo for .brsnap/.brepstream inputs; the .brp then only has the metadata the stream itself carries")
		upload    = flag.String("upload", "", `after packing, upload the replay's static files to the worker's R2 bucket: "r2" (real bucket, needs wrangler auth) or "local" (the wrangler dev simulator)`)
		workerDir = flag.String("worker-dir", "worker", "the Cloudflare worker project directory wrangler runs in (with -upload)")
		indexURL  = flag.String("index-url", "", "base URL of the deployed worker, used to register the uploaded replay in the catalog via PUT /api/replays/<id> (default: $BARREPLAY_INDEX_URL; for -upload local, "+localIndexURL+"). Empty and no env var: skip with a warning")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: pack [flags] <capture.brsnap|capture.brepstream> [...]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	if *idArg != "" && flag.NArg() > 1 {
		fmt.Fprintln(os.Stderr, "pack: -id applies to exactly one input")
		os.Exit(2)
	}
	if *upload != "" && *upload != "r2" && *upload != "local" {
		fmt.Fprintf(os.Stderr, "pack: -upload must be \"r2\" or \"local\" (got %q)\n", *upload)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := barapi.New()
	failed := 0
	for _, in := range flag.Args() {
		brpPath, err := pack(ctx, client, in, *outDir, *idArg, *noDemo)
		if err == nil && *upload != "" {
			err = uploadStatic(ctx, brpPath, *upload, *workerDir, resolveIndexURL(*indexURL, *upload))
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "pack: %s: %v\n", in, err)
			failed++
		}
	}
	if failed > 0 {
		os.Exit(1)
	}
}

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
func demoMeta(ctx context.Context, client *barapi.Client, id string) (snapshot.Meta, error) {
	r, err := client.Resolve(ctx, id)
	if err != nil {
		return snapshot.Meta{}, err
	}
	tmp, err := os.MkdirTemp("", "pack-demo-")
	if err != nil {
		return snapshot.Meta{}, err
	}
	defer os.RemoveAll(tmp)
	p, err := client.Download(ctx, r, tmp)
	if err != nil {
		return snapshot.Meta{}, err
	}
	f, err := os.Open(p)
	if err != nil {
		return snapshot.Meta{}, err
	}
	demo, err := demofile.Parse(f)
	f.Close()
	if err != nil {
		return snapshot.Meta{}, fmt.Errorf("parsing demo %s: %w", r.FileName, err)
	}
	return demofile.BaseMeta(demo), nil
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

// pack converts one input into <gameId>.brp and returns the written path.
func pack(ctx context.Context, client *barapi.Client, in, outDir, idArg string, noDemo bool) (string, error) {
	gameID := strings.TrimSuffix(filepath.Base(in), filepath.Ext(in))
	base := snapshot.Meta{GameID: gameID}
	ext := strings.ToLower(filepath.Ext(in))
	if (ext == ".brsnap" || ext == ".brepstream") && !noDemo {
		id := idArg
		if id == "" {
			id = gameID
		}
		m, err := demoMeta(ctx, client, id)
		if err != nil {
			return "", fmt.Errorf("fetching demo metadata for %q: %w (pass -id <gameId|link> if the file name is not the gameId, or -no-demo to pack without map/version/player metadata)", id, err)
		}
		fmt.Fprintf(os.Stderr, "%s: demo metadata: map %q, game %q, engine %s, %d players\n",
			in, m.MapName, m.GameVersion, m.EngineVersion, len(m.Players))
		base = m
	}
	l, err := load(in, base)
	if err != nil {
		return "", err
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
		return "", err
	}
	if err := w.WriteMeta(l.meta); err != nil {
		w.Close()
		return "", err
	}
	for _, fr := range l.frames {
		if err := w.WriteFrame(fr); err != nil {
			w.Close()
			return "", err
		}
	}
	for _, e := range l.events {
		if err := w.WriteEvent(e); err != nil {
			w.Close()
			return "", err
		}
	}
	if err := w.Close(); err != nil {
		return "", err
	}

	outPath := filepath.Join(dir, gameID+".brp")
	inSize, outSize := fileSize(in), fileSize(outPath)
	ratio := ""
	if outSize > 0 {
		ratio = fmt.Sprintf(", %.0fx smaller", float64(inSize)/float64(outSize))
	}
	fmt.Fprintf(os.Stderr, "%s (%.1f MB) -> %s (%.2f MB%s): %d frames, %d events\n",
		in, mb(inSize), outPath, mb(outSize), ratio, len(l.frames), len(l.events))
	return outPath, nil
}

// checkWorkerDir verifies workerDir holds the Cloudflare worker project the
// upload paths shell into.
func checkWorkerDir(workerDir string) error {
	if _, err := os.Stat(filepath.Join(workerDir, "wrangler.jsonc")); err != nil {
		return fmt.Errorf("-upload needs the Cloudflare worker project: %w (run from the repo root, or point -worker-dir at it)", err)
	}
	return nil
}

// localIndexURL is where `npm run dev` (vite + the Cloudflare plugin) serves
// the worker's API routes, the default catalog target for -upload local.
const localIndexURL = "http://127.0.0.1:5173"

// resolveIndexURL picks the catalog base URL: the -index-url flag, else the
// BARREPLAY_INDEX_URL env var, else (local target only) the vite dev server.
// Empty means "skip the catalog PUT" — uploadStatic warns about it.
func resolveIndexURL(flagVal, target string) string {
	if flagVal != "" {
		return flagVal
	}
	if v := os.Getenv("BARREPLAY_INDEX_URL"); v != "" {
		return v
	}
	if target == "local" {
		return localIndexURL
	}
	return ""
}

// uploadStatic uploads one packed replay's static files to the worker's R2
// bucket: it writes the static bundle (viz.WriteStaticBundle — the same bytes
// cmd/barreplay-static writes) into a temp dir and hands it to the worker's
// uploader (npx tsx tools/upload.ts), which parallelizes the puts and uses
// the R2 S3 API when R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are set. target is
// "r2" or "local". After the upload it registers the replay in the worker's
// catalog (the Durable Object SQLite table behind GET /api/replays) via
// PUT <indexURL>/api/replays/<id>; indexURL == "" skips that with a warning.
func uploadStatic(ctx context.Context, brpPath, target, workerDir, indexURL string) error {
	if err := checkWorkerDir(workerDir); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp("", "pack-upload-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	gameID, err := viz.WriteStaticBundle(brpPath, tmp)
	if err != nil {
		return err
	}
	args := []string{"tsx", "tools/upload.ts", tmp, gameID}
	if target == "local" {
		// --preview: the local dev servers (vite dev and wrangler dev) bind the
		// preview bucket, so that is where a "local" upload must land to show up.
		args = append(args, "--local", "--preview")
	}
	cmd := exec.CommandContext(ctx, "npx", args...)
	cmd.Dir = workerDir
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("uploading %s: %w (is the worker project installed? npm install in %s)", gameID, err, workerDir)
	}
	if indexURL == "" {
		fmt.Fprintf(os.Stderr, "%s: uploaded, but NOT registered in the replay catalog: no index URL (pass -index-url or set BARREPLAY_INDEX_URL to the deployed worker)\n", gameID)
		return nil
	}
	if err := putCatalogEntry(ctx, indexURL, gameID, brpPath, dirSize(tmp)); err != nil {
		return fmt.Errorf("registering %s in the replay catalog at %s: %w", gameID, indexURL, err)
	}
	fmt.Fprintf(os.Stderr, "%s: registered in the replay catalog at %s\n", gameID, indexURL)
	return nil
}

// putCatalogEntry upserts one replay's stats (start time, duration, map,
// team-size spec, bundle byte size — derived from the packed .brp) into the
// worker's catalog. If the worker guards writes (its REPLAY_PUT_TOKEN
// secret), the same-named env var supplies the bearer token.
func putCatalogEntry(ctx context.Context, indexURL, gameID, brpPath string, sizeBytes int64) error {
	f, err := os.Open(brpPath)
	if err != nil {
		return err
	}
	bf, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		return err
	}
	body, err := json.Marshal(viz.BuildCatalogEntry(gameID, bf, sizeBytes))
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
