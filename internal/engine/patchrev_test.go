package engine

import (
	"os"
	"path/filepath"
	"testing"
)

// The repo's patch series must be the newest pinned revision: a changed patch
// published under the old version would be different code behind the same name.
func TestPatchSeriesIsPinned(t *testing.T) {
	for version, revs := range patchSeries {
		got, err := SeriesDigest(filepath.Join("..", "..", "patches", "engine-"+version))
		if err != nil {
			t.Fatal(err)
		}
		if want := revs[len(revs)-1]; got != want {
			t.Errorf("patches/engine-%s changed: its digest is %s, but the newest pinned revision (%d) is %s.\n"+
				"Append the new digest to patchSeries[%q] in patchrev.go; the next build is %s.",
				version, got, len(revs), want, version, PatchedVersion(version, len(revs)+1))
		}
	}
}

// Every published build names a revision the table knows.
func TestPatchedBuildsNamePinnedRevisions(t *testing.T) {
	for version, b := range patchedBuilds {
		if b.Rev < 1 || b.Rev > len(patchSeries[version]) {
			t.Errorf("patchedBuilds[%q] is revision %d, which patchSeries does not have", version, b.Rev)
		}
	}
}

func TestPatchedVersion(t *testing.T) {
	for _, c := range []struct {
		engine string
		rev    int
		want   string
	}{
		{"2026.07.04", 1, "2026.7.4-barreplay.1"},
		{"2025.06.24", 12, "2025.6.24-barreplay.12"},
	} {
		if got := PatchedVersion(c.engine, c.rev); got != c.want {
			t.Errorf("PatchedVersion(%q, %d) = %q, want %q", c.engine, c.rev, got, c.want)
		}
	}
	if got := PatchedVersionTag("2026.07.04", 1); got != "patched-engine/2026.7.4-barreplay.1" {
		t.Errorf("tag = %q", got)
	}
}

func TestSeriesDigestTracksOrderAndContents(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.patch", "a")
	write("b.patch", "b")
	write("series", "# comment\na.patch\nb.patch\n")
	base, err := SeriesDigest(dir)
	if err != nil {
		t.Fatal(err)
	}

	write("series", "# a different comment\n\na.patch\nb.patch\n")
	if d, _ := SeriesDigest(dir); d != base {
		t.Error("editing a comment changed the digest")
	}
	write("series", "b.patch\na.patch\n")
	if d, _ := SeriesDigest(dir); d == base {
		t.Error("reordering the series kept the digest")
	}
	write("series", "a.patch\nb.patch\n")
	write("b.patch", "b changed")
	if d, _ := SeriesDigest(dir); d == base {
		t.Error("changing a patch kept the digest")
	}
	write("series", "a.patch\nmissing.patch\n")
	if _, err := SeriesDigest(dir); err == nil {
		t.Error("a series naming a missing patch hashed without error")
	}
}

func TestSeriesDigestTracksThePGODir(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.patch", "a")
	write("series", "a.patch\n")
	plain, err := SeriesDigest(dir)
	if err != nil {
		t.Fatal(err)
	}
	write("pgo/profile.tar.xz", "profile 1")
	write("pgo/build.sh", "flags")
	withPGO, _ := SeriesDigest(dir)
	if withPGO == plain {
		t.Error("adding a pgo/ dir kept the digest")
	}
	write("pgo/profile.tar.xz", "profile 2")
	if d, _ := SeriesDigest(dir); d == withPGO {
		t.Error("a new profile kept the digest")
	}
	write("pgo/profile.tar.xz", "profile 1")
	write("pgo/build.sh", "other flags")
	if d, _ := SeriesDigest(dir); d == withPGO {
		t.Error("new build flags kept the digest")
	}
}
