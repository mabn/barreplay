package main

import (
	"strings"
	"testing"

	"github.com/mabn/barreplay/internal/capture"
)

// Two scopes sampled every 300 frames: "A" accrues a constant 2 ms/frame, "B"
// accrues 1 ms/frame early and 4 ms/frame after frame 3000. The growth table
// must report B's late rate above A's and a ~4x growth for B.
func TestPrintProfileGrowth(t *testing.T) {
	var samples []capture.ProfileSample
	for f := int32(300); f <= 9000; f += 300 {
		msB := float64(f) // 1 ms/frame
		if f > 3000 {
			msB = 3000 + 4*float64(f-3000)
		}
		samples = append(samples,
			capture.ProfileSample{Frame: f, Units: 10 * f / 300, Ms: 2 * float64(f), Name: "A"},
			capture.ProfileSample{Frame: f, Units: 10 * f / 300, Ms: msB, Name: "B"},
		)
	}

	var buf strings.Builder
	printProfileGrowth(&buf, samples)
	out := buf.String()

	if !strings.Contains(out, "units 10 -> 300") {
		t.Errorf("missing unit range, got:\n%s", out)
	}
	iA := strings.Index(out, "  A\n")
	iB := strings.Index(out, "  B\n")
	if iA < 0 || iB < 0 {
		t.Fatalf("missing scope rows, got:\n%s", out)
	}
	if iB > iA {
		t.Errorf("B (late 4 ms/f) should sort above A (2 ms/f), got:\n%s", out)
	}
	bLine := out[strings.LastIndex(out[:iB], "\n")+1 : iB+3]
	if !strings.Contains(bLine, "4.000") || !strings.Contains(bLine, "4.0x") {
		t.Errorf("B row should show late 4.000 ms/f and 4.0x growth, got: %q", bLine)
	}
	aLine := out[strings.LastIndex(out[:iA], "\n")+1 : iA+3]
	if !strings.Contains(aLine, "1.0x") {
		t.Errorf("A row should show 1.0x growth, got: %q", aLine)
	}
}

// A run without -profile has no samples; the growth section must be absent.
func TestPrintProfileGrowthEmpty(t *testing.T) {
	var buf strings.Builder
	printProfileGrowth(&buf, nil)
	if buf.Len() != 0 {
		t.Errorf("expected no output for no samples, got: %q", buf.String())
	}
}
