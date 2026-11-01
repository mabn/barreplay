package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// siteURL is the replay site every finished replay is uploaded to and opened
// on. FOGOFWAR_SITE overrides it (http://127.0.0.1:5173 for a dev worker).
func siteURL() string {
	if s := os.Getenv("FOGOFWAR_SITE"); s != "" {
		return strings.TrimRight(s, "/")
	}
	return "https://replay.fogofwar.dev"
}

// replayURL is the replay's page on the site.
func replayURL(gameID string) string {
	return siteURL() + "/replays/" + url.PathEscape(gameID)
}

// Upload states, as a history row records them.
const (
	uploadQueued    = "queued"    // the site has the file; its publisher has not run yet
	uploadPublished = "published" // it plays on the site
	uploadFailed    = "failed"
)

// uploadBRP posts a finished .brp to the site's open upload route, which
// archives it and queues it for publishing; the answer is the job that does
// that. appJob is the run's own queue job, if the site gave it one, so the
// queue shows the publish inside the run's row. progress is called as the
// bytes go out.
func uploadBRP(ctx context.Context, path, installID, appJob string, progress func(done, total int64)) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	body := &countingReader{r: f, total: st.Size(), progress: progress}
	// The install and app version mark the upload's queue job as this app's.
	q := url.Values{"app": {version}}
	if installID != "" {
		q.Set("install", installID)
	}
	if appJob != "" {
		q.Set("appJob", appJob)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, siteURL()+"/api/upload?"+q.Encode(), body)
	if err != nil {
		return "", err
	}
	req.ContentLength = st.Size()
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		Job   string `json:"job"`
		Error string `json:"error"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	_ = json.Unmarshal(b, &out)
	if resp.StatusCode != http.StatusOK {
		if out.Error != "" {
			return "", fmt.Errorf("the site refused the upload: %s", out.Error)
		}
		return "", fmt.Errorf("the site answered %s", resp.Status)
	}
	if out.Job == "" {
		return "", errors.New("the site's answer named no upload job")
	}
	return out.Job, nil
}

// uploadJobState reads the upload job's state ("pending", "processing",
// "done", "error") and, for an error, its message.
func uploadJobState(ctx context.Context, job string) (state, msg string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, siteURL()+"/api/jobs/"+url.PathEscape(job), nil)
	if err != nil {
		return "", "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", siteRefusal(resp, "upload job")
	}
	var out struct {
		State string `json:"state"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return "", "", err
	}
	return out.State, out.Error, nil
}

// countingReader reports how much of an upload has been read.
type countingReader struct {
	r        io.Reader
	done     int64
	total    int64
	last     time.Time
	progress func(done, total int64)
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.done += int64(n)
	if c.progress != nil && (time.Since(c.last) > 200*time.Millisecond || err != nil || c.done == c.total) {
		c.last = time.Now()
		c.progress(c.done, c.total)
	}
	return n, err
}

// upload sends a finished replay to the site and records the outcome on its
// history row. It runs inside the job, as its last phase, so the window shows
// the transfer; a failed upload never fails the job, the file is saved.
func (a *App) upload(ctx context.Context, run *jobRun, item *HistoryItem, installID, appJob string, st *jobStats) {
	a.setJobPhase(run, "uploading")
	a.logf("Uploading %s to %s", run.gameID, siteURL())
	uctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	t0 := time.Now()
	job, err := uploadBRP(uctx, item.Path, installID, appJob, func(done, total int64) {
		a.onDownload("Uploading "+run.gameID+".brp", done, total)
	})
	st.UploadSec = round1(time.Since(t0).Seconds())
	if err != nil {
		item.Upload, item.UploadError = uploadFailed, err.Error()
		a.logf("upload failed: %v", err)
		return
	}
	item.Upload, item.UploadJob = uploadQueued, job
	a.logf("Uploaded; the site is publishing it (job %s)", job)
}

// watchUpload follows an upload job until the site has published the replay
// or given up on it, updating the history row. The site's publisher is a
// separate daemon, so this can take minutes, or never happen while it is
// down; the row says "queued" until then, and the next launch asks again.
func (a *App) watchUpload(gameID, job string) {
	deadline := time.Now().Add(2 * time.Hour)
	wait := 5 * time.Second
	for time.Now().Before(deadline) {
		time.Sleep(wait)
		if wait < time.Minute {
			wait += 5 * time.Second
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		state, msg, err := uploadJobState(ctx, job)
		cancel()
		if err != nil {
			continue
		}
		switch state {
		case "done":
			a.setUpload(gameID, job, uploadPublished, "")
			a.logf("Published %s: %s", gameID, replayURL(gameID))
			return
		case "error":
			if msg == "" {
				msg = "the site could not publish it"
			}
			a.setUpload(gameID, job, uploadFailed, msg)
			a.logf("publishing %s failed: %s", gameID, msg)
			return
		}
	}
}

// resumeUploadWatches picks up the uploads a previous session left queued.
func (a *App) resumeUploadWatches() {
	for _, h := range a.config().History {
		if h.Upload == uploadQueued && h.UploadJob != "" && time.Since(h.FinishedAt) < 2*24*time.Hour {
			go a.watchUpload(h.GameID, h.UploadJob)
		}
	}
}

func (a *App) setUpload(gameID, job, state, msg string) {
	a.updateConfig(func(c *Config) {
		for i := range c.History {
			if c.History[i].GameID == gameID && c.History[i].UploadJob == job {
				c.History[i].Upload, c.History[i].UploadError = state, msg
			}
		}
	})
	a.mu.Lock()
	if a.last != nil && a.last.GameID == gameID && a.last.UploadJob == job {
		a.last.Upload, a.last.UploadError = state, msg
	}
	a.dirty = true
	a.mu.Unlock()
}
