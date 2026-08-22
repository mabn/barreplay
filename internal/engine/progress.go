package engine

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

// simFPS is BAR's fixed simulation rate: 30 sim frames per game-second.
const simFPS = 30

// InfologPath is where the engine writes its log (in the write-dir).
func (e *Engine) InfologPath() string {
	return filepath.Join(e.cfg.DataDir, "infolog.txt")
}

// frameTag matches the "[f=1234]" sim-frame marker the engine prefixes log lines
// with. The frame is -1 during pregame.
var frameTag = regexp.MustCompile(`\[f=(-?\d+)\]`)

// lastFrameInBytes returns the frame from the last "[f=...]" marker in buf, i.e.
// the most recent one the engine logged.
func lastFrameInBytes(buf []byte) (int32, bool) {
	m := frameTag.FindAllSubmatch(buf, -1)
	if len(m) == 0 {
		return 0, false
	}
	n, err := strconv.ParseInt(string(m[len(m)-1][1]), 10, 32)
	if err != nil {
		return 0, false
	}
	return int32(n), true
}

// lastFrameInTail reads the final tailBytes of path and returns the most recent
// logged frame. Best-effort: returns ok=false if the file is unreadable or has no
// frame marker yet.
func lastFrameInTail(path string, tailBytes int64) (int32, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return 0, false
	}
	start := int64(0)
	if fi.Size() > tailBytes {
		start = fi.Size() - tailBytes
	}
	buf := make([]byte, fi.Size()-start)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return 0, false
	}
	return lastFrameInBytes(buf)
}

// LastLoggedFrame is the newest sim frame the engine has written into its
// infolog, which is the only running-progress signal a headless replay emits
// (the widget's heartbeat keeps the "[f=]" markers flowing). Best-effort in the
// same way WatchProgress is: ok=false while the log is unreadable or has no
// frame marker yet, which is normal for the first seconds of a run.
func LastLoggedFrame(infologPath string) (int32, bool) {
	return lastFrameInTail(infologPath, 2048)
}

// WatchProgress polls the tail of infologPath every interval and prints replay
// progress to out until ctx is cancelled. totalGameSec is the demo's full game
// duration (from the header) and drives percent-complete and ETA; pass 0 if
// unknown to omit those. Speed and time-remaining both come from SimETA, so the
// printed line and the one a daemon reports to a job say the same thing. It is
// best-effort: peeks that can't be read or have no frame yet are skipped.
func WatchProgress(ctx context.Context, infologPath string, totalGameSec int, interval time.Duration, out io.Writer) {
	est := NewSimETA(int32(totalGameSec * simFPS))

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			frame, ok := LastLoggedFrame(infologPath)
			if !ok || frame < 0 {
				continue
			}
			fps, eta := est.Observe(now, frame)
			fmt.Fprintln(out, formatProgress(frame, est.total, fps, eta))
		}
	}
}

// formatProgress renders one progress line. totalFrames<=0, an unknown fps (<0)
// and an unavailable ETA (<=0) each gracefully degrade to "--". Speed-up is fps
// relative to the baseline 30 sim frames/game-second (e.g. 45 fps -> 1.5x
// realtime).
func formatProgress(frame, totalFrames int32, fps, etaSec float64) string {
	cur := mmss(float64(frame) / simFPS)

	totalF, total, pct, eta := "--", "--:--", "--", "--:--"
	if totalFrames > 0 {
		totalF = strconv.FormatInt(int64(totalFrames), 10)
		total = mmss(float64(totalFrames) / simFPS)
		pct = fmt.Sprintf("%.1f%%", 100*float64(frame)/float64(totalFrames))
	}
	if etaSec > 0 {
		eta = mmss(etaSec)
	}
	speed, speedup := "--", "--"
	if fps >= 0 {
		speed = fmt.Sprintf("%.0f", fps)
		speedup = fmt.Sprintf("%.1fx", fps/simFPS)
	}
	return fmt.Sprintf("progress: frame %d/%s  •  %s / %s game (%s)  •  %s sim-fps (%s)  •  ETA %s",
		frame, totalF, cur, total, pct, speed, speedup, eta)
}

// mmss formats a non-negative number of seconds as MM:SS (or HH:MM:SS past an hour).
func mmss(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	s := int(sec + 0.5)
	h, rem := s/3600, s%3600
	m, ss := rem/60, rem%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, ss)
	}
	return fmt.Sprintf("%02d:%02d", m, ss)
}
