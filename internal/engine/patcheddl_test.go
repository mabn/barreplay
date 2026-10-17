package engine

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

const testVersion = "2026.07.04"

// servePatched publishes body (gzipped) as revision 1's build, pins that
// build with hash wantSHA, and returns the request counter. Both globals are
// restored when the test ends.
func servePatched(t *testing.T, body []byte, wantSHA string) *atomic.Int32 {
	t.Helper()
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(body)
	zw.Close()
	key := PatchedBuildKey(testVersion, 1)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/"+key {
			http.NotFound(w, r)
			return
		}
		w.Write(gz.Bytes())
	}))
	t.Cleanup(srv.Close)

	oldURL, oldBuilds := PatchedBuildBaseURL, patchedBuilds
	PatchedBuildBaseURL = srv.URL
	patchedBuilds = map[string]PatchedBuild{testVersion: {Rev: 1, SHA256: wantSHA}}
	t.Cleanup(func() { PatchedBuildBaseURL, patchedBuilds = oldURL, oldBuilds })
	return &hits
}

// stockInstall makes a data dir holding a stock engine for testVersion.
func stockInstall(t *testing.T) (dataDir, engineDir string) {
	t.Helper()
	dataDir = t.TempDir()
	engineDir = filepath.Join(dataDir, "engine", testVersion)
	if err := os.MkdirAll(engineDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(engineDir, headlessName()), []byte("stock"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dataDir, engineDir
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestEnsurePatchedEngineInstallsThePinnedBuild(t *testing.T) {
	binary := []byte("patched engine bytes")
	servePatched(t, binary, sha(binary))
	dataDir, engineDir := stockInstall(t)

	if err := EnsurePatchedEngine(context.Background(), Config{DataDir: dataDir}, testVersion); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(engineDir, patchedHeadlessName())
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, binary) {
		t.Errorf("installed %q, want %q", got, binary)
	}
	if fi, _ := os.Stat(dst); fi.Mode().Perm()&0o100 == 0 {
		t.Errorf("installed binary is not executable: %v", fi.Mode())
	}
}

func TestEnsurePatchedEngineRefusesAWrongHash(t *testing.T) {
	servePatched(t, []byte("tampered"), sha([]byte("what was gated")))
	dataDir, engineDir := stockInstall(t)

	err := EnsurePatchedEngine(context.Background(), Config{DataDir: dataDir}, testVersion)
	if err == nil || !strings.Contains(err.Error(), "hashes to") {
		t.Fatalf("err = %v, want a hash mismatch", err)
	}
	// Neither the binary nor a temp file may be left where Locate looks.
	entries, _ := os.ReadDir(engineDir)
	for _, e := range entries {
		if e.Name() != headlessName() {
			t.Errorf("left %s behind in the engine dir", e.Name())
		}
	}
}

func TestEnsurePatchedEngineReplacesALocalBuild(t *testing.T) {
	binary := []byte("published")
	servePatched(t, binary, sha(binary))
	dataDir, engineDir := stockInstall(t)
	local := filepath.Join(engineDir, patchedHeadlessName())
	if err := os.WriteFile(local, []byte("built here"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := EnsurePatchedEngine(context.Background(), Config{DataDir: dataDir}, testVersion); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(local); string(got) != string(binary) {
		t.Errorf("a patched engine other than the pinned build was kept: %q", got)
	}
}

func TestEnsurePatchedEngineKeepPatchedEngine(t *testing.T) {
	binary := []byte("published")
	hits := servePatched(t, binary, sha(binary))
	old := []byte("published rev 1")
	b := patchedBuilds[testVersion]
	b.Superseded = []string{sha(old)}
	patchedBuilds[testVersion] = b
	for _, have := range [][]byte{[]byte("built here"), old} {
		dataDir, engineDir := stockInstall(t)
		local := filepath.Join(engineDir, patchedHeadlessName())
		if err := os.WriteFile(local, have, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := EnsurePatchedEngine(context.Background(), Config{DataDir: dataDir, KeepPatchedEngine: true}, testVersion); err != nil {
			t.Fatal(err)
		}
		if got, _ := os.ReadFile(local); string(got) != string(have) {
			t.Errorf("KeepPatchedEngine replaced %q with %q", have, got)
		}
	}
	if hits.Load() != 0 {
		t.Errorf("made %d requests with KeepPatchedEngine", hits.Load())
	}
}

func TestEnsurePatchedEngineLeavesTheCurrentBuild(t *testing.T) {
	binary := []byte("published")
	hits := servePatched(t, binary, sha(binary))
	dataDir, engineDir := stockInstall(t)
	if err := os.WriteFile(filepath.Join(engineDir, patchedHeadlessName()), binary, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePatchedEngine(context.Background(), Config{DataDir: dataDir}, testVersion); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 0 {
		t.Errorf("made %d requests with the pinned build installed", hits.Load())
	}
}

func TestEnsurePatchedEngineUpgradesASupersededBuild(t *testing.T) {
	binary := []byte("published rev 2")
	servePatched(t, binary, sha(binary))
	old := []byte("published rev 1")
	b := patchedBuilds[testVersion]
	b.Superseded = []string{sha(old)}
	patchedBuilds[testVersion] = b
	dataDir, engineDir := stockInstall(t)
	installed := filepath.Join(engineDir, patchedHeadlessName())
	if err := os.WriteFile(installed, old, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := EnsurePatchedEngine(context.Background(), Config{DataDir: dataDir}, testVersion); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(installed); string(got) != string(binary) {
		t.Errorf("a superseded published build was kept: %q", got)
	}
}

func TestEnsurePatchedEngineSkipsUnpublishedVersions(t *testing.T) {
	binary := []byte("published")
	hits := servePatched(t, binary, sha(binary))
	dataDir := t.TempDir()

	if err := EnsurePatchedEngine(context.Background(), Config{DataDir: dataDir}, "2025.06.24"); err != nil {
		t.Fatal(err)
	}
	for _, cfg := range []Config{
		{DataDir: dataDir, SkipProvision: true},
		{DataDir: dataDir, EngineBinary: "/opt/spring-headless"},
	} {
		if err := EnsurePatchedEngine(context.Background(), cfg, testVersion); err != nil {
			t.Fatal(err)
		}
	}
	if hits.Load() != 0 {
		t.Errorf("made %d requests; want none", hits.Load())
	}
}

func TestEnsurePatchedEngineNeedsTheStockInstall(t *testing.T) {
	binary := []byte("published")
	hits := servePatched(t, binary, sha(binary))

	err := EnsurePatchedEngine(context.Background(), Config{DataDir: t.TempDir()}, testVersion)
	if err == nil {
		t.Fatal("installed a patched build with no stock engine beside it")
	}
	if hits.Load() != 0 {
		t.Errorf("downloaded before checking for the stock install")
	}
}

func TestPatchedBuildKeyWindows(t *testing.T) {
	got := PatchedBuildKeyWindows("2026.07.04", 3)
	want := "engines/2026.07.04/windows-amd64/spring-headless-patched-2026.7.4-barreplay.3.exe.gz"
	if got != want {
		t.Errorf("PatchedBuildKeyWindows = %q, want %q", got, want)
	}
}
