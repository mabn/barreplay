package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSummarizeInfolog(t *testing.T) {
	// Shaped like the engine's real output: a "[t=...][f=N]" prefix per line,
	// pregame frames of -1, and the desync wording both the client and the
	// server use.
	log := strings.Join([]string{
		"[t=00:00:00.000000][f=-000001] Using read-write data directory: /data",
		"[t=00:00:01.000000][f=-000001] Warning: [CIconHandler] no icon for unit",
		"[t=00:00:12.000000][f=0000000] [barreplay] widget loaded",
		"[t=00:00:20.000000][f=0000300] Sync error for player 3 in frame 300",
		"[t=00:00:21.000000][f=0000600] Desync detected",
		"[t=00:00:22.000000][f=0001234] WARNING: something else",
		"[t=00:00:23.000000][f=0004321] game over",
	}, "\n") + "\n"

	dir := t.TempDir()
	path := filepath.Join(dir, "infolog.txt")
	if err := os.WriteFile(path, []byte(log), 0o644); err != nil {
		t.Fatal(err)
	}

	s := SummarizeInfolog(path)
	if s.Lines != 7 {
		t.Errorf("Lines = %d, want 7", s.Lines)
	}
	if s.LastFrame != 4321 {
		t.Errorf("LastFrame = %d, want 4321 (the newest marker, not the largest)", s.LastFrame)
	}
	if s.Desyncs != 2 {
		t.Errorf("Desyncs = %d, want 2 (both the 'Sync error' and the 'Desync' wording)", s.Desyncs)
	}
	if s.Warnings != 2 {
		t.Errorf("Warnings = %d, want 2 (case-insensitive)", s.Warnings)
	}
	if s.Bytes != int64(len(log)) {
		t.Errorf("Bytes = %d, want %d", s.Bytes, len(log))
	}
}

// A missing log is not a failure: the capture it belongs to is already written,
// and refusing to publish over an absent side-file would be absurd.
func TestSummarizeInfologMissing(t *testing.T) {
	s := SummarizeInfolog(filepath.Join(t.TempDir(), "nope.txt"))
	if s != (InfologSummary{}) {
		t.Errorf("summary = %+v, want the zero value", s)
	}
}

// A line longer than the scanner's buffer ends the scan; what was counted
// before it must survive.
func TestSummarizeInfologOverlongLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "infolog.txt")
	body := "[f=0000001] Desync detected\n" + strings.Repeat("x", maxInfologLine+1) + "\n[f=0000002] Desync\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	s := SummarizeInfolog(path)
	if s.Desyncs != 1 || s.LastFrame != 1 {
		t.Errorf("summary = %+v, want the counts from before the overlong line", s)
	}
	if s.Bytes != int64(len(body)) {
		t.Errorf("Bytes = %d, want the file's real size %d", s.Bytes, len(body))
	}
}
