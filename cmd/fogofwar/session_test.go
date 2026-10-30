package main

import (
	"strings"
	"testing"
	"time"
)

func TestPreviousEnd(t *testing.T) {
	start := time.Date(2026, 10, 30, 1, 0, 0, 0, time.UTC)
	alive := start.Add(6 * time.Hour)
	open := sessionRecord{PID: 34200, Version: "0.2.14", Started: start, Alive: alive, Doing: "re-simulating abc (fetching game)"}

	if s := previousEnd(sessionRecord{Started: start, Alive: alive, Ended: alive, Reason: "closed"}, time.Time{}); s != "" {
		t.Errorf("a normal close is not worth a line: %q", s)
	}
	shut := sessionRecord{Version: "0.2.14", Started: start, Ended: alive, Reason: "Windows shut down or restarted"}
	if s := previousEnd(shut, time.Time{}); !strings.Contains(s, "Windows shut down or restarted") {
		t.Errorf("shutdown: %q", s)
	}
	for _, c := range []struct {
		boot time.Time
		want string
	}{
		{alive.Add(10 * time.Minute), "PC restarted"},
		{start.Add(-24 * time.Hour), "ended from outside"},
		{time.Time{}, "re-simulating abc (fetching game)."},
	} {
		s := previousEnd(open, c.boot)
		if !strings.Contains(s, "pid 34200") || !strings.Contains(s, c.want) {
			t.Errorf("boot %v: %q lacks %q", c.boot, s, c.want)
		}
	}
}

func TestSessionRecordRoundTrip(t *testing.T) {
	root := t.TempDir()
	if _, ok := readSession(root); ok {
		t.Fatal("no file is no record")
	}
	r := sessionRecord{PID: 7, Version: "x", Started: time.Unix(100, 0).UTC(), Alive: time.Unix(160, 0).UTC(), Doing: "idle"}
	if err := writeSession(root, r); err != nil {
		t.Fatal(err)
	}
	got, ok := readSession(root)
	if !ok || got != r {
		t.Fatalf("got %+v, want %+v", got, r)
	}
}
