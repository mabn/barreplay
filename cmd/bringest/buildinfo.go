package main

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"runtime/debug"
	"strings"
	"time"
)

// Set with -ldflags "-X main.buildSha=... -X main.buildTime=..." by anyone who
// wants to state them outright. Nothing needs to: both are found without it
// (see readBuildInfo), so a plain `go build` or `go run` is enough.
var (
	buildSha  string
	buildTime string
)

// buildInfo says WHICH bringest did a job. It rides on every job's stats,
// because the code that packed or re-simulated a replay is otherwise invisible
// from the queue page: the daemon runs on somebody's machine, and "was that
// before or after the fix" is a question about this binary, not the worker.
type buildInfo struct {
	// Sha is the git commit the binary was built from.
	Sha string `json:"sha,omitempty"`
	// Dirty is set when the working tree had uncommitted changes, so Sha alone
	// does not describe the code that ran.
	Dirty bool `json:"dirty,omitempty"`
	// CommitTime is the commit's own time (RFC 3339), when known.
	CommitTime string `json:"commitTime,omitempty"`
	// Time is when the binary was BUILT (RFC 3339): the executable's
	// modification time unless -ldflags stated it.
	Time string `json:"time,omitempty"`
	// Source says where Sha came from: "vcs" (stamped by the Go toolchain on
	// `go build`), "git" (asked of the working directory, which is what a
	// `go run` binary has to do — the toolchain stamps nothing there), or
	// "ldflags".
	Source    string `json:"source,omitempty"`
	GoVersion string `json:"goVersion,omitempty"`
}

// readBuildInfo works out this binary's build once, at startup.
func readBuildInfo() buildInfo {
	b := buildInfo{GoVersion: runtime.Version()}
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				b.Sha, b.Source = s.Value, "vcs"
			case "vcs.time":
				b.CommitTime = s.Value
			case "vcs.modified":
				b.Dirty = s.Value == "true"
			}
		}
	}
	if b.Sha == "" {
		// `go run` builds without VCS stamping. The daemon runs from the repo
		// root (it reads ./.env from there), so the checkout it was built from
		// is the working directory.
		gitInfo(&b)
	}
	if buildSha != "" {
		b.Sha, b.Source, b.Dirty, b.CommitTime = buildSha, "ldflags", false, ""
	}
	if buildTime != "" {
		b.Time = buildTime
	} else if exe, err := os.Executable(); err == nil {
		if fi, err := os.Stat(exe); err == nil {
			b.Time = fi.ModTime().UTC().Format(time.RFC3339)
		}
	}
	return b
}

// gitInfo fills b from `git` in the working directory. Best-effort: no git, or
// not a checkout, leaves it empty.
func gitInfo(b *buildInfo) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	git := func(args ...string) (string, bool) {
		out, err := exec.CommandContext(ctx, "git", args...).Output()
		return strings.TrimSpace(string(out)), err == nil
	}
	sha, ok := git("rev-parse", "HEAD")
	if !ok || sha == "" {
		return
	}
	b.Sha, b.Source = sha, "git"
	if t, ok := git("log", "-1", "--format=%cI"); ok {
		if pt, err := time.Parse(time.RFC3339, t); err == nil {
			b.CommitTime = pt.UTC().Format(time.RFC3339)
		}
	}
	if st, ok := git("status", "--porcelain", "--untracked-files=no"); ok {
		b.Dirty = st != ""
	}
}

// String is the one-line form for the startup log.
func (b buildInfo) String() string {
	s := b.Sha
	if s == "" {
		s = "unknown commit"
	} else if len(s) > 12 {
		s = s[:12]
	}
	if b.Dirty {
		s += "+dirty"
	}
	if b.Time != "" {
		s += ", built " + b.Time
	}
	return s
}
