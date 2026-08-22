package main

import (
	"fmt"
	"io"
	"os"
	"time"
)

// logStamp is the time format prefixed to each line of the log FILE. RFC3339
// with the local offset: parseable by anything without a convention to agree
// on, sortable, and it still says what o'clock it was on the host — which is
// the question somebody reading a daemon's log on their own machine actually
// has. The offset is spelled out rather than normalized to UTC because the
// other half of the answer is usually the queue page, whose timestamps are the
// WORKER's clock.
const logStamp = "2006-01-02T15:04:05Z07:00"

// teeStderr duplicates everything written to os.Stderr into path (appended, so
// runs accumulate rather than clobbering each other), timestamping every line
// on the way. It swaps os.Stderr for a pipe rather than threading a writer
// through the call graph, so it also captures what internal/resim,
// internal/packer and inherited child processes print — which is most of the
// interesting output. The returned stop drains the pipe before returning, so
// nothing is lost at exit.
//
// Only the FILE is stamped; the terminal keeps the bare lines. The terminal is
// watched live, where the clock is redundant and 25 columns in front of every
// progress line are not — and it is the file that gets read months later, when
// "how long did that take" has no other source. That the two differ is the
// point: one is a view, the other is the record.
func teeStderr(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open log %s: %w", path, err)
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		f.Close()
		return nil, err
	}
	orig := os.Stderr
	os.Stderr = pw
	done := make(chan struct{})
	go func() {
		defer close(done)
		io.Copy(io.MultiWriter(orig, &stampWriter{w: f, now: time.Now}), pr)
	}()
	return func() {
		os.Stderr = orig
		pw.Close()
		<-done // drain what is still in flight before the process exits
		f.Close()
	}, nil
}

// stampWriter writes a timestamp in front of every line it passes on.
//
// It cannot work a line at a time: what arrives from the pipe is whatever chunk
// the reader happened to get, which splits and joins lines arbitrarily — one
// write can carry half a line, and the next twenty. So it tracks whether it is
// at the start of a line and stamps there, which also means the time recorded
// is when the line STARTED arriving rather than when it ended. That matters for
// the one thing the log is scanned for: a progress line stamped at the moment
// its run reported, not at the moment the next one did.
//
// A line is never held back waiting for its newline, so a half-written line
// (the process dying mid-print) still appears, stamped, rather than vanishing.
type stampWriter struct {
	w   io.Writer
	now func() time.Time
	// midLine is true when the last byte written was not a newline, i.e. the
	// next byte continues a line that is already stamped.
	midLine bool
}

func (s *stampWriter) Write(p []byte) (int, error) {
	// The count returned must be len(p) on success: the caller (io.MultiWriter)
	// compares it against what it handed over, and the stamps are bytes it
	// never gave us.
	for off := 0; off < len(p); {
		if !s.midLine {
			if _, err := io.WriteString(s.w, s.now().Format(logStamp)+" "); err != nil {
				return off, err
			}
			s.midLine = true
		}
		end := off
		for end < len(p) && p[end] != '\n' {
			end++
		}
		nl := end < len(p)
		if nl {
			end++ // the newline belongs to the line it ends
		}
		n, err := s.w.Write(p[off:end])
		off += n
		if err != nil {
			return off, err
		}
		if nl {
			// Only now: a failed write must leave the next one continuing this
			// line rather than stamping a fresh one on top of a partial write.
			s.midLine = false
		}
	}
	return len(p), nil
}
