// Command publish-engine checks and publishes a patched engine build, so every
// re-sim host downloads it (engine.EnsurePatchedEngine) instead of spending
// ~35 minutes compiling its own.
//
// Usage, from the repo root on a host with the engine and the build:
//
//	publish-engine -data <BARdata>                  # <data>/engine/*/spring-headless-patched
//	publish-engine -data <BARdata> <path to binary> # any other build
//	publish-engine -data <BARdata> -dry ...         # everything but the upload
//
// It does the whole job, in order:
//
//  1. Names the build. The engine version comes from the binary's own
//     --version (or -version), the revision from the patch series in
//     ./patches (engine.SeriesRevision — a series not pinned in
//     internal/engine/patchrev.go is refused), so the name, e.g.
//     2026.7.4-barreplay.1, says exactly which patches went in.
//  2. Re-simulates the gate replay on the STOCK engine (installing it and the
//     game content if needed).
//  3. Strips the debug info (strip --strip-debug: ~780 MB of DWARF sections
//     the engine never loads, which every host would otherwise download;
//     code, data and function names stay) into a copy beside the stock
//     binary, where the engine finds its base/ content.
//  4. Re-simulates the same replay on that stripped copy and requires the two
//     .brp files to be byte-identical. Both runs use THIS checkout's widget
//     and codec, so the comparison is about the engine alone — fixed
//     reference hashes would go stale with every capture-format change.
//  5. Uploads a gzip of the stripped binary to
//     engines/<version>/spring-headless-patched-<semver>.gz, only if that key
//     is free: the same binary again is a no-op, a DIFFERENT binary under a
//     taken name is an error (one version, one binary).
//  6. Prints the line to add to patchedBuilds in internal/engine/patcheddl.go
//     and the git tag to push once it is merged.
//
// Hosts start downloading the build only once the pin is merged: the pin in
// the repo, not the presence of an object in the bucket, is what says a build
// passed the gate. A failed gate keeps both captures and says where.
//
// The re-simulations take the data dir's lock, so a bringest -resim daemon
// using the same -data must be idle or stopped. Uploading needs
// R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (./.env is read, as bringest does);
// the account and bucket come from the worker's wrangler.jsonc.
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/engine"
	"github.com/mabn/barreplay/internal/envfile"
	"github.com/mabn/barreplay/internal/packer"
	"github.com/mabn/barreplay/internal/resim"
)

// gateReplays is the replay each engine version is gated on by default: the
// "medium" benchmark of patches/engine-2026.07.04/RESULTS.md, a 16-player
// 13-minute game — long and busy enough to exercise the patched code, short
// enough to run twice in a few minutes.
var gateReplays = map[string]string{
	"2026.07.04": "4936896a8b258d038cbd28f55eb15ed2",
}

// stripHint is the size past which a stripped binary has clearly kept its
// debug info, i.e. strip did not do its job.
const stripHint = 200 << 20

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "publish-engine:", err)
		os.Exit(1)
	}
}

func run() error {
	// Before the flags, so -data can default from it.
	if _, err := envfile.Load(".env"); err != nil {
		return err
	}
	dataDir := flag.String("data", os.Getenv("BAR_DATA_DIR"), "BAR data dir holding the stock engine (default $BAR_DATA_DIR); the gate runs in it")
	version := flag.String("version", "", "engine version the binary was built from; default: the only version under -data with a patched build, or what the named binary's --version reports")
	gate := flag.String("gate", "", "comma-separated gameIds to gate on, recorded on this engine version; default: the version's benchmark replay")
	workerDir := flag.String("worker-dir", "./worker", "worker project dir, for the account id and bucket in wrangler.jsonc")
	patchesDir := flag.String("patches", "./patches", "the repo's patches dir; the series in it names the build's revision")
	dry := flag.Bool("dry", false, "strip and gate, but upload nothing")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: publish-engine -data <BARdata> [-version <ver>] [path to spring-headless-patched]")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *dataDir == "" || flag.NArg() > 1 {
		flag.Usage()
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	// 1. Name it.
	bin, err := pickBinary(*dataDir, *version, flag.Arg(0))
	if err != nil {
		return err
	}
	if *version == "" {
		v, ok, err := engine.BuildVersion(bin)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("%s does not report its version; pass -version", bin)
		}
		*version, _, _ = strings.Cut(v, "-")
	}
	if err := engine.CheckBuildVersion(bin, *version); err != nil {
		return err
	}
	rev, err := engine.SeriesRevision(*patchesDir, *version)
	if err != nil {
		return err
	}
	name := engine.PatchedVersion(*version, rev)
	games, err := gateGames(*gate, *version)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "publish-engine: %s is patched build %s; gating on %s\n", bin, name, strings.Join(games, ", "))

	client := barapi.New()
	for _, id := range games {
		r, err := client.Resolve(ctx, id)
		if err != nil {
			return fmt.Errorf("gate replay %s: %w", id, err)
		}
		if r.EngineVersion != *version {
			return fmt.Errorf("gate replay %s was recorded on engine %s, not %s; pick one with -gate", id, r.EngineVersion, *version)
		}
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

	// 2. The stock engine's capture of each gate replay. Also what installs
	// the stock engine the stripped copy has to sit beside.
	stock := map[string]string{}
	for _, id := range games {
		fmt.Fprintf(os.Stderr, "\n== gate %s on the STOCK engine\n", id)
		p, err := resimulate(ctx, client, id, *dataDir, filepath.Join(work, "stock"), "")
		if err != nil {
			return err
		}
		stock[id] = p
	}

	// 3. Strip into the engine dir, under a name Locate never prefers.
	engDir := filepath.Join(*dataDir, "engine", *version)
	stripped := filepath.Join(engDir, ".spring-headless-patched.publishing")
	defer os.Remove(stripped)
	fmt.Fprintf(os.Stderr, "\n== strip --strip-debug %s\n", bin)
	cmd := exec.CommandContext(ctx, "strip", "--strip-debug", "-o", stripped, bin)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("strip (install binutils if it is missing): %w", err)
	}

	// 4. The stripped build must capture the same bytes.
	for _, id := range games {
		fmt.Fprintf(os.Stderr, "\n== gate %s on the PATCHED build\n", id)
		p, err := resimulate(ctx, client, id, *dataDir, filepath.Join(work, "patched"), stripped)
		if err != nil {
			return err
		}
		same, a, b, err := sameFile(stock[id], p)
		if err != nil {
			return err
		}
		if !same {
			keepWork = true
			return fmt.Errorf("GATE FAILED on %s: the patched build's capture differs from the stock engine's "+
				"(sha256 %s vs %s; both kept under %s). Do not publish this build", id, b, a, work)
		}
		fmt.Fprintf(os.Stderr, "gate %s: identical (sha256 %s)\n", id, a)
	}

	// 5. Upload.
	raw, err := os.ReadFile(stripped)
	if err != nil {
		return err
	}
	if len(raw) > stripHint {
		return fmt.Errorf("%s is still %d MB after strip --strip-debug; refusing to make every host download it", bin, len(raw)>>20)
	}
	sum := sha256.Sum256(raw)
	shaHex := hex.EncodeToString(sum[:])
	key := engine.PatchedBuildKey(*version, rev)
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
	fmt.Fprintf(os.Stderr, "\n== %s: %d MB, %d MB gzipped, sha256 %s\n", name, len(raw)>>20, gz.Len()>>20, shaHex)
	if *dry {
		fmt.Fprintf(os.Stderr, "-dry: not uploading %s\n", key)
	} else {
		c := packer.NewR2ClientFromEnv(*workerDir)
		if c == nil {
			return fmt.Errorf("no R2 credentials: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (or put them in ./.env)")
		}
		created, err := c.PutIfAbsent(ctx, key, gz.Bytes())
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

	// 6. What to commit and tag.
	fmt.Printf("\nAdd to patchedBuilds in internal/engine/patcheddl.go:\n\n")
	fmt.Printf("\t%q: {Rev: %d, SHA256: %q}, // %s\n", *version, rev, shaHex, name)
	fmt.Printf("\nOnce that is merged, tag the source it was built from:\n\n")
	tag := engine.PatchedVersionTag(*version, rev)
	fmt.Printf("\tgit fetch origin && git tag -a %s -m %q origin/main && git push origin %s\n",
		tag, "patched engine "+name+", sha256 "+shaHex, tag)
	return nil
}

// pickBinary is the build to publish: the one named, else the patched build
// under dataDir for version, else the only patched build under dataDir.
func pickBinary(dataDir, version, named string) (string, error) {
	if named != "" {
		return named, nil
	}
	if version != "" {
		return filepath.Join(dataDir, "engine", version, "spring-headless-patched"), nil
	}
	found, _ := filepath.Glob(filepath.Join(dataDir, "engine", "*", "spring-headless-patched"))
	switch len(found) {
	case 1:
		return found[0], nil
	case 0:
		return "", fmt.Errorf("no spring-headless-patched under %s; name the binary", filepath.Join(dataDir, "engine"))
	default:
		return "", fmt.Errorf("several patched builds under %s (%s); pass -version", filepath.Join(dataDir, "engine"), strings.Join(found, ", "))
	}
}

// gateGames is the -gate list, or the version's default replay.
func gateGames(flagValue, version string) ([]string, error) {
	var ids []string
	for _, id := range strings.Split(flagValue, ",") {
		if id = strings.TrimSpace(id); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) > 0 {
		return ids, nil
	}
	if id, ok := gateReplays[version]; ok {
		return []string{id}, nil
	}
	return nil, fmt.Errorf("no default gate replay for engine %s; name one recorded on it with -gate", version)
}

// resimulate captures gameID into outDir on the engine at bin, or on the
// stock engine when bin is empty.
func resimulate(ctx context.Context, client *barapi.Client, gameID, dataDir, outDir, bin string) (string, error) {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", err
	}
	stats := &resim.RunStats{}
	p, _, err := resim.Run(ctx, client, gameID, resim.Options{
		DataDir:       dataDir,
		OutDir:        outDir,
		EngineBinary:  bin,
		ProgressEvery: 10 * time.Second,
		Stats:         stats,
	})
	if err != nil {
		return "", fmt.Errorf("re-simulating %s: %w", gameID, err)
	}
	if stats.Infolog.Desyncs > 0 {
		return "", fmt.Errorf("re-simulating %s: the engine reported %d desyncs", gameID, stats.Infolog.Desyncs)
	}
	fmt.Fprintf(os.Stderr, "sim %.0fs, %d frames, %.0fx realtime\n", stats.SimSec, stats.Frames, stats.SpeedUp)
	return p, nil
}

// sameFile compares two files by content and returns both hashes.
func sameFile(a, b string) (same bool, shaA, shaB string, err error) {
	if shaA, err = fileSHA(a); err != nil {
		return false, "", "", err
	}
	if shaB, err = fileSHA(b); err != nil {
		return false, "", "", err
	}
	return shaA == shaB, shaA, shaB, nil
}

func fileSHA(path string) (string, error) {
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

// samePublished checks that the object already at key holds the binary
// being published. A different one means this revision's name is taken by
// other bytes.
func samePublished(ctx context.Context, key, shaHex string) error {
	got, err := engine.DownloadGunzipped(ctx, engine.PatchedBuildBaseURL+"/"+key, io.Discard)
	if err != nil {
		return fmt.Errorf("%s is already published and could not be read back to compare: %w", key, err)
	}
	if got != shaHex {
		return fmt.Errorf("%s is already published with a DIFFERENT binary (sha256 %s, this one is %s): "+
			"one version names one binary, so either use the published one or change the patch series, which makes a new revision", key, got, shaHex)
	}
	return nil
}
