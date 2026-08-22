package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A fixed clock that advances a second per reading, so a test can tell WHICH
// write a stamp came from.
func tickingClock(start time.Time) func() time.Time {
	n := -1
	return func() time.Time {
		n++
		return start.Add(time.Duration(n) * time.Second)
	}
}

func TestStampWriterStampsEveryLine(t *testing.T) {
	base := time.Date(2026, 8, 22, 6, 56, 12, 0, time.UTC)
	var out strings.Builder
	w := &stampWriter{w: &out, now: tickingClock(base)}

	n, err := io.WriteString(w, "first\nsecond\n")
	if err != nil || n != len("first\nsecond\n") {
		t.Fatalf("Write = (%d, %v), want the whole input consumed", n, err)
	}
	want := "2026-08-22T06:56:12Z first\n2026-08-22T06:56:13Z second\n"
	if out.String() != want {
		t.Errorf("got:\n%q\nwant:\n%q", out.String(), want)
	}
}

// What arrives from the pipe is whatever chunk the reader got, which splits and
// joins lines arbitrarily — one write can carry half a line, and the next
// twenty. A line must be stamped once, when it STARTS, however it is delivered.
func TestStampWriterHandlesArbitraryChunking(t *testing.T) {
	base := time.Date(2026, 8, 22, 6, 56, 12, 0, time.UTC)
	for _, tc := range []struct {
		name   string
		chunks []string
		want   string
	}{
		{
			"one line split across three writes",
			[]string{"progress: frame 1", "69/100170 ", "ETA 03:49\n"},
			"2026-08-22T06:56:12Z progress: frame 169/100170 ETA 03:49\n",
		},
		{
			"writes straddling the line boundaries",
			[]string{"a\nb", "\nc\n"},
			"2026-08-22T06:56:12Z a\n2026-08-22T06:56:13Z b\n2026-08-22T06:56:14Z c\n",
		},
		{
			"empty writes stamp nothing",
			[]string{"", "one\n", ""},
			"2026-08-22T06:56:12Z one\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out strings.Builder
			w := &stampWriter{w: &out, now: tickingClock(base)}
			for _, c := range tc.chunks {
				if _, err := io.WriteString(w, c); err != nil {
					t.Fatal(err)
				}
			}
			if out.String() != tc.want {
				t.Errorf("got:\n%q\nwant:\n%q", out.String(), tc.want)
			}
		})
	}
}

// A process dying mid-print must not lose the half-line it managed: nothing is
// held back waiting for a newline.
func TestStampWriterDoesNotBufferAPartialLine(t *testing.T) {
	base := time.Date(2026, 8, 22, 6, 56, 12, 0, time.UTC)
	var out strings.Builder
	w := &stampWriter{w: &out, now: tickingClock(base)}
	io.WriteString(w, "resim: engine exited: signal")
	if got := out.String(); got != "2026-08-22T06:56:12Z resim: engine exited: signal" {
		t.Errorf("partial line = %q, want it written through", got)
	}
	// ...and the rest of it, when it comes, continues that same line.
	io.WriteString(w, ": killed\n")
	if got := out.String(); got != "2026-08-22T06:56:12Z resim: engine exited: signal: killed\n" {
		t.Errorf("continued line = %q, want one stamp", got)
	}
}

// The stamp bytes are ours, not the caller's: io.MultiWriter checks the count
// against what it handed over and calls a mismatch a short write.
func TestStampWriterReportsTheCallersCount(t *testing.T) {
	base := time.Date(2026, 8, 22, 6, 56, 12, 0, time.UTC)
	var out strings.Builder
	mw := io.MultiWriter(io.Discard, &stampWriter{w: &out, now: tickingClock(base)})
	if _, err := io.WriteString(mw, "line\n"); err != nil {
		t.Fatalf("MultiWriter over a stampWriter: %v", err)
	}
}

// A write that fails partway must leave the next one CONTINUING the broken
// line, not stamping a fresh one over the middle of it.
func TestStampWriterKeepsItsPlaceThroughAFailedWrite(t *testing.T) {
	base := time.Date(2026, 8, 22, 6, 56, 12, 0, time.UTC)
	var out strings.Builder
	bad := &failOnceWriter{w: &out}
	w := &stampWriter{w: bad, now: tickingClock(base)}
	if _, err := io.WriteString(w, "abcdef\n"); err == nil {
		t.Fatal("want the underlying failure reported")
	}
	if _, err := io.WriteString(w, "ghi\n"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(out.String(), "2026-08-22T06:56:"); got != 1 {
		t.Errorf("%d stamps in %q, want the second write to continue the first's line", got, out.String())
	}
}

// failOnceWriter writes the first 3 bytes it is given, then fails — a short
// write with an error, which is what a real io.Writer does when it breaks.
type failOnceWriter struct {
	w      io.Writer
	failed bool
}

func (f *failOnceWriter) Write(p []byte) (int, error) {
	if f.failed {
		return f.w.Write(p)
	}
	f.failed = true
	if len(p) > 3 {
		p = p[:3]
	}
	n, _ := f.w.Write(p)
	return n, errors.New("disk full")
}

// The whole point of the file: it is the record read months later, and the
// terminal is the live view. So the two must differ exactly here.
func TestTeeStderrStampsTheFileAndNotTheTerminal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bringest.log")

	// Stand in for the terminal so the test can read what "stderr" got.
	term, err := os.CreateTemp(dir, "term")
	if err != nil {
		t.Fatal(err)
	}
	defer term.Close()
	saved := os.Stderr
	os.Stderr = term
	stop, err := teeStderr(path)
	if err != nil {
		os.Stderr = saved
		t.Fatal(err)
	}
	io.WriteString(os.Stderr, "bringest: hello\n")
	stop()
	os.Stderr = saved

	logged, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	stamped := string(logged)
	if !strings.HasSuffix(stamped, " bringest: hello\n") {
		t.Errorf("log line = %q, want the message after a stamp", stamped)
	}
	if _, err := time.Parse(logStamp, strings.Fields(stamped)[0]); err != nil {
		t.Errorf("log line %q does not start with a %s timestamp: %v", stamped, logStamp, err)
	}

	onTerm, err := os.ReadFile(term.Name())
	if err != nil {
		t.Fatal(err)
	}
	if string(onTerm) != "bringest: hello\n" {
		t.Errorf("terminal got %q, want the bare line", onTerm)
	}
}

// Appending, not clobbering: the daemon is restarted, and the log across
// restarts is the whole reason it is a file.
func TestTeeStderrAppends(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bringest.log")
	if err := os.WriteFile(path, []byte("earlier run\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	saved := os.Stderr
	stop, err := teeStderr(path)
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(os.Stderr, "later run\n")
	stop()
	os.Stderr = saved

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(b), "earlier run\n") || !strings.Contains(string(b), "later run\n") {
		t.Errorf("log = %q, want the earlier run kept and the later one appended", b)
	}
}
