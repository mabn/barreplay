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

// WatchProgress polls the tail of infologPath every interval and prints replay
// progress to out until ctx is cancelled. totalGameSec is the demo's full game
// duration (from the header) and drives percent-complete and ETA; pass 0 if
// unknown to omit those. Processing speed (sim frames/real second) is measured
// from the frame delta between consecutive peeks. It is best-effort: peeks that
// can't be read or have no frame yet are skipped.
func WatchProgress(ctx context.Context, infologPath string, totalGameSec int, interval time.Duration, out io.Writer) {
	totalFrames := int32(totalGameSec * simFPS)

	prevFrame := int32(-1)
	var prevTime time.Time

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			frame, ok := lastFrameInTail(infologPath, 2048)
			if !ok || frame < 0 {
				continue
			}

			fps := -1.0
			if prevFrame >= 0 {
				if dt := now.Sub(prevTime).Seconds(); dt > 0 {
					fps = float64(frame-prevFrame) / dt
				}
			}
			fmt.Fprintln(out, formatProgress(frame, totalFrames, fps))
			prevFrame, prevTime = frame, now
		}
	}
}

// formatProgress renders one progress line. totalFrames<=0 or an unknown fps
// (<0) gracefully degrade to "--".
func formatProgress(frame, totalFrames int32, fps float64) string {
	cur := mmss(float64(frame) / simFPS)

	total, pct, eta := "--:--", "--", "--:--"
	if totalFrames > 0 {
		total = mmss(float64(totalFrames) / simFPS)
		pct = fmt.Sprintf("%.1f%%", 100*float64(frame)/float64(totalFrames))
		if fps > 0 {
			eta = mmss(float64(totalFrames-frame) / fps)
		}
	}
	speed := "--"
	if fps >= 0 {
		speed = fmt.Sprintf("%.0f", fps)
	}
	return fmt.Sprintf("progress: %s / %s game (%s)  •  %s sim-fps  •  ETA %s",
		cur, total, pct, speed, eta)
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
