package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// fakeHub is the worker's side of /api/insights/connect: it upgrades with
// the server half of the same framing code and lets the test talk to the
// daemon on each connection it accepts.
type fakeHub struct {
	t     *testing.T
	mu    sync.Mutex
	conns chan *wsConn
	query []string
}

func (h *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/insights/connect" || r.Header.Get("Authorization") != "Bearer tok" {
		http.Error(w, "no", http.StatusUnauthorized)
		return
	}
	h.mu.Lock()
	h.query = append(h.query, r.URL.RawQuery)
	h.mu.Unlock()
	conn, rw, err := w.(http.Hijacker).Hijack()
	if err != nil {
		h.t.Error(err)
		return
	}
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + wsAcceptKey(r.Header.Get("Sec-WebSocket-Key")) + "\r\n\r\n")
	_ = rw.Flush()
	h.conns <- &wsConn{rw: conn, br: bufio.NewReader(rw.Reader)}
}

func (h *fakeHub) next(t *testing.T) *wsConn {
	t.Helper()
	select {
	case c := <-h.conns:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("daemon never connected")
		return nil
	}
}

// readResult skips the daemon's keepalives and returns its next answer.
func readResult(t *testing.T, c *wsConn) resultMsg {
	t.Helper()
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if string(data) == "ping" {
			_ = c.WriteMessage(wsText, []byte("pong"))
			continue
		}
		var r resultMsg
		if err := json.Unmarshal(data, &r); err != nil {
			t.Fatalf("not a result: %q", data)
		}
		return r
	}
}

func TestSummaryServiceComputesWhatTheHubSends(t *testing.T) {
	hub := &fakeHub{t: t, conns: make(chan *wsConn, 4)}
	srv := httptest.NewServer(hub)
	defer srv.Close()

	var mu sync.Mutex
	var computed []string
	svc := newSummaryService(srv.URL, "tok", 7, 2, func(_ context.Context, rid string) error {
		mu.Lock()
		computed = append(computed, rid)
		mu.Unlock()
		if rid == "bad" {
			return errors.New("no .brp")
		}
		return nil
	})
	svc.pingEvery = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { svc.run(ctx); close(done) }()

	c := hub.next(t)
	send := func(m computeMsg) {
		b, _ := json.Marshal(m)
		if err := c.WriteMessage(wsText, b); err != nil {
			t.Fatal(err)
		}
	}

	send(computeMsg{Type: "compute", ID: "1", Rid: "2026-10/0123456789abcdef0123456789abcdef", Version: 7})
	if r := readResult(t, c); r.ID != "1" || !r.OK {
		t.Fatalf("result = %+v", r)
	}
	send(computeMsg{Type: "compute", ID: "2", Rid: "bad", Version: 7})
	if r := readResult(t, c); r.ID != "2" || r.OK || r.Error != "no .brp" {
		t.Fatalf("result = %+v", r)
	}
	// A version this build does not compute is refused without computing.
	send(computeMsg{Type: "compute", ID: "3", Rid: "other", Version: 8})
	if r := readResult(t, c); r.ID != "3" || r.OK || r.Error == "" {
		t.Fatalf("result = %+v", r)
	}
	mu.Lock()
	if len(computed) != 2 {
		t.Fatalf("computed %v", computed)
	}
	mu.Unlock()

	// The worker drops the link (a deploy): the daemon comes back on its own.
	c.rw.(net.Conn).Close()
	c2 := hub.next(t)
	c = c2
	send(computeMsg{Type: "compute", ID: "4", Rid: "again", Version: 7})
	if r := readResult(t, c); r.ID != "4" || !r.OK {
		t.Fatalf("after reconnect: %+v", r)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("run did not stop with its context")
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.query[0] != "slots=2&version=7" {
		t.Fatalf("connect query = %q", hub.query[0])
	}
}

func TestSummaryServiceReconnectsOnAnIdleLink(t *testing.T) {
	hub := &fakeHub{t: t, conns: make(chan *wsConn, 4)}
	srv := httptest.NewServer(hub)
	defer srv.Close()
	svc := newSummaryService(srv.URL, "tok", 7, 1, func(context.Context, string) error { return nil })
	svc.pingEvery = 10 * time.Millisecond
	svc.idleTimeout = 50 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go svc.run(ctx)
	// A hub that never answers the keepalive is a dead link: dropped, redialled.
	hub.next(t)
	hub.next(t)
}

func TestWebSocketFraming(t *testing.T) {
	a, b := net.Pipe()
	client := &wsConn{rw: a, br: bufio.NewReader(a), mask: true}
	server := &wsConn{rw: b, br: bufio.NewReader(b)}
	for _, n := range []int{0, 5, 125, 126, 70000} {
		msg := make([]byte, n)
		for i := range msg {
			msg[i] = byte(i)
		}
		go func() { _ = client.WriteMessage(wsText, msg) }()
		op, got, err := server.ReadMessage()
		if err != nil || op != wsText || string(got) != string(msg) {
			t.Fatalf("len %d: op %d err %v, %d bytes back", n, op, err, len(got))
		}
	}
	// A ping is answered with a pong carrying its payload, and the next
	// message still arrives.
	go func() {
		_ = wsWriteFrame(b, wsPing, []byte("hi"), false)
		_ = wsWriteFrame(b, wsText, []byte("after"), false)
	}()
	go func() {
		_, data, _ := server.ReadMessage() // the pong is skipped; nothing else comes
		_ = data
	}()
	if _, got, err := client.ReadMessage(); err != nil || string(got) != "after" {
		t.Fatalf("after ping: %q %v", got, err)
	}
	a.Close()
	b.Close()
}
