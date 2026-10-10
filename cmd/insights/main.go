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
// -upload names a destination exactly as cmd/pack does (packer.LookupTarget):
// the catalog it reads, the bucket it reads pieces from and the bucket it
// writes to are one choice. $REPLAY_PUT_TOKEN and the R2 credentials work as
// they do for pack.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/insights"
	"github.com/mabn/barreplay/internal/packer"
	"github.com/mabn/barreplay/internal/viz"
	"github.com/mabn/barreplay/snapshot"
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	r := &runner{
		indexURL: target.IndexURL,
		dataURL:  target.DataURL,
		http:     &http.Client{Timeout: 2 * time.Minute},
		force:    *force,
		outDir:   *outDir,
		localRid: *ridFlag,
		winners: func(ctx context.Context, gameID string) ([]int32, error) {
			rep, err := barapi.New().Resolve(ctx, gameID)
			if err != nil {
				return nil, err
			}
			return rep.Winners(), nil
		},
	}
	if (*from != "" || *to != "") && !*all {
		fmt.Fprintln(os.Stderr, "insights: -from/-to narrow -all; pass them with -all")
		os.Exit(2)
	}
	for _, d := range []string{*from, *to} {
		if d != "" && !validDate(d) {
			fmt.Fprintf(os.Stderr, "insights: %q: want YYYY-MM-DD or unix seconds\n", d)
			os.Exit(2)
		}
	}
	r.from, r.to = *from, *to
	if *ridFlag != "" && flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "insights: -rid names ONE capture's revision; pass exactly one input")
		os.Exit(2)
	}
	if *upload != "" {
		r.publish = func(ctx context.Context, dir, label string) error {
			return packer.UploadPieces(ctx, packer.UploadOptions{Target: target.Name, IndexURL: target.IndexURL, WorkerDir: *workerDir}, dir, label)
		}
	}
	args := flag.Args()
	if *all {
		var err error
		if args, err = r.catalogRids(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "insights: listing the catalog: %v\n", err)
			os.Exit(1)
		}
	}
	if *jobs < 1 {
		*jobs = 1
	}
	if failed := r.each(ctx, args, *jobs); failed > 0 || ctx.Err() != nil {
		os.Exit(1)
	}
}

// each processes args with up to jobs of them in flight and returns how many
// failed. Every replay is independent (its own fetches, compute and upload),
// and a run over the catalog is mostly waiting on downloads and uploads, so
// a few at once is most of the speed-up; more mainly costs memory, since each
// holds a whole replay. Output lines from different replays interleave, but
// every one names its replay.
func (r *runner) each(ctx context.Context, args []string, jobs int) int {
	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		failed int
	)
	work := make(chan string)
	for range min(jobs, len(args)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for a := range work {
				if err := r.one(ctx, a); err != nil {
					fmt.Fprintf(os.Stderr, "insights: %s: %v\n", a, err)
					mu.Lock()
					failed++
					mu.Unlock()
				}
			}
		}()
	}
	for _, a := range args {
		if ctx.Err() != nil {
			break
		}
		work <- a
	}
	close(work)
	wg.Wait()
	return failed
}

// runner holds what every replay is processed with. publish is nil when
// nothing is uploaded; the file is then written under outDir.
type runner struct {
	indexURL, dataURL string
	// from/to narrow -all to games started in a date range, passed verbatim
	// to the catalog's own filter (YYYY-MM-DD or unix seconds; a date `to`
	// covers that whole day).
	from, to string
	http     *http.Client
	force    bool
	outDir   string
	localRid string // -rid: the revision a local capture's summary is published under
	publish  func(ctx context.Context, dir, label string) error
	// winners asks the BAR API who won, for a replay whose meta does not say
	// (every .brp packed before the demo's winners were read). Nil skips it.
	winners func(ctx context.Context, gameID string) ([]int32, error)
}

// catalogRow is the part of a GET /api/replays row this command reads.
type catalogRow struct {
	ID          string  `json:"id"`
	Rid         *string `json:"rid"`
	View        *string `json:"view"`
	Placeholder bool    `json:"placeholder"`
	Uploads     []struct {
		Rid string `json:"rid"`
		Rev string `json:"rev"`
	} `json:"uploads"`
}

func (c catalogRow) rid() string {
	if c.Rid != nil && *c.Rid != "" {
		return *c.Rid
	}
	return c.ID
}

func (c catalogRow) view() string {
	if c.View != nil {
		return *c.View
	}
	return ""
}

// ridRE matches a revision id: a gameId plus the 8-hex content revision.
var ridRE = regexp.MustCompile(`^[0-9a-f]{32}-[0-9a-f]{8}$`)

// one processes one argument: a local .brp, a revision id, or anything
// barapi.ParseGameID reads as a game.
func (r *runner) one(ctx context.Context, arg string) error {
	switch filepath.Ext(arg) {
	case ".brp":
		return r.local(ctx, arg)
	case ".brepstream":
		dir, err := os.MkdirTemp("", "insights-pack-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		brp, _, err := packer.Pack(ctx, barapi.New(), arg, dir, "", false)
		if errors.Is(err, packer.ErrDemoUnavailable) {
			fmt.Fprintf(os.Stderr, "%s: demo unavailable (%v); packing without it\n", arg, err)
			brp, _, err = packer.Pack(ctx, barapi.New(), arg, dir, "", true)
		}
		if err != nil {
			return err
		}
		return r.local(ctx, brp)
	}
	var rid, view string
	if ridRE.MatchString(arg) {
		rid = arg
		row, err := r.catalogRow(ctx, arg[:32])
		if err != nil {
			return err
		}
		// The row's view describes its CURRENT revision; an older one keeps
		// whatever its own upload knew, which nothing here can recover.
		if row != nil && row.rid() == rid {
			view = row.view()
		}
	} else {
		id, err := barapi.ParseGameID(arg)
		if err != nil {
			return err
		}
		row, err := r.catalogRow(ctx, id)
		if err != nil {
			return err
		}
		if row == nil {
			return fmt.Errorf("game %s is not in the catalog at %s", id, r.indexURL)
		}
		if row.Placeholder {
			return fmt.Errorf("game %s has nothing published yet", id)
		}
		rid, view = row.rid(), row.view()
	}
	return r.rid(ctx, rid, view)
}

// rid computes and publishes one published revision's summary.
func (r *runner) rid(ctx context.Context, rid, view string) error {
	name := insights.FileName(rid)
	if !r.force {
		if b, err := r.fetch(ctx, "replays/"+name); err == nil {
			if r.publish != nil {
				fmt.Fprintf(os.Stderr, "%s: already published, skipping (-force recomputes)\n", name)
				return nil
			}
			// Compute-only mode collects files (e.g. for cmd/winfit), so the
			// published one is saved as is: recomputing would give the same.
			path := filepath.Join(r.outDir, "replays", name)
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "%s: already published, saved to %s (-force recomputes)\n", name, path)
			return os.WriteFile(path, b, 0o644)
		} else if !errors.Is(err, viz.ErrNotFound) {
			return err
		}
	}
	var in insights.Input
	if b, err := r.fetch(ctx, "replays/"+rid+".brp"); err == nil {
		bf, err := snapshot.ParseBRP(bytes.NewReader(b))
		if err != nil {
			return fmt.Errorf("%s.brp: %w", rid, err)
		}
		if in, err = insights.FromBRP(bf); err != nil {
			return err
		}
		if view == insights.POVAlly || view == insights.POVFull {
			in.POV = view
		}
		fmt.Fprintf(os.Stderr, "%s: read from its .brp\n", rid)
	} else if errors.Is(err, viz.ErrNotFound) {
		bf, res, err := viz.ReadStaticBundle(ctx, r.fetch, rid)
		if err != nil {
			return err
		}
		if in, err = insights.FromPieces(bf, res, view); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "%s: rebuilt from %d published chunks (army costs only)\n", rid, len(bf.Chunks))
	} else {
		return err
	}
	return r.write(ctx, rid, in)
}

// local computes the summary of a .brp on disk, under the revision id a
// publish of that same file gets (packer.ContentRev of the packed bytes).
func (r *runner) local(ctx context.Context, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	bf, err := snapshot.ParseBRP(f)
	if err != nil {
		return err
	}
	rid := r.localRid
	if rid == "" {
		rev, err := packer.ContentRev(path)
		if err != nil {
			return err
		}
		rid = bf.Meta.GameID + "-" + rev
		if r.indexURL != "" {
			if row, err := r.catalogRow(ctx, bf.Meta.GameID); err == nil && row != nil {
				for _, u := range row.Uploads {
					if u.Rev == rev {
						rid = u.Rid
					}
				}
			}
		}
	}
	in, err := insights.FromBRP(bf)
	if err != nil {
		return err
	}
	return r.write(ctx, rid, in)
}

func (r *runner) write(ctx context.Context, rid string, in insights.Input) error {
	if len(in.Meta.Winners) == 0 && r.winners != nil && in.Meta.GameID != "" {
		// Unknown winners only cost the summary its result line, so a failed
		// lookup is a warning.
		if w, err := r.winners(ctx, in.Meta.GameID); err != nil {
			fmt.Fprintf(os.Stderr, "%s: winner unknown (BAR API: %v)\n", rid, err)
		} else {
			in.Meta.Winners = w
		}
	}
	ins, err := insights.Compute(in)
	if err != nil {
		return err
	}
	b, err := insights.Marshal(ins)
	if err != nil {
		return err
	}
	dir := r.outDir
	if r.publish != nil {
		if dir, err = os.MkdirTemp("", "insights-"); err != nil {
			return err
		}
		defer os.RemoveAll(dir)
	}
	path := filepath.Join(dir, "replays", insights.FileName(rid))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return err
	}
	winner := "unknown"
	if ins.Winner >= 0 {
		winner = fmt.Sprintf("side %d", ins.Winner+1)
	}
	fmt.Fprintf(os.Stderr, "%s: %d sides, %d deaths, %d milestones, winner %s, %.1f KB (cost coverage %s, view %s)\n",
		rid, len(ins.Sides), len(ins.Deaths.F), len(ins.Milestones), winner, float64(len(b))/1024, ins.CostCoverage, ins.POV)
	if r.publish == nil {
		fmt.Fprintf(os.Stderr, "wrote %s\n", path)
		return nil
	}
	return r.publish(ctx, dir, rid)
}

// fetch GETs one object from the destination's data origin; a 404 is
// viz.ErrNotFound.
func (r *runner) fetch(ctx context.Context, key string) ([]byte, error) {
	return r.get(ctx, strings.TrimRight(r.dataURL, "/")+"/"+key)
}

func (r *runner) get(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := r.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("GET %s: %w", u, viz.ErrNotFound)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", u, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

// catalogRow looks one game up in the catalog; nil when it has no row.
func (r *runner) catalogRow(ctx context.Context, id string) (*catalogRow, error) {
	b, err := r.get(ctx, strings.TrimRight(r.indexURL, "/")+"/api/replays?id="+url.QueryEscape(id))
	if err != nil {
		return nil, err
	}
	var rows []catalogRow
	if err := json.Unmarshal(b, &rows); err != nil {
		return nil, fmt.Errorf("catalog: %w", err)
	}
	for i := range rows {
		if rows[i].ID == id {
			return &rows[i], nil
		}
	}
	return nil, nil
}

// catalogPage is the largest page /api/replays serves (CATALOG_LIMIT_MAX).
const catalogPage = 200

// validDate is the catalog's from/to syntax: YYYY-MM-DD or unix seconds.
func validDate(s string) bool {
	if _, err := time.Parse("2006-01-02", s); err == nil {
		return true
	}
	_, err := strconv.ParseInt(s, 10, 64)
	return err == nil
}

// catalogRids walks the catalog (narrowed to r.from..r.to), page by page, and
// returns every published row's current revision.
func (r *runner) catalogRids(ctx context.Context) ([]string, error) {
	var out []string
	q := url.Values{}
	if r.from != "" {
		q.Set("from", r.from)
	}
	if r.to != "" {
		q.Set("to", r.to)
	}
	for offset := 0; ; offset += catalogPage {
		q.Set("limit", strconv.Itoa(catalogPage))
		q.Set("offset", strconv.Itoa(offset))
		b, err := r.get(ctx, strings.TrimRight(r.indexURL, "/")+"/api/replays?"+q.Encode())
		if err != nil {
			return nil, err
		}
		var rows []catalogRow
		if err := json.Unmarshal(b, &rows); err != nil {
			return nil, fmt.Errorf("catalog: %w", err)
		}
		for _, row := range rows {
			if !row.Placeholder {
				out = append(out, row.rid())
			}
		}
		if len(rows) < catalogPage {
			return out, nil
		}
	}
}
