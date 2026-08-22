package engine

import (
	"os"
	"runtime"
	"testing"
	"time"
)

// A real /proc/<pid>/stat line (spring-headless, trimmed of nothing). The point
// of testing against a whole one is the comm field: it is the executable name
// in parentheses and the fields are counted from the LAST ')', so anything that
// splits the line on whitespace from the front reads the wrong columns.
const sampleStat = "12345 (spring-headless) S 12344 12345 12344 0 -1 4194560 902156 0 118 0 " +
	"318442 21735 0 0 20 0 9 0 84512300 6598172672 786432 18446744073709551615 " +
	"4194304 21387796 140724 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0"

func TestParseProcStat(t *testing.T) {
	at := time.Unix(1700000000, 0)
	s, ok := parseProcStat(sampleStat, at)
	if !ok {
		t.Fatal("parseProcStat: not ok")
	}
	// Field 24 (rss) is 786432 pages.
	if want := int64(786432) * int64(os.Getpagesize()); s.RSSBytes != want {
		t.Errorf("RSSBytes = %d, want %d", s.RSSBytes, want)
	}
	// utime 318442 + stime 21735 ticks at 100 Hz.
	if want := float64(318442+21735) / 100; s.CPUSec != want {
		t.Errorf("CPUSec = %v, want %v", s.CPUSec, want)
	}
	if !s.At.Equal(at) {
		t.Errorf("At = %v, want %v", s.At, at)
	}
}

// A comm containing spaces AND parentheses is legal — the kernel writes the
// executable's name verbatim — and is exactly what breaks a naive field split.
func TestParseProcStatOddComm(t *testing.T) {
	line := "7 (my (weird) name) R 1 7 1 0 -1 0 0 0 0 0 " +
		"100 50 0 0 20 0 1 0 0 0 64 " +
		"0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
	s, ok := parseProcStat(line, time.Now())
	if !ok {
		t.Fatal("parseProcStat: not ok")
	}
	if want := float64(150) / 100; s.CPUSec != want {
		t.Errorf("CPUSec = %v, want %v", s.CPUSec, want)
	}
	if want := int64(64) * int64(os.Getpagesize()); s.RSSBytes != want {
		t.Errorf("RSSBytes = %d, want %d", s.RSSBytes, want)
	}
}

// Garbage and truncation must yield "no reading", never a panic or a made-up
// number: this feeds a progress report, and a wrong figure there is worse than
// a missing one.
func TestParseProcStatRejectsJunk(t *testing.T) {
	for _, line := range []string{
		"",
		"nothing useful here",
		"1 (short) S 0 1",                       // truncated before rss
		"1 (bad) S x x x x x x x x x x x x x x", // non-numeric
	} {
		if _, ok := parseProcStat(line, time.Now()); ok {
			t.Errorf("parseProcStat(%q) = ok, want not ok", line)
		}
	}
}

func TestCPUPercent(t *testing.T) {
	t0 := time.Unix(1700000000, 0)
	prev := ProcSample{CPUSec: 10, At: t0}
	// 8 CPU-seconds over 2 wall seconds is four cores' worth.
	if got := CPUPercent(prev, ProcSample{CPUSec: 18, At: t0.Add(2 * time.Second)}); got != 400 {
		t.Errorf("CPUPercent = %v, want 400", got)
	}
	// Nothing to divide by, and a counter that went backwards (a reused pid),
	// both report nothing rather than a wild number.
	if got := CPUPercent(prev, ProcSample{CPUSec: 18, At: t0}); got != 0 {
		t.Errorf("CPUPercent(same instant) = %v, want 0", got)
	}
	if got := CPUPercent(prev, ProcSample{CPUSec: 1, At: t0.Add(time.Second)}); got != 0 {
		t.Errorf("CPUPercent(backwards) = %v, want 0", got)
	}
}

// The live path, against this very process: it is the only way to see that the
// /proc path and the field indexes agree with the running kernel.
func TestSampleProcessSelf(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("no /proc")
	}
	s, ok := SampleProcess(os.Getpid())
	if !ok {
		t.Fatal("SampleProcess(self): not ok")
	}
	if s.RSSBytes <= 0 {
		t.Errorf("RSSBytes = %d, want > 0", s.RSSBytes)
	}
	if s.CPUSec < 0 {
		t.Errorf("CPUSec = %v, want >= 0", s.CPUSec)
	}
}

// A pid that is not there (and the zero pid a caller passes before the engine
// has started) must be a quiet miss.
func TestSampleProcessMissing(t *testing.T) {
	if _, ok := SampleProcess(0); ok {
		t.Error("SampleProcess(0) = ok, want not ok")
	}
	if _, ok := SampleProcess(1 << 30); ok {
		t.Error("SampleProcess(huge pid) = ok, want not ok")
	}
}
