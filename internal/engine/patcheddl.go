// Patched-engine provisioning. The patched build (patches/engine-<version>/)
// takes ~35 minutes to compile in the pinned Docker image and has to be gated
// byte-identical against the stock engine before it may publish anything, so
// building it on every host that wants to re-simulate is the wrong unit of
// work. Instead one gated build per version is published to the bucket, and
// every host downloads that exact binary.
//
// THE TRUST ANCHOR IS THIS FILE, not the bucket: patchedBuilds pins each
// published binary's SHA-256, and a download that does not hash to it is
// refused. A binary is only ever added here after it passed the gate, so the
// pin is also the record of which build was verified. The object key carries
// the hash too (content-addressed, like a replay revision), so publishing a
// new build never overwrites one a host may be downloading.
//
// The binary is GPL (Recoil). Its corresponding source is the upstream tag
// plus the patch series in this repo's patches/engine-<version>/.
package engine

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// PatchedBuild is one gated patched engine published to the bucket.
type PatchedBuild struct {
	// Key is the object's path in the bucket: a gzip of the binary.
	Key string
	// SHA256 is the hex SHA-256 of the DECOMPRESSED binary — the bytes that
	// were gated, independent of how they happened to be compressed.
	SHA256 string
}

// patchedBuilds lists the published patched engines by engine version. Add an
// entry only for a build that passed the byte-identity gate
// (docs/building-recoil.md, "The PATCHED build"); cmd/publish-engine prints
// the line to paste here.
var patchedBuilds = map[string]PatchedBuild{}

// PatchedBuildBaseURL is where published patched engines are read back from:
// the bucket's public hostname (packer's "r2" target DataURL). Exposed so
// tests can point it at a local server.
var PatchedBuildBaseURL = "https://cdn-bar.fogofwar.dev"

// PatchedBuildKey names the object a patched binary with this hash is
// published under.
func PatchedBuildKey(version, sha256Hex string) string {
	return "engines/" + version + "/" + patchedHeadlessName() + "-" + sha256Hex[:16] + ".gz"
}

// EnsurePatchedEngine installs the published patched build for version beside
// the stock engine (<DataDir>/engine/<version>/spring-headless-patched), where
// Locate looks for it. It is a no-op when one is already there — a build made
// locally is never replaced — when provisioning is disabled, when an explicit
// binary is pinned, or when no build is published for the version.
//
// Callers treat an error as a warning: without the patched build a re-sim
// still runs, on the stock engine, at stock speed.
func EnsurePatchedEngine(ctx context.Context, cfg Config, version string) error {
	if cfg.SkipProvision || cfg.EngineBinary != "" || version == "" {
		return nil
	}
	build, ok := patchedBuilds[version]
	if !ok {
		return nil
	}
	dir := filepath.Join(cfg.DataDir, "engine", version)
	dst := filepath.Join(dir, patchedHeadlessName())
	if fileExists(dst) {
		return nil
	}
	// The patched binary resolves base/ relative to its own path, so it is
	// only usable inside a stock install — EnsureEngine runs first.
	if !fileExists(filepath.Join(dir, headlessName())) {
		return fmt.Errorf("engine: no stock %s install at %s to put the patched build beside", version, dir)
	}

	url := PatchedBuildBaseURL + "/" + build.Key
	fmt.Fprintf(os.Stderr, "engine: downloading the patched %s build from %s\n", version, url)
	// Written to a temp file in the same dir and renamed into place only once
	// its hash checks out, so neither an interrupted download nor a wrong
	// binary can ever be found at the path Locate prefers.
	tmp, err := os.CreateTemp(dir, ".patched-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	got, err := downloadGunzipped(ctx, url, tmp)
	if err != nil {
		return fmt.Errorf("engine: download patched build: %w", err)
	}
	if got != build.SHA256 {
		return fmt.Errorf("engine: patched build from %s hashes to %s, want %s; not installing it", url, got, build.SHA256)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		return fmt.Errorf("engine: install patched build: %w", err)
	}
	fmt.Fprintf(os.Stderr, "engine: installed the patched %s build -> %s\n", version, dst)
	return nil
}

// CheckBuildVersion runs bin --version and refuses a binary that reports a
// different engine version than the one it is about to be published for. A
// banner with no recognizable version is let through, as Locate does.
func CheckBuildVersion(bin, version string) error {
	banner, err := engineBannerVersion(bin)
	if err != nil {
		return fmt.Errorf("engine: run %s --version: %w", bin, err)
	}
	if got, ok := parseEngineVersion(banner); ok && !engineVersionMatches(got, version) {
		return fmt.Errorf("engine: %s is %s, not %s", bin, got, version)
	}
	return nil
}

// downloadGunzipped streams a gzip from url into dst, decompressed, and
// returns the hex SHA-256 of what it wrote.
func downloadGunzipped(ctx context.Context, url string, dst io.Writer) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: %s", url, resp.Status)
	}
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(dst, h), zr); err != nil {
		return "", err
	}
	if err := zr.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
