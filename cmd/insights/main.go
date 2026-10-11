// Command insights computes a published replay's game summary
// (internal/insights) and publishes it beside the replay as
// replays/<rid>.insights<N>.json, the one file the viewer's Summary tab reads.
//
// It exists for replays published before the summary did: their .brp was
// never kept, only the split pieces the viewer streams (.brw, .keys, c<n>,
// .resources), so the replay is rebuilt from those (viz.ReadStaticBundle). A
// revision whose .brp is in the bucket (every publish since pieces became
// Range reads of the .brp) is read whole instead, which prices every unit;
// rebuilt from pieces, only armed mobile units carry a cost, and the file
// says so (costCoverage "army").
//
// Usage:
//
//	insights <gameId|link|rid> [...]       # compute + publish to r2
//	insights -upload local <gameId>        # ...to the dev simulator
//	insights -upload= -out ./ins <gameId>  # compute only, write the file locally
//	insights -all                          # every replay in the catalog, 4 at a time (-j)
//	insights -all -from 2026-10-01 -to 2026-10-07   # games started in that range
//	insights ./snapshots/<gameId>.brp      # from a local .brp (full costs)
//	insights -rid <rid> ./caps/<gameId>.brepstream   # repack a raw stream (full costs)
//
// A gameId or link is resolved to the catalog row's current revision, and
// the row's view (whose point of view the capture is) is carried into the
// file, since a rebuilt replay has no recorder record of its own. A revision
// that already has an insights file is skipped unless -force (with -upload=
// the published file is saved to -out instead): pieces are immutable, and a
// changed computation is a new version with a new name, so recomputing the
// same version can only produce the same bytes.
//
// A replay whose meta does not name the winner (every .brp packed before the
// demo's winners were read, and every replay rebuilt from pieces) asks the BAR
// API for it.
//
// A local capture is the way back to full costs for a replay that was only
// published as pieces: a drag&drop upload's raw stream is archived, so pack
// it again (a .brepstream input is packed here, demo fetch included)
// and name the published revision with -rid. Without -rid it is the catalog
// upload whose content rev matches the .brp (packer.ContentRev) — which is
// how a main replay, whose rid does not spell its rev, is found — and failing
// that the flat <gameId>-<rev> of a publish from before month folders.
//
// Everything read from the bucket is kept on disk (-cache; by default under
// the user cache dir, for the real bucket only), so running this over the
// whole catalog again, or once more with -upload= to collect the files for
// cmd/winfit, downloads only what the last run did not. The bucket never
// rewrites a published object, so a kept copy is never stale.
//
// The work itself is internal/insightsrun, shared with cmd/bringest, which
// recomputes a summary on demand when the viewer opens a replay whose summary
// is older than the page.
//
// -upload names a destination exactly as cmd/pack does (packer.LookupTarget):
// the catalog it reads, the bucket it reads pieces from and the bucket it
// writes to are one choice. $REPLAY_PUT_TOKEN and the R2 credentials work as
// they do for pack.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/mabn/barreplay/internal/insightsrun"
	"github.com/mabn/barreplay/internal/packer"
)

func main() {
	var (
		upload    = flag.String("upload", "r2", "read the replay from, and publish its summary to, "+packer.TargetHelp()+". Empty computes only, writing the file to -out")
		outDir    = flag.String("out", ".", "with -upload= (empty): where to write replays/<rid>.insights<N>.json")
		force     = flag.Bool("force", false, "recompute even when the revision already has an insights file")
		all       = flag.Bool("all", false, "process every replay in the catalog (no arguments)")
		workerDir = flag.String("worker-dir", "worker", "the Cloudflare worker project directory (upload fallback)")
		from      = flag.String("from", "", "with -all: only games that started on/after this date (YYYY-MM-DD or unix seconds)")
		to        = flag.String("to", "", "with -all: only games that started on/before this date (YYYY-MM-DD covers the whole day, or unix seconds)")
		ridFlag   = flag.String("rid", "", "with a local capture: the published revision the summary belongs to (default: the packed .brp's own content revision)")
		jobs      = flag.Int("j", 4, "replays processed at once (each holds one whole replay in memory)")
		cacheFlag = flag.String("cache", "auto", "keep files read from the bucket here for the next run (in a subdirectory per bucket host); empty keeps none, auto is "+insightsrun.AutoCacheHelp())
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: insights [flags] <gameId|link|rid|file.brp> [...]\n       insights [flags] -all\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *all == (flag.NArg() > 0) {
		flag.Usage()
		os.Exit(2)
	}
	// The catalog and the pieces are read from the destination even when
	// nothing is published, so -upload= still needs one to read from.
	targetName := *upload
	if targetName == "" {
		targetName = "r2"
	}
	target, ok := packer.LookupTarget(targetName)
	if !ok {
		fmt.Fprintf(os.Stderr, "insights: -upload %q: must be %s, or empty\n", *upload, packer.TargetList())
		os.Exit(2)
	}
	if (*from != "" || *to != "") && !*all {
		fmt.Fprintln(os.Stderr, "insights: -from/-to narrow -all; pass them with -all")
		os.Exit(2)
	}
	for _, d := range []string{*from, *to} {
		if d != "" && !insightsrun.ValidDate(d) {
			fmt.Fprintf(os.Stderr, "insights: %q: want YYYY-MM-DD or unix seconds\n", d)
			os.Exit(2)
		}
	}
	if *ridFlag != "" && flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "insights: -rid names ONE capture's revision; pass exactly one input")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	r := insightsrun.New(insightsrun.Options{
		Target:    target,
		Publish:   *upload != "",
		WorkerDir: *workerDir,
		OutDir:    *outDir,
		Force:     *force,
		LocalRid:  *ridFlag,
		From:      *from,
		To:        *to,
		Cache:     *cacheFlag,
	})
	args := flag.Args()
	if *all {
		var err error
		if args, err = r.CatalogRids(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "insights: listing the catalog: %v\n", err)
			os.Exit(1)
		}
	}
	if *jobs < 1 {
		*jobs = 1
	}
	failed := r.Each(ctx, args, *jobs)
	if s := r.CacheSummary(); s != "" {
		fmt.Fprintln(os.Stderr, s)
	}
	if failed > 0 || ctx.Err() != nil {
		os.Exit(1)
	}
}
