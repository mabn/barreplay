package main

import (
	"bufio"
	"io"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// logTee captures everything the pipeline prints. internal/resim and
// internal/engine report on os.Stderr, which a windowed program does not
// have, so os.Stderr and os.Stdout are swapped for a pipe whose lines go to
// fogofwar.log, a ring buffer the window shows as the activity log, and
// onLine (which parses download percentages out of them).
type logTee struct {
	mu     sync.Mutex
	lines  []string
	fresh  []string
	file   *os.File
	onLine func(string)
}

const (
	logKeep    = 400
	logLineMax = 64 << 10
)

func startLogTee(path string, onLine func(string)) (*logTee, error) {
	t := &logTee{onLine: onLine}
	// A log over a few MB is from long ago; start it fresh.
	if st, err := os.Stat(path); err == nil && st.Size() > 8<<20 {
		os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		t.file = f
	}
	r, w, err := os.Pipe()
	if err != nil {
		return t, err
	}
	os.Stderr, os.Stdout = w, w
	go t.read(r)
	return t, nil
}

// read splits on both \n and \r: pr-downloader redraws its progress line
// with carriage returns, and each redraw is a reading worth having.
func (t *logTee) read(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, logLineMax), logLineMax)
	sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		for i, b := range data {
			if b == '\n' || b == '\r' {
				return i + 1, data[:i], nil
			}
		}
		if len(data) >= logLineMax || atEOF && len(data) > 0 {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	for sc.Scan() {
		t.add(sc.Text(), true)
	}
	// Scan stops only at EOF: a line too long to buffer is cut (below) rather
	// than ending the scan, since once nothing reads the pipe every later write
	// to stderr, the pipeline's and pr-downloader's, blocks and the app hangs.
}

func (t *logTee) add(line string, fromPipe bool) {
	line = strings.TrimRight(line, " \t")
	if line == "" {
		return
	}
	if fromPipe && t.onLine != nil {
		t.onLine(line)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.file != nil {
		t.file.WriteString(time.Now().Format(time.RFC3339) + " " + line + "\n")
	}
	t.lines = append(t.lines, line)
	if len(t.lines) > logKeep {
		t.lines = append([]string(nil), t.lines[len(t.lines)-logKeep:]...)
	}
	t.fresh = append(t.fresh, line)
}

// Logf adds the app's own line to the log. It never reaches onLine, so the
// app may log while holding its own lock.
func (t *logTee) Logf(line string) { t.add(line, false) }

// all is the whole ring buffer; take is what arrived since the last take.
func (t *logTee) all() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.lines...)
}

func (t *logTee) take() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	f := t.fresh
	t.fresh = nil
	return f
}

// moveTo continues the log in another file (the data folder moved).
func (t *logTee) moveTo(path string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	t.mu.Lock()
	old := t.file
	t.file = f
	t.mu.Unlock()
	t.crashToLog()
	if old != nil {
		old.Close()
	}
	return nil
}

// crashToLog makes the runtime write a crash (an unrecovered panic in any
// goroutine, a fatal error) and its stack into fogofwar.log. Only the
// runtime's own writes go there directly; everything else keeps going
// through the tee.
func (t *logTee) crashToLog() {
	t.mu.Lock()
	f := t.file
	t.mu.Unlock()
	if f == nil {
		return
	}
	if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		t.add("could not send crash reports to the log: "+err.Error(), false)
	}
}
