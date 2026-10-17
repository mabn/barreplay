// Engine provisioning. pr-downloader fetches the game archive and the map, but
// nothing fetched the ENGINE itself, so a replay recorded on a newer build
// silently re-simulated on whatever build happened to be installed. That is not
// a cosmetic mismatch: the sim is only deterministic against the exact engine
// the demo was recorded with, so a mismatch desyncs within seconds and the
// capture becomes fiction that still looks like a normal result.
//
// The engine ships on GitHub Releases as one 7z per platform. Go's stdlib
// cannot read 7z (and the repo takes no third-party deps), so extraction shells
// out to 7z/7za — the same "external tool must exist" contract pr-downloader
// already has, with an actionable error when it does not.
package engine

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// EngineReleaseURL builds the download URL for a Recoil release asset. Exposed
// so tests can point it at a local server.
var EngineReleaseURL = func(version, asset string) string {
	return "https://github.com/beyond-all-reason/RecoilEngine/releases/download/" + version + "/" + asset
}

// engineAsset names the release archive for the current platform, e.g.
// "recoil_2026.07.04_amd64-linux.7z". Only the platforms the release publishes
// are supported; anything else is an explicit error rather than a 404 later.
func engineAsset(version string) (string, error) {
	var arch string
	switch runtime.GOARCH {
	case "amd64":
		arch = "amd64"
	case "arm64":
		arch = "arm64"
	default:
		return "", fmt.Errorf("no Recoil release for GOARCH %q", runtime.GOARCH)
	}
	switch runtime.GOOS {
	case "linux":
		return fmt.Sprintf("recoil_%s_%s-linux.7z", version, arch), nil
	case "windows":
		return fmt.Sprintf("recoil_%s_%s-windows.7z", version, arch), nil
	default:
		return "", fmt.Errorf("no Recoil release for GOOS %q", runtime.GOOS)
	}
}

// EnsureEngine makes <DataDir>/engine/<version>/ hold the headless engine for
// exactly this version, downloading and extracting the release when it does
// not. It is a no-op when the binary is already there (so it is safe to call on
// every run), when provisioning is disabled, or when the caller pinned an
// explicit binary with EngineBinary.
//
// Errors are returned rather than warned about: unlike a missing map, carrying
// on here means re-simulating on the wrong engine, which silently corrupts the
// capture. Callers that genuinely want the old best-effort behaviour can set
// SkipProvision.
func EnsureEngine(ctx context.Context, cfg Config, version string) error {
	if cfg.SkipProvision || cfg.EngineBinary != "" {
		return nil
	}
	if version == "" {
		return fmt.Errorf("engine: cannot provision: the demo declares no engine version")
	}
	dir := filepath.Join(cfg.DataDir, "engine", version)
	if fileExists(filepath.Join(dir, headlessName())) {
		return nil
	}
	asset, err := engineAsset(version)
	if err != nil {
		return fmt.Errorf("engine: %w", err)
	}
	return installRelease(ctx, version, asset, dir, headlessName(), prdName())
}

// WindowsReleaseDir is where EnsureWindowsEngine installs the stock WINDOWS
// release of an engine version inside a (Linux) data dir: a dir of its own
// beside the native one, since the two releases share file names (base/,
// fonts/). Not inside it: EnsureEngine replaces the native dir wholesale.
// Locate never picks it up, since nothing in it has the native binary's name.
func WindowsReleaseDir(dataDir, version string) string {
	return filepath.Join(dataDir, "engine", version+"-windows-amd64")
}

// EnsureWindowsEngine installs the stock amd64-windows release of version at
// WindowsReleaseDir, whatever platform this runs on. It exists for
// cmd/publish-engine -windows, which gates a Windows patched build under Wine
// from a Linux host: the patched exe resolves base/ relative to itself, so it
// has to run from inside a stock Windows install.
func EnsureWindowsEngine(ctx context.Context, dataDir, version string) (string, error) {
	dir := WindowsReleaseDir(dataDir, version)
	if fileExists(filepath.Join(dir, "spring-headless.exe")) {
		return dir, nil
	}
	asset := fmt.Sprintf("recoil_%s_amd64-windows.7z", version)
	return dir, installRelease(ctx, version, asset, dir, "spring-headless.exe", "pr-downloader.exe")
}

// installRelease downloads one Recoil release asset and extracts it into dir,
// which must end up holding headless.
func installRelease(ctx context.Context, version, asset, dir, headless, prd string) error {
	extractor, err := sevenZip()
	if err != nil {
		return fmt.Errorf("engine %s is not installed at %s and cannot be extracted: %w", version, dir, err)
	}

	fmt.Fprintf(os.Stderr, "engine: %s not installed; downloading %s\n", version, asset)
	tmp, err := os.CreateTemp("", "recoil-*.7z")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := download(ctx, EngineReleaseURL(version, asset), tmp); err != nil {
		return fmt.Errorf("engine: download %s: %w", asset, err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	// Extract into a staging dir and move it into place only once complete, so
	// an interrupted download can never leave a half-populated engine dir that
	// the next run would treat as installed.
	// A fresh data dir has no engine/ yet, and MkdirTemp will not create its
	// parent.
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(filepath.Dir(dir), ".staging-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	cmd := exec.CommandContext(ctx, extractor, "x", "-y", "-o"+staging, tmp.Name())
	cmd.Stdout, cmd.Stderr = io.Discard, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("engine: extract %s with %s: %w", asset, extractor, err)
	}
	if !fileExists(filepath.Join(staging, headless)) {
		return fmt.Errorf("engine: %s contains no %s", asset, headless)
	}
	// 7z restores the archived permission bits, but a release built elsewhere
	// may not carry them; exec needs +x regardless.
	for _, n := range []string{headless, prd} {
		if p := filepath.Join(staging, n); fileExists(p) {
			os.Chmod(p, 0o755)
		}
	}
	// MkdirTemp creates 0700 and Rename preserves it, which would leave the
	// installed engine private and inconsistent with a manual install.
	if err := os.Chmod(staging, 0o755); err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.Rename(staging, dir); err != nil {
		return fmt.Errorf("engine: install into %s: %w", dir, err)
	}
	fmt.Fprintf(os.Stderr, "engine: installed %s -> %s\n", version, dir)
	return nil
}

// sevenZip finds the extractor. p7zip ships the command under two names and
// distros disagree on which, so both are tried.
func sevenZip() (string, error) {
	for _, n := range []string{"7z", "7za", "7zr"} {
		if p, err := exec.LookPath(n); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no 7z on $PATH (install p7zip-full), or install the engine manually under <data>/engine/<version>/")
}

func download(ctx context.Context, url string, dst io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	_, err = io.Copy(dst, resp.Body)
	return err
}

// engineBannerVersion returns the binary's `--version` banner. The engine
// prints it and exits immediately, so this costs milliseconds.
func engineBannerVersion(bin string) (string, error) {
	out, err := exec.Command(bin, "--version").Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// parseEngineVersion pulls the version token out of a `spring-headless
// --version` banner. ok is false when the banner has no recognizable version,
// which callers must treat as "cannot tell" rather than "wrong": refusing to
// run against an unfamiliar banner format would break every custom build.
func parseEngineVersion(banner string) (string, bool) {
	i := strings.Index(banner, "version ")
	if i < 0 {
		return "", false
	}
	got, _, _ := strings.Cut(strings.TrimSpace(banner[i+len("version "):]), " ")
	// A version token starts with a digit. Without this, the word "version"
	// appearing in any unrelated line yields a confident bogus parse — and a
	// bogus parse is worse than no parse, because it turns into a refusal to
	// run a perfectly good engine.
	if got == "" || got[0] < '0' || got[0] > '9' {
		return "", false
	}
	return got, true
}

// engineVersionMatches reports whether a parsed version token belongs to want.
// Releases append build detail ("2025.06.24-15-g8f4a4bf"), and an engine built
// locally off that tag is still the right engine, so a "<want>-" prefix counts
// — but a bare longer version does not (2025.06.2 must not match 2025.06.24).
func engineVersionMatches(got, want string) bool {
	return got == want || strings.HasPrefix(got, want+"-")
}
