package packer

// The .brp size report, shared by every CLI that produces one: cmd/pack's
// -stats and cmd/bringest's per-publish summary. It only renders — the
// measuring lives in snapshot.ComputeBRPStats, which self-checks against the
// codec.

import (
	"fmt"
	"io"
	"os"

	"github.com/mabn/barreplay/snapshot"
)

// ReportStats writes the size breakdown of one .brp: totals, per-section
// sizes, and the top unit defs by encoded bytes. Def bytes are RAW (pre-gzip)
// stream bytes — the codec's honest attribution unit; the est.gz column scales
// them by the owning sections' measured compression ratio to approximate the
// on-disk share. Instances (distinct unit lifetimes) divide into bytes/unit so
// "many cheap units" and "few expensive units" read differently.
func ReportStats(w io.Writer, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	bf, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		return err
	}
	st, err := snapshot.ComputeBRPStats(bf)
	if err != nil {
		return err
	}

	fmt.Fprintf(w, "%s: %s, %d frames, %d events, %d comms, %d unit records, %d chunks\n\n",
		path, fmtBytes(fileSize(path)), bf.FrameCount, bf.EventCount, bf.CommCount, bf.UnitRecords, len(bf.Chunks))

	fmt.Fprintf(w, "%-14s %10s %10s %6s %7s\n", "section", "stored", "raw", "gzip", "file%")
	var stored, coreStored, extraStored int64
	for _, s := range st.Sections {
		stored += s.Stored
		if s.Tag == snapshot.SecKeyframes || s.Tag == snapshot.SecFrames {
			coreStored += s.Stored
		}
		if s.Tag == snapshot.SecExtra {
			extraStored += s.Stored
		}
	}
	for _, s := range st.Sections {
		fmt.Fprintf(w, "%c %-12s %10s %10s %6s %6.1f%%\n",
			s.Tag, s.Name, fmtBytes(s.Stored), fmtBytes(s.Raw), fmtRatio(s.Raw, s.Stored), pct(s.Stored, stored))
	}

	if len(st.Defs) == 0 {
		fmt.Fprintln(w, "\nno unit records")
		return nil
	}
	// est.gz scales each def's raw bytes by its sections' compression ratio.
	coreGz := ratio(coreStored, st.CoreRaw)
	extraGz := ratio(extraStored, st.ExtraRaw)
	streamRaw := st.CoreRaw + st.ExtraRaw
	fmt.Fprintf(w, "\ntop %d unit defs by encoded size (raw stream bytes; est.gz ≈ stored share):\n", min(10, len(st.Defs)))
	fmt.Fprintf(w, "%3s %10s %10s %6s %8s %10s %9s  %s\n", "#", "bytes", "est.gz", "share", "units", "bytes/unit", "records", "def")
	var restBytes int64
	for i, d := range st.Defs {
		raw := d.CoreBytes + d.ExtraBytes
		if i >= 10 {
			restBytes += raw
			continue
		}
		name := d.Name
		if name == "" {
			name = fmt.Sprintf("def %d", d.DefID)
		}
		if d.HumanName != "" {
			name += " (" + d.HumanName + ")"
		}
		perUnit := int64(0)
		if d.Instances > 0 {
			perUnit = raw / d.Instances
		}
		est := int64(float64(d.CoreBytes)*coreGz + float64(d.ExtraBytes)*extraGz)
		fmt.Fprintf(w, "%3d %10s %10s %5.1f%% %8d %10s %9d  %s\n",
			i+1, fmtBytes(raw), fmtBytes(est), pct(raw, streamRaw), d.Instances, fmtBytes(perUnit), d.Records, name)
	}
	if n := len(st.Defs) - 10; n > 0 {
		fmt.Fprintf(w, "    (%d more defs: %s, %.1f%%)\n", n, fmtBytes(restBytes), pct(restBytes, streamRaw))
	}
	fmt.Fprintf(w, "frame framing overhead: %s raw (%.1f%%); team resources: %s raw (%.1f%%)\n",
		fmtBytes(st.OverheadBytes), pct(st.OverheadBytes, streamRaw),
		fmtBytes(st.ResourceBytes), pct(st.ResourceBytes, streamRaw))
	return nil
}

func fmtBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.2f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// fmtRatio renders a raw:stored compression factor like "4.2x".
func fmtRatio(raw, stored int64) string {
	if stored == 0 || raw == 0 {
		return "-"
	}
	return fmt.Sprintf("%.1fx", float64(raw)/float64(stored))
}

func ratio(num, den int64) float64 {
	if den == 0 {
		return 0
	}
	return float64(num) / float64(den)
}

func pct(part, total int64) float64 { return 100 * ratio(part, total) }
