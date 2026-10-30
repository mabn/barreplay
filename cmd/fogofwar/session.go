package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// session.json says how the last run of the app ended. A crash the runtime
// can report goes into the log (crashToLog), but nothing at all is written
// when the process is ended from outside — Task Manager, a kill, a power cut
// — so the app writes down that it is alive (and what it is doing) once a
// minute and that it closed when it closes. A record with no close at the next
// start is a run that was ended, and when Windows booted says by what.
type sessionRecord struct {
	PID     int       `json:"pid"`
	Version string    `json:"version"`
	Started time.Time `json:"started"`
	Alive   time.Time `json:"alive"`
	Doing   string    `json:"doing,omitempty"`
	// Ended is set on a close: by the app itself, or Windows ending the
	// session (shutdown, restart, sign-out).
	Ended  time.Time `json:"ended,omitempty"`
	Reason string    `json:"reason,omitempty"`
}

const sessionEvery = time.Minute

func sessionPath(root string) string { return filepath.Join(root, "session.json") }

func readSession(root string) (sessionRecord, bool) {
	var r sessionRecord
	b, err := os.ReadFile(sessionPath(root))
	if err != nil || json.Unmarshal(b, &r) != nil || r.Started.IsZero() {
		return r, false
	}
	return r, true
}

// writeSession replaces the record through a temp file, so an app ended
// mid-write leaves the previous record rather than half a file.
func writeSession(root string, r sessionRecord) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	tmp := sessionPath(root) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, sessionPath(root))
}

// previousEnd is the log line about how the last run ended, "" when it closed
// normally. boot is when this Windows session started (zero when unknown).
func previousEnd(r sessionRecord, boot time.Time) string {
	if !r.Ended.IsZero() {
		if r.Reason == "" || r.Reason == "closed" {
			return ""
		}
		return fmt.Sprintf("The last run (FogOfWar %s, started %s) ended at %s: %s",
			r.Version, stamp(r.Started), stamp(r.Ended), r.Reason)
	}
	s := fmt.Sprintf("The last run (FogOfWar %s, pid %d, started %s) did not close: it was last seen alive at %s",
		r.Version, r.PID, stamp(r.Started), stamp(r.Alive))
	if r.Doing != "" {
		s += ", " + r.Doing
	}
	switch {
	case boot.IsZero():
		return s + "."
	case boot.After(r.Alive):
		return s + fmt.Sprintf(". Windows started again at %s, so the PC restarted, shut down or lost power without closing it.", stamp(boot))
	default:
		return s + fmt.Sprintf(". Windows has been running since %s, so it was ended from outside (Task Manager, or a crash the log could not record).", stamp(boot))
	}
}

func stamp(t time.Time) string { return t.Local().Format("2006-01-02 15:04:05") }

// trackSession reports how the previous run ended, then keeps this run's
// record current until the app closes.
func (a *App) trackSession() {
	if prev, ok := readSession(a.root); ok {
		if line := previousEnd(prev, bootTime()); line != "" {
			a.logf("%s", line)
		}
	}
	now := time.Now()
	a.sessMu.Lock()
	a.sess = sessionRecord{PID: os.Getpid(), Version: version, Started: now, Alive: now}
	a.sessMu.Unlock()
	a.touchSession()
	go func() {
		t := time.NewTicker(sessionEvery)
		defer t.Stop()
		for range t.C {
			if !a.touchSession() {
				return
			}
		}
	}()
}

// touchSession records that the app is alive and what it is doing; false once
// the session has ended.
func (a *App) touchSession() bool {
	doing := a.activity()
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	if !a.sess.Ended.IsZero() {
		return false
	}
	a.sess.Alive, a.sess.Doing = time.Now(), doing
	if err := writeSession(a.root, a.sess); err != nil && !a.sessWarned {
		a.sessWarned = true
		a.logf("could not write session.json: %v", err)
	}
	return true
}

// endSession records the close and its reason; the first one wins.
func (a *App) endSession(reason string) {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	if a.sess.Started.IsZero() || !a.sess.Ended.IsZero() {
		return
	}
	a.sess.Ended, a.sess.Reason = time.Now(), reason
	writeSession(a.root, a.sess)
}

// activity is what the app is doing, in words, for the session record.
func (a *App) activity() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case a.mode == modeSetup:
		return "downloading the engine and game"
	case a.job != nil:
		phase := a.job.phase
		if phase == "" {
			phase = a.job.progress.Snapshot().Phase
		}
		s := "re-simulating " + a.job.gameID
		if phase != "" {
			s += " (" + phase + ")"
		}
		return s
	}
	return "idle"
}
