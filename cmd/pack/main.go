// Command pack converts raw captures (.jsonl, .brsnap, or the Replay
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
//	pack [flags] <capture.jsonl|capture.brsnap> [...]
//	pack -out ./snapshots ./snapshots/*.jsonl
//	pack -id 6da7496aca487581a12b7a6d5bd99bc0 ./renamed.brsnap
//	pack -upload r2 ./caps/<gameId>.brepstream
//
// Each input produces "<gameId>.brp" (gameId = the input's basename) in the
// input's own directory, or in -out when set. Inputs are processed
// independently; a failure on one is reported and the rest continue.
//
// -upload r2|local additionally packs each fresh .brp into its static-hosting
// files (viz.WriteStaticBundle — the same bytes cmd/barreplay-static writes)
// and puts them into the worker's R2 bucket via wrangler, so the replay shows
// up in the deployed viewer immediately ("r2") or in the local `npm run dev`
// simulator ("local"). No index.json is uploaded — the Worker lists the
// bucket live. Needs the worker/ project on disk (npx wrangler runs there;
// -worker-dir if it is not ./worker) and, for "r2", wrangler auth
// (`npx wrangler login` or CLOUDFLARE_API_TOKEN).
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
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
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: pack [flags] <capture.jsonl|capture.brsnap|capture.brepstream> [...]\n\n")
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
			err = uploadStatic(ctx, brpPath, *upload, *workerDir)
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

// load reads a legacy capture. .jsonl decodes through snapshot.NewReader (its
// meta line is complete, so base is unused); .brsnap (the raw widget stream)
// re-parses through internal/capture — the exact parser the capture pipeline
// uses — seeded with base, which carries whatever demo metadata the caller
// obtained.
func load(path string, base snapshot.Meta) (*loaded, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	l := &loaded{}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".jsonl":
		rd := snapshot.NewReader(f)
		sawMeta := false
		for {
			meta, frame, event, err := rd.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, fmt.Errorf("reading jsonl: %w", err)
			}
			switch {
			case meta != nil:
				l.meta = *meta
				sawMeta = true
			case frame != nil:
				l.frames = append(l.frames, *frame)
			case event != nil:
				l.events = append(l.events, *event)
			}
		}
		if !sawMeta {
			return nil, fmt.Errorf("no meta record found (is this a barreplay .jsonl?)")
		}
	case ".brsnap":
		if err := capture.Consume(f, base, l); err != nil {
			return nil, fmt.Errorf("parsing brsnap: %w", err)
		}
	case ".brepstream":
		if err := capture.ConsumeBrep(f, base, l); err != nil {
			return nil, fmt.Errorf("parsing brepstream: %w", err)
		}
	default:
		return nil, fmt.Errorf("unsupported input type %q (want .jsonl, .brsnap or .brepstream)", filepath.Ext(path))
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

// bucketName is the R2 bucket the worker binds (wrangler.jsonc); the same name
// is used by the local dev simulator, matching worker/tools/upload.mjs.
const bucketName = "barreplay-replays"

// staticObjects packs brpPath's static-hosting files into dir (via the same
// viz.WriteStaticBundle behind cmd/barreplay-static, so the bytes are
// byte-identical to the dynamic server's) and returns the bucket keys to
// upload, sorted, mapped to their local paths. index.json is deliberately
// absent: the Worker builds the listing live from the bucket.
func staticObjects(brpPath, dir string) (gameID string, objects map[string]string, err error) {
	gameID, err = viz.WriteStaticBundle(brpPath, dir)
	if err != nil {
		return "", nil, err
	}
	objects = map[string]string{}
	root := filepath.Join(dir, "replays")
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		objects[filepath.ToSlash(rel)] = p
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	return gameID, objects, nil
}

// uploadStatic uploads one packed replay's static files to the worker's R2
// bucket, one `npx wrangler r2 object put` per file (run inside workerDir, so
// wrangler picks up the project's wrangler.jsonc, node_modules, and — for
// "local" — the .wrangler dev-simulator state). target is "r2" or "local".
func uploadStatic(ctx context.Context, brpPath, target, workerDir string) error {
	if _, err := os.Stat(filepath.Join(workerDir, "wrangler.jsonc")); err != nil {
		return fmt.Errorf("-upload needs the Cloudflare worker project: %w (run from the repo root, or point -worker-dir at it)", err)
	}
	tmp, err := os.MkdirTemp("", "pack-upload-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	gameID, objects, err := staticObjects(brpPath, tmp)
	if err != nil {
		return err
	}
	// Explicit --remote/--local: wrangler's own default for `r2 object put` is
	// LOCAL, so a bare put would silently write to disk and never reach R2.
	mode := "--remote"
	where := "real R2"
	if target == "local" {
		mode = "--local"
		where = "local wrangler dev simulator"
	}
	keys := make([]string, 0, len(objects))
	for k := range objects {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Fprintf(os.Stderr, "%s: uploading %d objects to %s (%s)\n", gameID, len(keys), bucketName, where)
	for _, key := range keys {
		file, err := filepath.Abs(objects[key])
		if err != nil {
			return err
		}
		cmd := exec.CommandContext(ctx, "npx", "wrangler", "r2", "object", "put", bucketName+"/"+key, "--file", file, mode)
		cmd.Dir = workerDir
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("uploading %s: %w", key, err)
		}
		fmt.Fprintf(os.Stderr, "  put %s\n", key)
	}
	return nil
}

func fileSize(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return fi.Size()
}

func mb(n int64) float64 { return float64(n) / (1024 * 1024) }
