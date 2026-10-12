package main

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/mabn/barreplay/assets"
	"github.com/mabn/barreplay/snapshot"
)

func TestReadBuildInfo(t *testing.T) {
	b := readBuildInfo()
	if b.GoVersion != runtime.Version() {
		t.Errorf("GoVersion = %q, want %q", b.GoVersion, runtime.Version())
	}
	// A test binary is built inside the repository's checkout, so either the
	// toolchain's stamp or git in the working directory names the commit.
	if b.Sha == "" || b.Source == "" {
		t.Errorf("no commit found: %+v", b)
	}
	if b.Time == "" {
		t.Errorf("no build time: %+v", b)
	}
}

func TestReadBuildInfoLdflagsWin(t *testing.T) {
	defer func(s, tm string) { buildSha, buildTime = s, tm }(buildSha, buildTime)
	buildSha, buildTime = "abc123", "2026-10-12T08:00:00Z"
	b := readBuildInfo()
	if b.Sha != "abc123" || b.Source != "ldflags" || b.Time != "2026-10-12T08:00:00Z" || b.Dirty {
		t.Errorf("ldflags not preferred: %+v", b)
	}
}

func TestNewJobStats(t *testing.T) {
	defer func(b buildInfo) { thisBuild = b }(thisBuild)
	thisBuild = buildInfo{Sha: "deadbeef", Time: "2026-10-12T08:00:00Z"}
	up := newJobStats(kindUpload)
	if up.Bringest == nil || up.Bringest.Sha != "deadbeef" || up.WidgetVersion != "" {
		t.Errorf("upload stats = %+v", up)
	}
	rs := newJobStats(kindResim)
	if rs.WidgetVersion != assets.WidgetVersion() {
		t.Errorf("re-sim widget = %q, want the embedded %q", rs.WidgetVersion, assets.WidgetVersion())
	}
}

func TestRecordBRPMeta(t *testing.T) {
	st := &jobStats{}
	recordBRPMeta(st, filepath.Join("..", "..", "worker", "tests", "fixtures", "viewer.brp"))
	if st.BrpVersion != int(snapshot.BRPVersion) {
		t.Errorf("BrpVersion = %d, want %d", st.BrpVersion, snapshot.BRPVersion)
	}
	// A missing file is no error and records nothing.
	st = &jobStats{}
	recordBRPMeta(st, "gone.brp")
	if st.BrpVersion != 0 {
		t.Errorf("missing file recorded %+v", st)
	}
}
