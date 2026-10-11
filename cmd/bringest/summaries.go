package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// The ON-DEMAND SUMMARY service. A reader who opens a replay whose game
// summary is older than the viewer reads (or has none) waits for the current
// one: the page POSTs /api/insights, the worker's SummaryHub Durable Object
// (worker/src/worker/summaryhub.ts) hands the request to a daemon holding a
// WebSocket open to it — this — and the daemon computes the summary with
// internal/insightsrun (exactly what `insights -all` runs), publishes it to
// the bucket and answers on the socket; the route then serves the new file.
// No job row, nothing queued anywhere durable: the hub keeps its queue in
// memory and refuses past it, and the page keeps the summary it shows.
//
// Only the UPLOAD daemon runs it. The re-sim worker is an engine host whose
// time belongs to the engine, and a summary needs nothing it has — a .brp from
// the CDN, a demo from the BAR API at most. It dials OUT, so it still runs
// behind NAT, and it reconnects on its own: the hub only ever sees daemons
// that are connected, so a daemon that is down simply means the page keeps
// its older summary.

// summaryService is one daemon's side of the hub protocol. The messages are
// summaryhub.ts's ComputeMessage and ResultMessage.
type summaryService struct {
	// baseURL is the worker (the -upload destination's IndexURL).
	baseURL string
	token   string
	// version is the insights version this build computes; the hub sends
	// only requests for it.
	version int
	// slots is how many summaries are computed at once.
	slots   int
	compute func(ctx context.Context, rid string) error

	pingEvery   time.Duration // keepalive; the hub's runtime answers "pong"
	idleTimeout time.Duration // nothing read for this long = a dead link
	maxBackoff  time.Duration
	computeMax  time.Duration // a stuck computation must not hold a slot forever
}

type computeMsg struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Rid     string `json:"rid"`
	Version int    `json:"version"`
}

type resultMsg struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func newSummaryService(baseURL, token string, version, slots int, compute func(context.Context, string) error) *summaryService {
	return &summaryService{
		baseURL:     strings.TrimRight(baseURL, "/"),
		token:       token,
		version:     version,
		slots:       max(slots, 1),
		compute:     compute,
		pingEvery:   30 * time.Second,
		idleTimeout: 90 * time.Second,
		maxBackoff:  time.Minute,
		computeMax:  5 * time.Minute,
	}
}

func (s *summaryService) connectURL() string {
	q := url.Values{}
	q.Set("version", fmt.Sprint(s.version))
	q.Set("slots", fmt.Sprint(s.slots))
	return s.baseURL + "/api/insights/connect?" + q.Encode()
}

// run holds the connection until ctx ends, reconnecting with backoff. A
// failure to connect is printed once per distinct message, not per attempt:
// a worker deployed before the hub answers 404 every time.
func (s *summaryService) run(ctx context.Context) {
	backoff := time.Second
	lastErr := ""
	for ctx.Err() == nil {
		c, err := wsDial(ctx, s.connectURL(), s.token)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if msg := err.Error(); msg != lastErr {
				lastErr = msg
				fmt.Fprintf(os.Stderr, "bringest: summaries: cannot connect (retrying): %v\n", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, s.maxBackoff)
			continue
		}
		lastErr = ""
		backoff = time.Second
		fmt.Fprintf(os.Stderr, "bringest: summaries: connected, computing insights v%d on demand (%d at once)\n", s.version, s.slots)
		err = s.session(ctx, c)
		if ctx.Err() != nil {
			return
		}
		fmt.Fprintf(os.Stderr, "bringest: summaries: connection lost (%v), reconnecting\n", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
	}
}

// session serves one connection until it drops. Requests run concurrently up
// to slots; the hub never sends more than that, but a misbehaving one is
// held to it here as well.
func (s *summaryService) session(ctx context.Context, c *wsConn) error {
	var (
		mu       sync.Mutex
		lastRead = time.Now()
		wg       sync.WaitGroup
	)
	// Unwound in reverse: drop the link, stop everything started on it
	// (summaries in flight included — the hub has already failed them to
	// their readers), then wait for it all to finish.
	defer wg.Wait()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer c.Close()

	// Keepalive and watchdog: a NAT or proxy that silently drops an idle
	// link would otherwise leave this side waiting forever on a socket the
	// hub no longer has — and the hub, with no daemon, answering every
	// reader "unavailable".
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(s.pingEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				c.rw.Close()
				return
			case <-t.C:
			}
			mu.Lock()
			idle := time.Since(lastRead)
			mu.Unlock()
			if idle > s.idleTimeout {
				c.rw.Close()
				return
			}
			_ = c.WriteMessage(wsText, []byte("ping"))
		}
	}()

	sem := make(chan struct{}, s.slots)
	for {
		op, data, err := c.ReadMessage()
		if err != nil {
			if err == io.EOF {
				return fmt.Errorf("closed by the worker")
			}
			return err
		}
		mu.Lock()
		lastRead = time.Now()
		mu.Unlock()
		if op != wsText || string(data) == "pong" {
			continue
		}
		var m computeMsg
		if json.Unmarshal(data, &m) != nil || m.Type != "compute" || m.ID == "" {
			continue
		}
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			res := s.handle(ctx, m)
			b, _ := json.Marshal(res)
			_ = c.WriteMessage(wsText, b)
		}()
	}
}

func (s *summaryService) handle(ctx context.Context, m computeMsg) resultMsg {
	res := resultMsg{Type: "result", ID: m.ID}
	// The hub dispatches on the version the daemon declared, so this is a
	// hub bug or a protocol drift — said plainly, since it lands on a page.
	if m.Version != s.version {
		res.Error = fmt.Sprintf("asked for insights v%d but this bringest computes v%d", m.Version, s.version)
		return res
	}
	started := time.Now()
	cctx, cancel := context.WithTimeout(ctx, s.computeMax)
	defer cancel()
	if err := s.compute(cctx, m.Rid); err != nil {
		fmt.Fprintf(os.Stderr, "bringest: summaries: %s: failed after %.1fs: %v\n", m.Rid, time.Since(started).Seconds(), err)
		res.Error = err.Error()
		return res
	}
	fmt.Fprintf(os.Stderr, "bringest: summaries: %s: v%d published (%.1fs)\n", m.Rid, s.version, time.Since(started).Seconds())
	res.OK = true
	return res
}
