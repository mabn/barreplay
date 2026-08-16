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
//	pack ./caps/<gameId>.brepstream          # pack, print stats, publish to r2
//	pack -upload local ./caps/*.brepstream   # ...to the dev simulator instead
//	pack -upload= ./caps/*.brsnap            # pack only, publish nothing
//	pack -out ./snapshots ./caps/*.brsnap
//	pack -id 6da7496aca487581a12b7a6d5bd99bc0 ./renamed.brsnap
//	pack -upload= ./snapshots/<gameId>.brp   # analyze an already-packed file
//
// -stats prints a size breakdown of each resulting .brp — per-section sizes
// and the top unit defs by encoded bytes (snapshot.ComputeBRPStats), with
// per-instance cost so a def that is merely numerous stands apart from one
// that is expensive per unit. A .brp input is analyzed as-is; raw captures
// are packed first and the fresh .brp analyzed.
//
// Each input produces "<gameId>.brp" (gameId = the input's basename) in the
// input's own directory, or in -out when set. Inputs are processed
// independently; a failure on one is reported and the rest continue.
//
// -upload names where to PUBLISH, and defaults to "r2" — the whole point of
// packing a capture is to serve it, so the plain invocation does the whole
// job. It uploads each input's packed .brp static-hosting files
// (viz.WriteStaticBundle — the same bytes cmd/barreplay-static writes) to the
// worker's R2 bucket and registers the replay in that worker's catalog; the
// two halves of a destination are chosen together (packer.LookupTarget), never
// separately. "local" targets the `npm run dev` simulator and its dev-server
// catalog; -upload= (empty) packs and reports without publishing anything,
// which is also how to analyze an existing .brp without republishing it.
//
// The viewer serves ONLY the .brp wire format, so every input — including a
// raw .brepstream — is converted first and uploads the efficient v5 pieces. No
// index.json is uploaded — the Worker lists the bucket live. Needs the worker/
// project on disk with node_modules installed (-worker-dir if it is not
// ./worker) and, for "r2", either R2 API credentials (R2_ACCESS_KEY_ID/
// R2_SECRET_ACCESS_KEY, the fast S3 path) or wrangler auth (`npx wrangler
// login` / CLOUDFLARE_API_TOKEN).
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/packer"
	"github.com/mabn/barreplay/snapshot"
)

func main() {
	var (
		outDir    = flag.String("out", "", "output directory (default: next to each input)")
		idArg     = flag.String("id", "", "replay gameId or link used to fetch the demo metadata for a .brsnap/.brepstream input (default: the input's file name; only valid with a single input)")
		noDemo    = flag.Bool("no-demo", false, "do not fetch the demo for .brsnap/.brepstream inputs; the .brp then only has the metadata the stream itself carries")
		upload    = flag.String("upload", "r2", "after packing, publish the replay to "+packer.TargetHelp()+". Empty packs only, uploading nothing")
		workerDir = flag.String("worker-dir", "worker", "the Cloudflare worker project directory wrangler runs in (with -upload)")
		stats     = flag.Bool("stats", true, "print size statistics for each resulting .brp (per-section sizes + the top unit defs by encoded bytes); a .brp input is analyzed directly without repacking")
		rev       = flag.Bool("rev", true, "with -upload: publish under a content-addressed revision id <gameId>-<sha256[:8] of the input> so no served object is ever overwritten (the catalog row's rid tracks the current revision); -rev=false uses the bare gameId")
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
	dest, ok := packer.LookupTarget(*upload)
	if !ok && *upload != "" {
		fmt.Fprintf(os.Stderr, "pack: -upload must be %s, or \"\" to pack without publishing (got %q)\n",
			packer.TargetList(), *upload)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := barapi.New()
	failed := 0
	for _, in := range flag.Args() {
		var brpPath string
		var modOptions map[string]string
		var err error
		if strings.EqualFold(filepath.Ext(in), ".brp") {
			// Already packed: only meaningful to analyze, never to repack.
			brpPath = in
			if !*stats {
				err = fmt.Errorf("input is already a .brp (use -stats to analyze it, or pass the raw .brsnap/.brepstream to pack)")
			}
		} else {
			brpPath, modOptions, err = packer.Pack(ctx, client, in, *outDir, *idArg, *noDemo)
		}
		if err == nil && *stats {
			err = printStats(os.Stdout, brpPath)
		}
		if err == nil && *upload != "" {
			revID := ""
			if *rev {
				// The PACKED file, not the input: two packs of one stream can
				// differ (a codec change, -no-demo vs the demo fetch) and must
				// not land on the same immutable keys.
				revID, err = packer.ContentRev(brpPath)
			}
			if err == nil {
				err = packer.UploadStatic(ctx, brpPath, packer.UploadOptions{
					Target:     *upload,
					WorkerDir:  *workerDir,
					IndexURL:   dest.IndexURL,
					Rev:        revID,
					ModOptions: modOptions,
				})
			}
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

// printStats writes the -stats report for one .brp: totals, per-section
// sizes, and the top unit defs by encoded bytes. Def bytes are RAW (pre-gzip)
// stream bytes — the codec's honest attribution unit; the est.gz column scales
// them by the owning sections' measured compression ratio to approximate the
// on-disk share. Instances (distinct unit lifetimes) divide into bytes/unit so
// "many cheap units" and "few expensive units" read differently.
func printStats(w io.Writer, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	bf, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		return err
	}
	st, err := snapshot.ComputeBRPStats(bf)
	if err != nil {
		return err
	}

	fmt.Fprintf(w, "%s: %s, %d frames, %d events, %d comms, %d unit records, %d chunks\n\n",
		path, fmtBytes(fileSize(path)), bf.FrameCount, bf.EventCount, bf.CommCount, bf.UnitRecords, len(bf.Chunks))

	fmt.Fprintf(w, "%-14s %10s %10s %6s %7s\n", "section", "stored", "raw", "gzip", "file%")
	var stored, coreStored, extraStored int64
	for _, s := range st.Sections {
		stored += s.Stored
		if s.Tag == snapshot.SecKeyframes || s.Tag == snapshot.SecFrames {
			coreStored += s.Stored
		}
		if s.Tag == snapshot.SecExtra {
			extraStored += s.Stored
		}
	}
	for _, s := range st.Sections {
		fmt.Fprintf(w, "%c %-12s %10s %10s %6s %6.1f%%\n",
			s.Tag, s.Name, fmtBytes(s.Stored), fmtBytes(s.Raw), fmtRatio(s.Raw, s.Stored), pct(s.Stored, stored))
	}

	if len(st.Defs) == 0 {
		fmt.Fprintln(w, "\nno unit records")
		return nil
	}
	// est.gz scales each def's raw bytes by its sections' compression ratio.
	coreGz := ratio(coreStored, st.CoreRaw)
	extraGz := ratio(extraStored, st.ExtraRaw)
	streamRaw := st.CoreRaw + st.ExtraRaw
	fmt.Fprintf(w, "\ntop %d unit defs by encoded size (raw stream bytes; est.gz ≈ stored share):\n", min(10, len(st.Defs)))
	fmt.Fprintf(w, "%3s %10s %10s %6s %8s %10s %9s  %s\n", "#", "bytes", "est.gz", "share", "units", "bytes/unit", "records", "def")
	var restBytes int64
	for i, d := range st.Defs {
		raw := d.CoreBytes + d.ExtraBytes
		if i >= 10 {
			restBytes += raw
			continue
		}
		name := d.Name
		if name == "" {
			name = fmt.Sprintf("def %d", d.DefID)
		}
		if d.HumanName != "" {
			name += " (" + d.HumanName + ")"
		}
		perUnit := int64(0)
		if d.Instances > 0 {
			perUnit = raw / d.Instances
		}
		est := int64(float64(d.CoreBytes)*coreGz + float64(d.ExtraBytes)*extraGz)
		fmt.Fprintf(w, "%3d %10s %10s %5.1f%% %8d %10s %9d  %s\n",
			i+1, fmtBytes(raw), fmtBytes(est), pct(raw, streamRaw), d.Instances, fmtBytes(perUnit), d.Records, name)
	}
	if n := len(st.Defs) - 10; n > 0 {
		fmt.Fprintf(w, "    (%d more defs: %s, %.1f%%)\n", n, fmtBytes(restBytes), pct(restBytes, streamRaw))
	}
	fmt.Fprintf(w, "frame framing overhead: %s raw (%.1f%%); team resources: %s raw (%.1f%%)\n",
		fmtBytes(st.OverheadBytes), pct(st.OverheadBytes, streamRaw),
		fmtBytes(st.ResourceBytes), pct(st.ResourceBytes, streamRaw))
	return nil
}

func fmtBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.2f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// fmtRatio renders a raw:stored compression factor like "4.2x".
func fmtRatio(raw, stored int64) string {
	if stored == 0 || raw == 0 {
		return "-"
	}
	return fmt.Sprintf("%.1fx", float64(raw)/float64(stored))
}

func ratio(num, den int64) float64 {
	if den == 0 {
		return 0
	}
	return float64(num) / float64(den)
}

func pct(part, total int64) float64 { return 100 * ratio(part, total) }

func fileSize(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return fi.Size()
}
