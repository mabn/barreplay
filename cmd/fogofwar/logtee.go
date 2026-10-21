package main

import (
	"bufio"
	"io"
	"os"
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

const logKeep = 400

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
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		for i, b := range data {
			if b == '\n' || b == '\r' {
				return i + 1, data[:i], nil
			}
		}
		if atEOF && len(data) > 0 {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	for sc.Scan() {
		t.add(sc.Text(), true)
	}
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
