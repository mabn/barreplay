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
// pin is also the record of which build was verified.
//
// A build is NAMED by its semver (PatchedVersion: the engine version plus the
// revision of the patch series, patchrev.go), and so is its object:
// engines/<version>/spring-headless-patched-2026.7.4-barreplay.1.gz. One version is
// one binary — publish-engine writes it only if the key is free and refuses a
// different binary under a name already taken — so a new build is always a
// new revision and never overwrites one a host may be downloading.
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
	// Rev is the revision of the patch series it was built from (patchSeries),
	// which with the engine version makes its name: PatchedVersion.
	Rev int
	// SHA256 is the hex SHA-256 of the DECOMPRESSED binary — the bytes that
	// were gated, independent of how they happened to be compressed.
	SHA256 string
	// Superseded lists the SHA-256 of every EARLIER published build of the
	// version; a binary matching none of them was built locally. Both are
	// replaced (unless Config.KeepPatchedEngine); the list only lets the log
	// say which it was.
	Superseded []string
}

// patchedBuilds lists the published patched engine for each engine version
// (the newest revision is the one hosts should run). Add an entry only for a
// build that passed the byte-identity gate (docs/building-recoil.md, "The
// PATCHED build"); cmd/publish-engine prints the line to paste here.
var patchedBuilds = map[string]PatchedBuild{
	"2026.07.04": {Rev: 3, SHA256: "2ea1aecf0528606631625c636fe3eb31905cab145371800ca1a42d8cdb4e9d74", // 2026.7.4-barreplay.3 (PGO+LTO)
		Superseded: []string{
			"eeb7625d02e251282aca4fea3162a21208ff0fcb468c83cf2d3bedc8b5070a27", // .1
			"1e7b3c417aab1afe34878cad9a557368ee0c7132c72a52d84b71314437df9c01", // .2
		}},
}

// PatchedBuildBaseURL is where published patched engines are read back from:
// the bucket's public hostname (packer's "r2" target DataURL). Exposed so
// tests can point it at a local server.
var PatchedBuildBaseURL = "https://cdn-bar.fogofwar.dev"

// PatchedBuildKey names the object the patched build of this engine version
// and series revision is published under.
func PatchedBuildKey(version string, rev int) string {
	return "engines/" + version + "/" + patchedHeadlessName() + "-" + PatchedVersion(version, rev) + ".gz"
}

// EnsurePatchedEngine installs the published patched build for version beside
// the stock engine (<DataDir>/engine/<version>/spring-headless-patched), where
// Locate looks for it, and REPLACES whatever other patched binary is there —
// an earlier published build or one made locally — unless cfg.
// KeepPatchedEngine says to keep it. It is a no-op when the pinned build is
// already installed, when provisioning is disabled, when an explicit binary is
// pinned, or when no build is published for the version.
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
		have, err := fileSHA256(dst)
		if err != nil || have == build.SHA256 {
			return nil
		}
		what := "a patched build that is not a published one (built here?)"
		if contains(build.Superseded, have) {
			what = "an earlier published patched build"
		}
		if cfg.KeepPatchedEngine {
			fmt.Fprintf(os.Stderr, "engine: keeping %s (sha256 %s), %s, rather than updating to %s\n",
				dst, have[:12], what, PatchedVersion(version, build.Rev))
			return nil
		}
		fmt.Fprintf(os.Stderr, "engine: %s (sha256 %s) is %s; updating to %s\n",
			dst, have[:12], what, PatchedVersion(version, build.Rev))
	}
	// The patched binary resolves base/ relative to its own path, so it is
	// only usable inside a stock install — EnsureEngine runs first.
	if !fileExists(filepath.Join(dir, headlessName())) {
		return fmt.Errorf("engine: no stock %s install at %s to put the patched build beside", version, dir)
	}

	name := PatchedVersion(version, build.Rev)
	url := PatchedBuildBaseURL + "/" + PatchedBuildKey(version, build.Rev)
	fmt.Fprintf(os.Stderr, "engine: downloading the patched build %s from %s\n", name, url)
	// Written to a temp file in the same dir and renamed into place only once
	// its hash checks out, so neither an interrupted download nor a wrong
	// binary can ever be found at the path Locate prefers.
	tmp, err := os.CreateTemp(dir, ".patched-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	got, err := DownloadGunzipped(ctx, url, tmp)
	if err != nil {
		return fmt.Errorf("engine: download patched build: %w", err)
	}
	if got != build.SHA256 {
		return fmt.Errorf("engine: patched build %s from %s hashes to %s, want %s; not installing it", name, url, got, build.SHA256)
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
	fmt.Fprintf(os.Stderr, "engine: installed the patched build %s -> %s\n", name, dst)
	return nil
}

// BuildVersion runs bin --version and returns the engine version it reports,
// e.g. "2026.07.04"; ok is false when the banner names none.
func BuildVersion(bin string) (version string, ok bool, err error) {
	banner, err := engineBannerVersion(bin)
	if err != nil {
		return "", false, fmt.Errorf("engine: run %s --version: %w", bin, err)
	}
	version, ok = parseEngineVersion(banner)
	return version, ok, nil
}

// CheckBuildVersion refuses a binary that reports a different engine version
// than the one it is about to be published for. A banner with no
// recognizable version is let through, as Locate does.
func CheckBuildVersion(bin, version string) error {
	got, ok, err := BuildVersion(bin)
	if err != nil {
		return err
	}
	if ok && !engineVersionMatches(got, version) {
		return fmt.Errorf("engine: %s is %s, not %s", bin, got, version)
	}
	return nil
}

// DownloadGunzipped streams a gzip from url into dst, decompressed, and
// returns the hex SHA-256 of what it wrote.
func DownloadGunzipped(ctx context.Context, url string, dst io.Writer) (string, error) {
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

// fileSHA256 returns the hex SHA-256 of a file's contents.
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// PatchedBuildKeyWindows names the object the WINDOWS patched build of this
// engine version and series revision is published under, for FogOfWar.exe:
// engines/<version>/windows-amd64/spring-headless-patched-<semver>.exe.gz.
// Same revision numbers as the Linux build (one series, two platforms); the
// platform is a directory so the two never share a name.
func PatchedBuildKeyWindows(version string, rev int) string {
	return "engines/" + version + "/windows-amd64/spring-headless-patched-" + PatchedVersion(version, rev) + ".exe.gz"
}
