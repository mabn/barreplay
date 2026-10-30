package main

import (
	"strings"
	"testing"
)

// A line longer than the scanner can hold must not end the read: nothing
// would drain the pipe afterwards, and every later write to stderr blocks.
func TestLogTeeKeepsReadingPastALongLine(t *testing.T) {
	lt := &logTee{}
	in := strings.Repeat("x", 3*logLineMax) + "\nafter\r\nlast"
	lt.read(strings.NewReader(in))
	if n := len(lt.lines); n != 5 {
		t.Fatalf("got %d lines, want the long one in 3 pieces + 2", n)
	}
	if lt.lines[3] != "after" || lt.lines[4] != "last" {
		t.Fatalf("lines after the long one: %q", lt.lines[3:])
	}
}
