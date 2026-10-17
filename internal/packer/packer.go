// Package packer is the capture-to-published-replay pipeline shared by
// cmd/pack (manual/CLI use) and cmd/bringest (the drag&drop upload
// daemon): parse a raw widget stream (.brepstream), enrich it with
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
	comms  []snapshot.Comm
	// The re-simulation's analysis records (protocol 4), carried through to
	// the .brp untouched. A live upload has none.
	facts       []snapshot.Fact
	damage      []snapshot.DamageWindow
	lives       []snapshot.UnitLife
	visibility  []snapshot.Visibility
	hits        []snapshot.Hit
	unitEnds    []snapshot.UnitEnd
	projectiles []snapshot.Projectile
	blasts      []snapshot.Blast
	shields     []snapshot.Shield
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
func (l *loaded) WriteComm(c snapshot.Comm) error {
	l.comms = append(l.comms, c)
	return nil
}
func (l *loaded) WriteFact(f snapshot.Fact) error { l.facts = append(l.facts, f); return nil }
func (l *loaded) WriteDamage(d snapshot.DamageWindow) error {
	l.damage = append(l.damage, d)
	return nil
}
func (l *loaded) WriteLife(u snapshot.UnitLife) error { l.lives = append(l.lives, u); return nil }
func (l *loaded) WriteVisibility(v snapshot.Visibility) error {
	l.visibility = append(l.visibility, v)
	return nil
}
func (l *loaded) WriteHit(h snapshot.Hit) error { l.hits = append(l.hits, h); return nil }
func (l *loaded) WriteUnitEnd(u snapshot.UnitEnd) error {
	l.unitEnds = append(l.unitEnds, u)
	return nil
}
func (l *loaded) WriteProjectile(p snapshot.Projectile) error {
	l.projectiles = append(l.projectiles, p)
	return nil
}
func (l *loaded) WriteBlast(b snapshot.Blast) error   { l.blasts = append(l.blasts, b); return nil }
func (l *loaded) WriteShield(s snapshot.Shield) error { l.shields = append(l.shields, s); return nil }
func (l *loaded) Close() error                        { return nil }

// load reads a raw .brepstream capture through internal/capture — the exact
// parser the capture pipeline uses — seeded with base, which carries whatever
// demo metadata the caller obtained. The legacy .brsnap text stream is no
// longer read: nothing has written one since the re-sim moved to .brepstream.
func load(path string, base snapshot.Meta) (*loaded, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	l := &loaded{}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".brepstream":
		if err := capture.ConsumeBrep(f, base, l); err != nil {
			return nil, fmt.Errorf("parsing brepstream: %w", err)
		}
	default:
		return nil, fmt.Errorf("unsupported input type %q (want .brepstream)", filepath.Ext(path))
	}
	return l, nil
}

// writeAnalysis replays the analysis records into w.
func (l *loaded) writeAnalysis(w snapshot.Writer) error {
	for _, f := range l.facts {
		if err := w.WriteFact(f); err != nil {
			return err
		}
	}
	for _, d := range l.damage {
		if err := w.WriteDamage(d); err != nil {
			return err
		}
	}
	for _, u := range l.lives {
		if err := w.WriteLife(u); err != nil {
			return err
		}
	}
	for _, v := range l.visibility {
		if err := w.WriteVisibility(v); err != nil {
			return err
		}
	}
	for _, h := range l.hits {
		if err := w.WriteHit(h); err != nil {
			return err
		}
	}
	for _, u := range l.unitEnds {
		if err := w.WriteUnitEnd(u); err != nil {
			return err
		}
	}
	for _, p := range l.projectiles {
		if err := w.WriteProjectile(p); err != nil {
			return err
		}
	}
	for _, b := range l.blasts {
		if err := w.WriteBlast(b); err != nil {
			return err
		}
	}
	for _, s := range l.shields {
		if err := w.WriteShield(s); err != nil {
			return err
		}
	}
	return nil
}

// demoInfo is everything a pack takes from the demo file.
type demoInfo struct {
	Meta snapshot.Meta
	// Comms is the demo's chat + map drawings, which SUPERSEDE the capture
	// stream's own (see capture.ReplaceComms for why).
	Comms []snapshot.Comm
	// SelfD is the demo's self-destruct orders, as events: input, which no
	// capture records (demofile.Demo.SelfDEvents).
	SelfD []snapshot.Event
	// ModOptions is the raw [modoptions] map. Deliberately NOT part of
	// snapshot.Meta (never persisted in the .brp) — its only consumer is the
	// catalog PUT, which distills it into settings flags (viz.SettingsFlags).
	ModOptions map[string]string
}

// demoMeta resolves id (a gameId or replay link) via the BAR API, downloads the
// .sdfz demo to a temp dir, and parses it into the base capture metadata — the
// same seeding cmd/barreplay performs, minus the engine run — plus the chat and
// drawings out of its packet stream. The download is whole-file; a demo is a
// few MB, so this stays cheap.
func demoMeta(ctx context.Context, client *barapi.Client, id string) (demoInfo, error) {
	r, err := client.Resolve(ctx, id)
	if err != nil {
		return demoInfo{}, err
	}
	tmp, err := os.MkdirTemp("", "pack-demo-")
	if err != nil {
		return demoInfo{}, err
	}
	defer os.RemoveAll(tmp)
	p, err := client.Download(ctx, r, tmp)
	if err != nil {
		return demoInfo{}, err
	}
	f, err := os.Open(p)
	if err != nil {
		return demoInfo{}, err
	}
	demo, err := demofile.Parse(f)
	f.Close()
	if err != nil {
		return demoInfo{}, fmt.Errorf("parsing demo %s: %w", r.FileName, err)
	}
	return demoInfo{
		Meta:       demofile.BaseMeta(demo),
		Comms:      demo.Comms,
		SelfD:      demo.SelfDEvents(),
		ModOptions: demo.Startscript.ModOptions,
	}, nil
}

// DemoSelfD is the self-destruct orders in game id's demo, as capture events
// (fetched like Pack's demo metadata). An error wraps ErrDemoUnavailable.
func DemoSelfD(ctx context.Context, client *barapi.Client, id string) ([]snapshot.Event, error) {
	d, err := demoMeta(ctx, client, id)
	if err != nil {
		return nil, fmt.Errorf("fetching the demo for %q: %w: %v", id, ErrDemoUnavailable, err)
	}
	return d.SelfD, nil
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
	var demoComms []snapshot.Comm
	var demoSelfD []snapshot.Event
	ext := strings.ToLower(filepath.Ext(in))
	if (ext == ".brsnap" || ext == ".brepstream") && !noDemo {
		id := idArg
		if id == "" {
			id = gameID
		}
		d, err := demoMeta(ctx, client, id)
		if err != nil {
			return "", nil, fmt.Errorf("fetching demo metadata for %q: %w: %v (pass -id <gameId|link> if the file name is not the gameId, or -no-demo to pack without map/version/player metadata)", id, ErrDemoUnavailable, err)
		}
		fmt.Fprintf(os.Stderr, "%s: demo metadata: map %q, game %q, engine %s, %d players, %d comms\n",
			in, d.Meta.MapName, d.Meta.GameVersion, d.Meta.EngineVersion, len(d.Meta.Players), len(d.Comms))
		base = d.Meta
		modOptions = d.ModOptions
		demoComms = d.Comms
		demoSelfD = d.SelfD
	}
	l, err := load(in, base)
	if err != nil {
		return "", nil, err
	}
	// The demo's chat and drawings supersede the stream's: complete, and framed
	// exactly (capture.ReplaceComms explains why). Only when it yielded some —
	// an empty result cannot be told apart from a truncated packet stream.
	if len(demoComms) > 0 {
		l.comms = demoComms
	}
	l.events = snapshot.MergeEvents(l.events, demoSelfD)
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
	for _, c := range l.comms {
		if err := w.WriteComm(c); err != nil {
			w.Close()
			return "", nil, err
		}
	}
	if err := l.writeAnalysis(w); err != nil {
		w.Close()
		return "", nil, err
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
	fmt.Fprintf(os.Stderr, "%s (%.1f MB) -> %s (%.2f MB%s): %d frames, %d events, %d comms\n",
		in, mb(inSize), outPath, mb(outSize), ratio, len(l.frames), len(l.events), len(l.comms))
	return outPath, modOptions, nil
}

// ContentRev derives a revision id: the first 8 hex chars of a file's SHA-256.
//
// Publishers hash the PACKED .brp, not the capture stream it came from, and
// the difference is the whole point. The stream identifies the recording; the
// .brp identifies the BYTES the viewer will actually fetch. Keying on the
// stream meant re-packing an unchanged capture — a codec change, a packer fix,
// or the same stream packed once with the demo metadata and once with
// -no-demo — produced different pieces under the SAME keys, silently
// overwriting objects that /replays/* serves as immutable. Behind an edge
// cache that is not a cosmetic problem: the stale bytes are then served for a
// year.
//
// The .brp writer is deterministic (same capture + same packer = byte-identical
// file), so this keeps re-publishing idempotent — an unchanged republish still
// lands on the same keys — while anything that actually changes the bytes gets
// a fresh revision and leaves the old one untouched. That is what makes the
// immutable cache-control on /replays/* truthful rather than a hazard.
func ContentRev(path string) (string, error) {
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
	// "<gameId>-<rev>" (see ContentRev) and records it as the catalog row's
	// rid. Empty publishes under the bare gameId (the pre-revisioning
	// layout). Nothing is ever deleted either way — superseded revisions
	// stay servable.
	Rev string
	// ModOptions is the demo startscript's raw [modoptions] map (nil when
	// packed with noDemo); it contributes the catalog's settings flags.
	ModOptions map[string]string
	// View overrides the point of view the catalog records for this publish
	// ("full", "ally" or "unknown"; empty leaves it to the capture). Only a
	// LIVE capture states its own provenance — the widget's recorder record,
	// which viz.BuildCatalogEntry reads — so a re-simulated capture, which by
	// construction saw every team, has to declare "full" here. Without it the
	// row would keep the marking of the one-sided upload it just superseded.
	View string
	// Ally names the side that recorded this publish when View is "ally" and
	// the publisher, not the capture, decided it (bringest's frame check:
	// ViewFromFrames). Nil keeps the side the capture's recorder record names.
	Ally *int32
	// BarAPI, when set, supplies the game's start time for its month folder
	// when the capture has none (a no-demo pack). Nil skips the lookup, and
	// such a replay goes under UndatedFolder.
	BarAPI *barapi.Client
}

// UploadStatic uploads one packed replay's static files to the worker's R2
// bucket: it writes the static bundle (viz.WriteStaticBundle — the same bytes
// cmd/barreplay-static writes) into a temp dir and uploads it. Transports,
// fastest first:
//
//   - "r2" with R2 API credentials in the environment (R2_ACCESS_KEY_ID +
//     R2_SECRET_ACCESS_KEY): NATIVE Go — concurrent SigV4 PUTs straight
//     against the bucket's S3 endpoint (r2.go), no node tooling involved.
//   - "local": concurrent PUTs through the dev worker's own bearer-guarded
//     PUT /replays/* route (the vite/wrangler dev server binds the simulator
//     bucket) — milliseconds, vs ~1s of node startup per object through
//     `wrangler r2 object put`.
//   - fallback (r2 without credentials, or the local dev server not
//     reachable): shell the worker's uploader (npx tsx tools/upload.ts).
//
// With a Rev the key follows names.go: replays/<YYYY-MM>/<gameId>.brp when
// the capture saw every team and the game has no main replay yet, else
// replays/<YYYY-MM>/<gameId>-<rev>.brp. The main name is claimed with a
// conditional PUT, so losing a race (or a catalog that did not know) falls
// back to the suffixed name instead of overwriting; a full view whose bytes
// ARE the main's uploads nothing and only re-registers.
//
// After the upload it registers the replay in the worker's catalog (the
// Durable Object SQLite table behind GET /api/replays) via
// PUT <IndexURL>/api/replays/<id>.
func UploadStatic(ctx context.Context, brpPath string, o UploadOptions) error {
	var native *R2Client
	if o.Target == "r2" {
		native = r2ClientFromEnv(o.WorkerDir)
	}
	meta, err := brpMeta(brpPath)
	if err != nil {
		return err
	}
	gameID := meta.GameID
	tmp, err := os.MkdirTemp("", "pack-upload-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	var rid string
	var size int64
	if o.Rev == "" {
		// -rev=false: the pre-revisioning layout, flat under the bare id, and
		// no rid on the row.
		if _, size, err = publishBundle(ctx, o, native, tmp, brpPath, "", gameID, false); err != nil {
			return err
		}
	} else {
		folder := replayFolder(ctx, o, meta)
		suffixed := gameID + "-" + o.Rev
		name, claimMain := suffixed, false
		if CapturesAllTeams(meta, o.View) {
			main, err := existingMain(ctx, o.IndexURL, gameID)
			if err != nil {
				// The conditional PUT still guards an existing main.
				fmt.Fprintf(os.Stderr, "%s: could not ask the catalog for a main replay (%v); trying the main name conditionally\n", gameID, err)
			}
			switch {
			case main != nil && main.rev == o.Rev:
				fmt.Fprintf(os.Stderr, "%s: identical to the main replay %s; nothing to upload\n", gameID, main.rid)
				rid = main.rid
			case main != nil:
				fmt.Fprintf(os.Stderr, "%s: main replay %s already exists; publishing this full view as %s\n", gameID, main.rid, suffixed)
			default:
				name, claimMain = gameID, true
			}
		}
		if rid == "" {
			rid, size, err = publishBundle(ctx, o, native, tmp, brpPath, folder, name, claimMain)
			if errors.Is(err, errObjectExists) {
				fmt.Fprintf(os.Stderr, "%s: replays/%s/%s.brp appeared meanwhile; publishing as %s\n", gameID, folder, gameID, suffixed)
				rid, size, err = publishBundle(ctx, o, native, tmp, brpPath, folder, suffixed, false)
			}
			if err != nil {
				return err
			}
		} else {
			size = fileSize(brpPath)
		}
	}

	if o.IndexURL == "" {
		// Unreachable from the CLIs, which resolve IndexURL from -upload via
		// LookupTarget and so always have one; kept for a caller that builds
		// UploadOptions by hand and leaves it empty.
		fmt.Fprintf(os.Stderr, "%s: uploaded, but NOT registered in the replay catalog: the caller set no IndexURL\n", gameID)
		return nil
	}
	if err := putCatalogEntry(ctx, o.IndexURL, gameID, rid, o.Rev, brpPath, size, o.ModOptions, o.View, o.Ally); err != nil {
		return fmt.Errorf("registering %s in the replay catalog at %s: %w", gameID, o.IndexURL, err)
	}
	fmt.Fprintf(os.Stderr, "%s: registered in the replay catalog at %s\n", gameID, o.IndexURL)
	return nil
}

// publishBundle writes brpPath's static bundle under replays/<folder>/<name>
// (flat when folder is empty) and uploads it, returning the rid — the key
// relative to replays/, without the extension — and the bundle's byte size.
// claimMain writes the .brp with a conditional PUT first and returns
// errObjectExists, uploading nothing, when the key is already taken.
func publishBundle(ctx context.Context, o UploadOptions, native *R2Client, tmp, brpPath, folder, name string, claimMain bool) (string, int64, error) {
	stage, err := os.MkdirTemp(tmp, "stage-")
	if err != nil {
		return "", 0, err
	}
	// The bundle's file names come from the source .brp's basename.
	src := filepath.Join(stage, name+".brp")
	if err := copyFile(brpPath, src); err != nil {
		return "", 0, err
	}
	out := filepath.Join(stage, "out")
	if _, err := viz.WriteStaticBundleWith(src, out, o.ModOptions); err != nil {
		return "", 0, err
	}
	bundleDir := filepath.Join(stage, "bundle")
	rid, dest := name, filepath.Join(bundleDir, "replays")
	if folder != "" {
		rid, dest = folder+"/"+name, filepath.Join(bundleDir, "replays", folder)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", 0, err
	}
	if err := os.Rename(filepath.Join(out, "replays"), dest); err != nil {
		return "", 0, err
	}
	size := dirSize(bundleDir)
	if claimMain {
		brp := filepath.Join(dest, name+".brp")
		body, err := os.ReadFile(brp)
		if err != nil {
			return "", 0, err
		}
		created, supported, err := putIfAbsent(ctx, o, native, "replays/"+rid+".brp", body)
		if err != nil {
			return "", 0, err
		}
		if supported && !created {
			return "", 0, errObjectExists
		}
		if created {
			// Already in the bucket; the rest of the bundle follows it.
			if err := os.Remove(brp); err != nil {
				return "", 0, err
			}
		}
	}
	if err := uploadDir(ctx, o, native, bundleDir, rid); err != nil {
		return "", 0, err
	}
	return rid, size, nil
}

// brpMeta reads a .brp's meta, with GameID always filled: the meta's own id,
// which the file name is not — a published revision downloaded for a
// republish is named "<gameId>-<rev>.brp", and taking that as the id
// registered it as a new game. The name is only the fallback for a meta with
// no id.
func brpMeta(path string) (snapshot.Meta, error) {
	f, err := os.Open(path)
	if err != nil {
		return snapshot.Meta{}, err
	}
	defer f.Close()
	bf, err := snapshot.ParseBRP(f)
	if err != nil {
		return snapshot.Meta{}, fmt.Errorf("parse %s: %w", path, err)
	}
	m := bf.Meta
	if m.GameID == "" {
		m.GameID = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	return m, nil
}

// UploadPieces uploads every file under bundleDir to the target's bucket,
// keyed by its path relative to bundleDir ("replays/<rid>.insights<N>.json"),
// through the same transports as UploadStatic. It registers nothing in the
// catalog: it adds pieces beside a replay that is already published.
func UploadPieces(ctx context.Context, o UploadOptions, bundleDir, label string) error {
	var native *R2Client
	if o.Target == "r2" {
		native = r2ClientFromEnv(o.WorkerDir)
	}
	return uploadDir(ctx, o, native, bundleDir, label)
}

// uploadDir is UploadStatic's transport choice: native S3 when credentials
// are present, the dev worker's PUT route for "local", else the worker
// project's node uploader.
func uploadDir(ctx context.Context, o UploadOptions, native *R2Client, bundleDir, uploadID string) error {
	uploaded := false
	if native != nil {
		fmt.Fprintf(os.Stderr, "uploading %q to %s/%s (native S3, %d in flight)\n",
			uploadID, native.Endpoint, native.Bucket, uploadConcurrency)
		if err := native.UploadBundle(ctx, bundleDir); err != nil {
			return fmt.Errorf("uploading %s: %w", uploadID, err)
		}
		uploaded = true
	} else if o.Target == "local" && o.IndexURL != "" {
		fmt.Fprintf(os.Stderr, "uploading %q via the dev worker at %s\n", uploadID, o.IndexURL)
		err := uploadBundle(ctx, bundleDir, func(ctx context.Context, key string, body []byte) error {
			return workerPut(ctx, o.IndexURL, key, body, false)
		})
		if err == nil {
			uploaded = true
		} else if ctx.Err() != nil {
			return err
		} else {
			// Dev server down or an older worker without the route: the wrangler
			// path writes the simulator's state directly, so fall through to it.
			fmt.Fprintf(os.Stderr, "worker-route upload failed (%v); falling back to wrangler\n", err)
		}
	}
	if !uploaded {
		// The node-tooling path needs the worker project on disk.
		if err := checkWorkerDir(o.WorkerDir); err != nil {
			return err
		}
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
//
// view overrides the capture's own point of view (UploadOptions.View); empty
// keeps whatever the .brp's recorder record implies, and an entry with no view
// at all leaves the row's existing marking alone (the worker COALESCEs it).
func putCatalogEntry(ctx context.Context, indexURL, gameID, rid, rev, brpPath string, sizeBytes int64, modOptions map[string]string, view string, ally *int32) error {
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
		entry.Rev = rev
	}
	entry.Settings = viz.SettingsFlags(modOptions)
	if view != "" {
		entry.View = view
		// "ally" is the only view that names a side, so any other override is
		// also a statement that no single side recorded this revision.
		if view != "ally" {
			entry.UploaderAlly = nil
		} else if ally != nil {
			entry.UploaderAlly = ally
		}
	}
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

// AddDemoOrders gives an already-packed .brp the self-destruct orders out of
// its game's demo (snapshot.AddEventsBRP), writing the result to outDir (a
// temp dir when empty) and returning its path — or the input's own path when
// there is nothing to add, which includes a file that already has them. It is
// what lets a replay packed before orders were read get them with no
// re-simulation. It also returns the demo's modoptions, which a .brp does not
// store and the catalog's settings flags and the summary's win model need.
func AddDemoOrders(ctx context.Context, client *barapi.Client, in, outDir, idArg string) (string, map[string]string, error) {
	f, err := os.Open(in)
	if err != nil {
		return "", nil, err
	}
	bf, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		return "", nil, fmt.Errorf("%s: %w", in, err)
	}
	id := idArg
	if id == "" {
		id = bf.Meta.GameID
	}
	if id == "" {
		return "", nil, fmt.Errorf("%s: no gameId in its meta (pass -id)", in)
	}
	d, err := demoMeta(ctx, client, id)
	if err != nil {
		return "", nil, fmt.Errorf("fetching the demo for %q: %w: %v", id, ErrDemoUnavailable, err)
	}
	if len(d.SelfD) == 0 {
		return in, d.ModOptions, nil
	}
	if outDir == "" {
		if outDir, err = os.MkdirTemp("", "barreplay-orders-"); err != nil {
			return "", nil, err
		}
	}
	out := filepath.Join(outDir, filepath.Base(in))
	ai, _ := filepath.Abs(in)
	ao, _ := filepath.Abs(out)
	if ai == ao {
		return "", nil, fmt.Errorf("%s: -out would overwrite the input", in)
	}
	src, err := os.Open(in)
	if err != nil {
		return "", nil, err
	}
	defer src.Close()
	dst, err := os.Create(out)
	if err != nil {
		return "", nil, err
	}
	n, err := snapshot.AddEventsBRP(src, dst, d.SelfD)
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(out)
		return "", nil, err
	}
	if n == 0 {
		os.Remove(out)
		return in, d.ModOptions, nil
	}
	fmt.Fprintf(os.Stderr, "%s: added %d self-destruct orders from the demo -> %s\n", in, n, out)
	return out, d.ModOptions, nil
}
