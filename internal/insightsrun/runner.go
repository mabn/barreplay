// Package insightsrun computes a published replay's game summary
// (internal/insights) and publishes it beside the replay as
// replays/<rid>.insights<N>.json, the one file the viewer's Summary tab reads.
//
// It is the engine of two commands: cmd/insights, the backfill CLI (one
// replay, or the whole catalog with -all), and cmd/bringest, whose insights
// loop recomputes a summary ON DEMAND when the viewer opens a replay whose
// summary is older than the page (or missing). Both read the replay and
// publish through the same destination (packer.LookupTarget): the catalog it
// reads, the bucket it reads pieces from and the bucket it writes to are one
// choice.
//
// A revision whose .brp is in the bucket (every publish since pieces became
// Range reads of the .brp) is read whole, which prices every unit; one
// published before that only exists as the split pieces the viewer streams
// (.brw, .keys, c<n>, .resources) and is rebuilt from those
// (viz.ReadStaticBundle), where only armed mobile units carry a cost, and the
// file says so (costCoverage "army").
//
// A revision that already has an insights file is skipped unless Force:
// pieces are immutable, and a changed computation is a new version with a new
// name, so recomputing the same version can only produce the same bytes.
//
// Every summary asks the BAR API about its game: the lobby settings, which no
// capture stores, say whether it is a lava game and so which win model reads
// it (insights.WinModels), and a replay whose meta does not name the winner
// (every .brp packed before the demo's winners were read, and every replay
// rebuilt from pieces) takes the API's. One packed before the demo's
// self-destruct orders were read gets them from the demo.
package insightsrun

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/insights"
	"github.com/mabn/barreplay/internal/packer"
	"github.com/mabn/barreplay/internal/viz"
	"github.com/mabn/barreplay/snapshot"
)

// Options configures a Runner.
type Options struct {
	// Target is the destination read from (catalog + bucket) and, with
	// Publish, written to.
	Target packer.UploadTarget
	// Publish uploads each summary to Target's bucket; false writes it under
	// OutDir instead (and saves an already-published one there as is).
	Publish bool
	// WorkerDir is the worker project, for the upload fallback.
	WorkerDir string
	OutDir    string
	// Force recomputes a revision that already has an insights file.
	Force bool
	// LocalRid names the published revision a local capture's summary
	// belongs to (default: the packed .brp's own content revision).
	LocalRid string
	// From/To narrow CatalogRids to games started in a date range (the
	// catalog's own from/to syntax: YYYY-MM-DD or unix seconds).
	From, To string
	// Cache is the -cache flag's value: "auto", a directory, or "" for none
	// (see cacheDir).
	Cache string
	// HTTP is the client for the catalog and the bucket; nil is a default
	// with a two-minute timeout.
	HTTP *http.Client
}

// Runner computes and publishes summaries; one is safe for concurrent use
// (Each runs several replays through it at once).
type Runner struct{ r *runner }

// New builds a Runner. The BAR API is asked about every game (winners and
// lobby settings), and the demo for self-destruct orders a capture lacks.
func New(o Options) *Runner {
	r := &runner{
		indexURL: o.Target.IndexURL,
		dataURL:  o.Target.DataURL,
		http:     o.HTTP,
		force:    o.Force,
		outDir:   o.OutDir,
		localRid: o.LocalRid,
		from:     o.From,
		to:       o.To,
		game: func(ctx context.Context, gameID string) (gameFacts, error) {
			rep, err := barapi.New().Resolve(ctx, gameID)
			if err != nil {
				return gameFacts{}, err
			}
			return gameFacts{Winners: rep.Winners(), Settings: rep.Settings()}, nil
		},
		orders: func(ctx context.Context, gameID string) ([]snapshot.Event, error) {
			return packer.DemoSelfD(ctx, barapi.New(), gameID)
		},
	}
	if r.http == nil {
		r.http = &http.Client{Timeout: 2 * time.Minute}
	}
	if dir := cacheDir(o.Cache, o.Target); dir != "" {
		r.cache = &objectCache{dir: dir}
	}
	if o.Publish {
		target, workerDir := o.Target, o.WorkerDir
		r.publish = func(ctx context.Context, dir, label string) error {
			return packer.UploadPieces(ctx, packer.UploadOptions{Target: target.Name, IndexURL: target.IndexURL, WorkerDir: workerDir}, dir, label)
		}
	}
	return &Runner{r: r}
}

// One processes one argument: a local .brp or .brepstream, a revision id
// (flat or under a month folder), or anything barapi.ParseGameID reads as a
// game (resolved to the catalog row's current revision).
func (r *Runner) One(ctx context.Context, arg string) error { return r.r.one(ctx, arg) }

// Each processes args with up to jobs of them in flight and returns how many
// failed (each failure is printed).
func (r *Runner) Each(ctx context.Context, args []string, jobs int) int {
	return r.r.each(ctx, args, jobs)
}

// CatalogRids lists every published catalog row's current revision, narrowed
// to Options.From..To.
func (r *Runner) CatalogRids(ctx context.Context) ([]string, error) { return r.r.catalogRids(ctx) }

// CacheSummary is the closing line about the cache, "" without one.
func (r *Runner) CacheSummary() string { return r.r.cache.summary() }

// AutoCacheHelp says where Options.Cache "auto" keeps objects, for a flag's
// help text.
func AutoCacheHelp() string { return autoCacheHelp() }

// ValidDate is the catalog's from/to syntax: YYYY-MM-DD or unix seconds.
func ValidDate(s string) bool { return validDate(s) }

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
	// cache keeps what fetch downloads for the next run; nil keeps nothing.
	cache *objectCache
	// game asks the BAR API about a game (gameFacts). Nil skips it.
	game func(ctx context.Context, gameID string) (gameFacts, error)
	// orders reads the self-destruct orders out of the game's demo, for a
	// capture packed before they were (a .brp with no "selfd" events). Nil
	// skips it.
	orders func(ctx context.Context, gameID string) ([]snapshot.Event, error)
}

// gameFacts is what the BAR API says about a game that a capture may not:
// who won, and the lobby settings (the demo's [modoptions], as gameSettings).
type gameFacts struct {
	Winners  []int32           `json:"winners"`
	Settings map[string]string `json:"settings"`
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

// ridRE matches a revision id: a gameId plus the 8-hex content revision, or
// either form of a publish since month folders (internal/packer/names.go):
// <YYYY-MM>/<gameId>[-<rev>], or undated/... for a game with no start time.
// A bare gameId is not one — that is a game, resolved through the catalog.
var ridRE = regexp.MustCompile(`^(?:[0-9a-f]{32}-[0-9a-f]{8}|(?:[0-9]{4}-[0-9]{2}|undated)/[0-9a-f]{32}(?:-[0-9a-f]{8})?)$`)

// ridGameID is the game a revision id belongs to (ridRE matched).
func ridGameID(rid string) string { return path.Base(rid)[:32] }

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
		row, err := r.catalogRow(ctx, ridGameID(arg))
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
	// The BAR API's half starts now and runs while the replay downloads:
	// whichever way it is read, the lobby settings are not in it.
	l := &lookups{gameID: ridGameID(rid)}
	r.startGame(ctx, l)
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
		// A rebuilt replay knows neither its winners nor its self-destruct
		// orders (pieces were last written before either was read), so the
		// orders are looked up while the pieces download too.
		r.startOrders(ctx, l)
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
	return r.write(ctx, rid, in, l)
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
	return r.write(ctx, rid, in, nil)
}

// gameOrders is r.orders through the cache: a demo never changes, and a
// re-run over the catalog would otherwise download every one of them again
// for a few bytes of orders.
func (r *runner) gameOrders(ctx context.Context, gameID string) ([]snapshot.Event, error) {
	key := "demo-orders/" + gameID + ".json"
	if b, ok := r.cache.get(key); ok {
		var ev []snapshot.Event
		if json.Unmarshal(b, &ev) == nil {
			return ev, nil
		}
	}
	ev, err := r.orders(ctx, gameID)
	if err != nil {
		return nil, err
	}
	if b, err := json.Marshal(ev); err == nil {
		r.cache.put(key, b)
	}
	return ev, nil
}

// hasSelfD is whether a capture's events already carry the demo's
// self-destruct orders.
func hasSelfD(events []snapshot.Event) bool {
	for _, e := range events {
		if e.Kind == snapshot.EventSelfD {
			return true
		}
	}
	return false
}

// lookups is the BAR API's half of a summary — the game's facts and the
// demo's self-destruct orders — fetched in the background; writeWith takes
// what came.
type lookups struct {
	gameID string
	game   chan lookupResult[gameFacts]
	orders chan lookupResult[[]snapshot.Event]
}

type lookupResult[T any] struct {
	v   T
	err error
}

// startGame starts l's game lookup, unless it has one or nothing to ask.
func (r *runner) startGame(ctx context.Context, l *lookups) {
	if r.game == nil || l.game != nil || l.gameID == "" {
		return
	}
	l.game = make(chan lookupResult[gameFacts], 1)
	go func() {
		g, err := r.gameFacts(ctx, l.gameID)
		l.game <- lookupResult[gameFacts]{g, err}
	}()
}

// startOrders starts l's orders lookup, unless it has one or nothing to ask.
func (r *runner) startOrders(ctx context.Context, l *lookups) {
	if r.orders == nil || l.orders != nil || l.gameID == "" {
		return
	}
	l.orders = make(chan lookupResult[[]snapshot.Event], 1)
	go func() {
		ev, err := r.gameOrders(ctx, l.gameID)
		l.orders <- lookupResult[[]snapshot.Event]{ev, err}
	}()
}

// gameFacts is r.game through the cache: a finished game's winners and
// settings never change.
func (r *runner) gameFacts(ctx context.Context, gameID string) (gameFacts, error) {
	key := "bar-api/" + gameID + ".json"
	if b, ok := r.cache.get(key); ok {
		var g gameFacts
		if json.Unmarshal(b, &g) == nil {
			return g, nil
		}
	}
	g, err := r.game(ctx, gameID)
	if err != nil {
		return gameFacts{}, err
	}
	if b, err := json.Marshal(g); err == nil {
		r.cache.put(key, b)
	}
	return g, nil
}

// write computes and publishes in's summary, with what l (nil: nothing yet)
// has started or now starts asking: the game's facts always, the orders
// when the capture has none.
func (r *runner) write(ctx context.Context, rid string, in insights.Input, l *lookups) error {
	if l == nil || l.gameID != in.Meta.GameID {
		l = &lookups{gameID: in.Meta.GameID}
	}
	r.startGame(ctx, l)
	if !hasSelfD(in.Events) {
		r.startOrders(ctx, l)
	}
	return r.writeWith(ctx, rid, in, l)
}

// writeWith computes, writes and publishes the summary, merging in what
// the lookups found (a nil one, or a nil half of one, asks nothing).
func (r *runner) writeWith(ctx context.Context, rid string, in insights.Input, l *lookups) error {
	if l != nil && l.game != nil && in.Meta.GameID == l.gameID {
		// Unknown facts only cost the summary its result line and the lava
		// model, so a failed lookup is a warning.
		if g := <-l.game; g.err != nil {
			fmt.Fprintf(os.Stderr, "%s: lobby settings unknown, read with the ranked 8v8 model (BAR API: %v)\n", rid, g.err)
		} else {
			if len(in.Meta.Winners) == 0 {
				in.Meta.Winners = g.v.Winners
			}
			in.ModOptions = g.v.Settings
		}
	}
	if l != nil && l.orders != nil && in.Meta.GameID == l.gameID && !hasSelfD(in.Events) {
		// A .brp packed before the demo's orders were read has none, and
		// without them a self-destruct reads as a kill. Best-effort, like
		// the winners: the rest of the summary does not depend on it.
		if o := <-l.orders; o.err != nil {
			fmt.Fprintf(os.Stderr, "%s: self-destructs unknown (%v)\n", rid, o.err)
		} else {
			in.Events = snapshot.MergeEvents(in.Events, o.v)
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
	model := "no swing line"
	if ins.Swing != nil {
		model = ins.Swing.Model + " model"
	}
	fmt.Fprintf(os.Stderr, "%s: %d sides, %d deaths, %d milestones, winner %s, %s, %.1f KB (cost coverage %s, view %s)\n",
		rid, len(ins.Sides), len(ins.Deaths.F), len(ins.Milestones), winner, model, float64(len(b))/1024, ins.CostCoverage, ins.POV)
	if r.publish == nil {
		fmt.Fprintf(os.Stderr, "wrote %s\n", path)
		return nil
	}
	if err := r.publish(ctx, dir, rid); err != nil {
		return err
	}
	// What was just published is what the next run would download to find
	// it published (or, with -upload=, to save to -out).
	r.cache.put("replays/"+insights.FileName(rid), b)
	return nil
}

// fetch GETs one object from the destination's data origin, or reads the
// copy an earlier run kept; a 404 is viz.ErrNotFound.
func (r *runner) fetch(ctx context.Context, key string) ([]byte, error) {
	if b, ok := r.cache.get(key); ok {
		return b, nil
	}
	b, err := r.get(ctx, strings.TrimRight(r.dataURL, "/")+"/"+key)
	if err == nil {
		r.cache.put(key, b)
	}
	return b, err
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
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", u, err)
	}
	// Nothing published here is empty, so an empty 200 is a failed transfer;
	// returning it would get it cached and read as a broken file forever.
	if len(b) == 0 {
		return nil, fmt.Errorf("GET %s: empty body", u)
	}
	return b, nil
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
