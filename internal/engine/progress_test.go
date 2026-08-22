package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLastFrameInTail(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "infolog.txt")

	if _, ok := lastFrameInTail(p, 2048); ok {
		t.Error("missing file should report ok=false")
	}

	// A file larger than the tail window: only the tail is read, so the most
	// recent frame near the end must still be found.
	var b strings.Builder
	for i := 0; i < 5000; i++ {
		b.WriteString("[t=00:00:00][f=0000001] filler line to push past the tail window\n")
	}
	b.WriteString("[t=00:03:13][f=0005790] latest\n")
	if err := os.WriteFile(p, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	if frame, ok := lastFrameInTail(p, 2048); !ok || frame != 5790 {
		t.Fatalf("lastFrameInTail = %d ok=%v, want 5790", frame, ok)
	}
}

func TestLastFrameInBytes(t *testing.T) {
	// The most recent frame is the last "[f=...]" marker, even across mixed lines.
	buf := []byte("[t=00:00:01][f=0000030] spawn\n" +
		"[t=00:00:02][f=0000060] a line with no other tag\n" +
		"some engine line without a frame marker\n" +
		"[t=00:00:03][f=0000123] latest\n")
	frame, ok := lastFrameInBytes(buf)
	if !ok || frame != 123 {
		t.Fatalf("lastFrameInBytes = %d ok=%v, want 123", frame, ok)
	}

	// Pregame frames are negative; still parsed (caller filters them).
	if f, ok := lastFrameInBytes([]byte("[f=-000001] pregame\n")); !ok || f != -1 {
		t.Errorf("pregame frame = %d ok=%v, want -1", f, ok)
	}
	if _, ok := lastFrameInBytes([]byte("no frame here at all\n")); ok {
		t.Error("should not find a frame in frame-less bytes")
	}
}

func TestFormatProgress(t *testing.T) {
	// frame 2700 = 90s in; total 5790 = 193s; 450 fps -> 15.0x realtime.
	line := formatProgress(2700, 5790, 450, 125)
	for _, want := range []string{"frame 2700/5790", "01:30 / 03:13", "46.6%", "450 sim-fps (15.0x)", "ETA 02:05"} {
		if !strings.Contains(line, want) {
			t.Errorf("progress line %q missing %q", line, want)
		}
	}

	// The example from the request: 45 fps is a 1.5x speed-up.
	if line := formatProgress(300, 5790, 45, 60); !strings.Contains(line, "45 sim-fps (1.5x)") {
		t.Errorf("speed-up wrong: %q", line)
	}

	// A measured stall is a real 0, not an absent reading.
	if line := formatProgress(300, 5790, 0, 60); !strings.Contains(line, "0 sim-fps (0.0x)") {
		t.Errorf("stalled line %q should report a rate of 0", line)
	}

	// Unknown total, unmeasurable fps and no ETA yet each degrade gracefully.
	line = formatProgress(300, 0, -1, 0)
	for _, want := range []string{"frame 300/--", "00:10 / --:--", "(--)", "-- sim-fps (--)", "ETA --:--"} {
		if !strings.Contains(line, want) {
			t.Errorf("degraded line %q missing %q", line, want)
		}
	}
}

func TestMMSS(t *testing.T) {
	cases := map[float64]string{0: "00:00", 9: "00:09", 90: "01:30", 3661: "1:01:01"}
	for sec, want := range cases {
		if got := mmss(sec); got != want {
			t.Errorf("mmss(%v) = %q, want %q", sec, got, want)
		}
	}
}
