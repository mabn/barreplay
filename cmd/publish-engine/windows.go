package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/engine"
	"github.com/mabn/barreplay/internal/packer"
)

// windowsOptions is what -windows needs from the command line.
type windowsOptions struct {
	dataDir, version, gate, patchesDir, wine, exe string
	r2                                            *packer.R2Client // nil = -dry
}

// runWindows publishes a WINDOWS patched build (spring-headless.exe from
// patches/engine-<version>/windows/build.sh) from a LINUX host, gating it under
// Wine against the stock LINUX engine:
//
//  1. Installs the stock amd64-windows release beside the native one
//     (engine.EnsureWindowsEngine) — the patched exe resolves base/ relative
//     to itself, so it runs from inside that install, as FogOfWar.exe will.
//  2. Strips its debug info into that dir and names it from its own
//     --version and ./patches, exactly like the Linux build.
//  3. Re-simulates the gate replay on the stock Linux engine and on the
//     stripped exe under Wine, and requires byte-identical .brp files. That is
//     a stronger claim than the Linux gate's — same capture across the patches
//     AND across platforms — and the one the volunteer pool depends on: a
//     Windows worker's result must be interchangeable with a Linux host's.
//  4. Uploads engines/<version>/windows-amd64/spring-headless-patched-<semver>.exe.gz
//     (engine.PatchedBuildKeyWindows), and prints the patchedBuildsWindows pin.
func runWindows(ctx context.Context, o windowsOptions) error {
	wine, err := findWine(o.wine)
	if err != nil {
		return err
	}
	work, err := os.MkdirTemp("", "publish-engine-*")
	if err != nil {
		return err
	}
	keepWork := false
	defer func() {
		if !keepWork {
			os.RemoveAll(work)
		}
	}()

	// The version first, to know which stock release to install it into. It
	// cannot come from the exe's own --version yet: outside a stock install
	// it lacks the DLLs it links against (libIL, libcurl, ...) and Windows
	// will not start it. So it is the one series with a Windows build in
	// ./patches; the exe's --version is checked once it sits in the install.
	if o.version == "" {
		found, _ := filepath.Glob(filepath.Join(o.patchesDir, "engine-*", "windows", "build.sh"))
		if len(found) != 1 {
			return fmt.Errorf("%d patch series under %s have a Windows build; pass -version", len(found), o.patchesDir)
		}
		o.version = strings.TrimPrefix(filepath.Base(filepath.Dir(filepath.Dir(found[0]))), "engine-")
	}
	rev, err := engine.SeriesRevision(o.patchesDir, o.version)
	if err != nil {
		return err
	}
	name := engine.PatchedVersion(o.version, rev)
	games, err := gateGames(o.gate, o.version)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "publish-engine: %s is the Windows patched build %s; gating under %s on %s\n", o.exe, name, wine, strings.Join(games, ", "))

	client := barapi.New()
	for _, id := range games {
		r, err := client.Resolve(ctx, id)
		if err != nil {
			return fmt.Errorf("gate replay %s: %w", id, err)
		}
		if r.EngineVersion != o.version {
			return fmt.Errorf("gate replay %s was recorded on engine %s, not %s; pick one with -gate", id, r.EngineVersion, o.version)
		}
	}

	// 1. The stock Windows release to run it from.
	winDir, err := engine.EnsureWindowsEngine(ctx, o.dataDir, o.version)
	if err != nil {
		return err
	}

	// 2. Strip into it, under a name nothing looks for.
	stripped := filepath.Join(winDir, ".spring-headless-patched.publishing.exe")
	defer os.Remove(stripped)
	fmt.Fprintf(os.Stderr, "\n== strip --strip-debug %s\n", o.exe)
	cmd := exec.CommandContext(ctx, "strip", "--strip-debug", "-o", stripped, o.exe)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("strip (binutils reads PE files; install it if missing): %w", err)
	}
	wrapStripped := filepath.Join(work, "wine-stripped")
	if err := writeWineWrapper(wrapStripped, wine, stripped); err != nil {
		return err
	}
	if err := engine.CheckBuildVersion(wrapStripped, o.version); err != nil {
		return err
	}

	// 3. Linux stock vs the Windows build.
	for _, id := range games {
		fmt.Fprintf(os.Stderr, "\n== gate %s on the STOCK Linux engine\n", id)
		a, err := resimulate(ctx, client, id, o.dataDir, filepath.Join(work, "stock"), "")
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "\n== gate %s on the WINDOWS patched build, under Wine\n", id)
		b, err := resimulate(ctx, client, id, o.dataDir, filepath.Join(work, "windows"), wrapStripped)
		if err != nil {
			return err
		}
		same, sa, sb, err := sameFile(a, b)
		if err != nil {
			return err
		}
		if !same {
			keepWork = true
			return fmt.Errorf("GATE FAILED on %s: the Windows build's capture differs from the stock Linux engine's "+
				"(sha256 %s vs %s; both kept under %s). Do not publish this build", id, sb, sa, work)
		}
		fmt.Fprintf(os.Stderr, "gate %s: identical (sha256 %s)\n", id, sa)
	}

	// 4. Upload.
	raw, err := os.ReadFile(stripped)
	if err != nil {
		return err
	}
	if len(raw) > stripHint {
		return fmt.Errorf("%s is still %d MB after strip --strip-debug; refusing to make every volunteer download it", o.exe, len(raw)>>20)
	}
	sum := sha256.Sum256(raw)
	shaHex := hex.EncodeToString(sum[:])
	key := engine.PatchedBuildKeyWindows(o.version, rev)
	var gz bytes.Buffer
	zw, err := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	if err != nil {
		return err
	}
	if _, err := zw.Write(raw); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "\n== %s (windows-amd64): %d MB, %d MB gzipped, sha256 %s\n", name, len(raw)>>20, gz.Len()>>20, shaHex)
	if o.r2 == nil {
		fmt.Fprintf(os.Stderr, "-dry: not uploading %s\n", key)
	} else {
		created, err := o.r2.PutIfAbsent(ctx, key, gz.Bytes())
		if err != nil {
			return err
		}
		if created {
			fmt.Fprintf(os.Stderr, "uploaded %s\n", key)
		} else if err := samePublished(ctx, key, shaHex); err != nil {
			return err
		} else {
			fmt.Fprintf(os.Stderr, "%s is already published with these bytes\n", key)
		}
	}
	fmt.Printf("\nAdd to patchedBuildsWindows in internal/engine/patcheddl.go:\n\n")
	fmt.Printf("\t%q: {Rev: %d, SHA256: %q}, // %s windows-amd64\n", o.version, rev, shaHex, name)
	return nil
}

// findWine is the Wine loader to run a 64-bit exe with: the named one, else
// the first of wine64 / wine on $PATH, else Debian's /usr/lib/wine/wine64
// (the wine64 package installs it there and nothing on $PATH).
func findWine(named string) (string, error) {
	if named != "" {
		return named, nil
	}
	for _, n := range []string{"wine64", "wine"} {
		if p, err := exec.LookPath(n); err == nil {
			return p, nil
		}
	}
	if fileExists("/usr/lib/wine/wine64") {
		return "/usr/lib/wine/wine64", nil
	}
	return "", fmt.Errorf("no Wine found to gate the Windows build with: install wine64 (apt-get install wine64) or pass -wine")
}

// writeWineWrapper writes an executable script that runs exe under wine with
// the arguments the engine is launched with, turning every absolute unix path
// into a Z: path. Wine maps Z: to /, and the engine needs it: handed a bare
// "/tmp/data" as --write-dir, the Windows build resolves the dir, but its
// archive scan finds nothing in it and the replay fails with its map "not
// found". The demo path inside the startscript is resolved fine as it is.
func writeWineWrapper(path, wine, exe string) error {
	script := `#!/bin/bash
export WINEDEBUG=${WINEDEBUG:--all}
args=()
for a in "$@"; do
	if [[ $a == /* ]]; then a="Z:${a//\//\\}"; fi
	args+=("$a")
done
exec ` + shellQuote(wine) + ` ` + shellQuote(exe) + ` "${args[@]}"
`
	return os.WriteFile(path, []byte(script), 0o755)
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
