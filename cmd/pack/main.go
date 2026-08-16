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
// and the top unit defs by encoded bytes (packer.ReportStats over
// snapshot.ComputeBRPStats), with per-instance cost so a def that is merely
// numerous stands apart from one that is expensive per unit. A .brp input is
// analyzed as-is; raw captures are packed first and the fresh .brp analyzed.
// cmd/bringest prints the same report for every replay it publishes.
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
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/packer"
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
			err = packer.ReportStats(os.Stdout, brpPath)
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
