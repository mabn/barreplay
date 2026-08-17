package engine

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
)

// InfologSummary is what a finished run's infolog.txt says about how it went,
// reduced to the few numbers worth keeping next to a published replay.
//
// Desyncs is the one that matters. A re-simulation is only meaningful if it
// stays in lockstep with the demo, and the way that fails is loud in the log
// and silent everywhere else: a capture of a game that never happened looks
// completely normal on disk. (Locate refusing a mismatched engine build is the
// guard against the known cause; this is the observation that the run itself
// was clean.)
type InfologSummary struct {
	// Bytes is the log's size on disk — a run cost worth noticing when it runs
	// to hundreds of MB.
	Bytes int64
	Lines int
	// LastFrame is the newest "[f=N]" marker, i.e. how far the engine actually
	// got. Cross-checks the capture's own frame count.
	LastFrame int32
	// Desyncs and Warnings are SUBSTRING counts ("desync"/"sync error" and
	// "warning", case-insensitive), not a parse of a log grammar the engine
	// does not promise. Read them as signals — zero desyncs means the run
	// looked clean, a non-zero count means go and read the log.
	Desyncs  int
	Warnings int
}

// maxInfologLine bounds one log line; a longer one is truncated rather than
// ending the scan, since the counts below are per-line signals and the tail of
// a very long line carries nothing this needs.
const maxInfologLine = 1 << 20

// SummarizeInfolog scans path and reports what it found. Best-effort by
// design, like everything else that reads the engine's leavings: an
// unreadable or absent log yields a zero summary and no error, because the
// capture it belongs to is already written and a missing log is not a reason
// to fail a publish.
func SummarizeInfolog(path string) InfologSummary {
	var s InfologSummary
	f, err := os.Open(path)
	if err != nil {
		return s
	}
	defer f.Close()
	if fi, err := f.Stat(); err == nil {
		s.Bytes = fi.Size()
	}

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxInfologLine)
	for sc.Scan() {
		line := sc.Bytes()
		s.Lines++
		if frame, ok := lastFrameInBytes(line); ok {
			s.LastFrame = frame
		}
		lower := bytes.ToLower(line)
		if bytes.Contains(lower, []byte("desync")) || bytes.Contains(lower, []byte("sync error")) {
			s.Desyncs++
		}
		if bytes.Contains(lower, []byte("warning")) {
			s.Warnings++
		}
	}
	// A line past the buffer ends the scan with ErrTooLong; keep the counts
	// gathered so far rather than throwing the whole summary away.
	return s
}

// String renders the summary for a one-line log entry.
func (s InfologSummary) String() string {
	return fmt.Sprintf("%.1f MB, last frame %d, %d desyncs, %d warnings",
		float64(s.Bytes)/(1<<20), s.LastFrame, s.Desyncs, s.Warnings)
}
