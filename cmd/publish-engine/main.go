// Command publish-engine uploads a gated patched engine build to the bucket,
// so every re-sim host downloads it (engine.EnsurePatchedEngine) instead of
// spending ~35 minutes compiling its own.
//
// Usage:
//
//	publish-engine -version 2026.07.04 <data>/engine/2026.07.04/spring-headless-patched
//
// The build is named by its semver, engine.PatchedVersion: the engine version
// plus the revision of the patch series in ./patches (engine.SeriesRevision —
// a series not pinned in internal/engine/patchrev.go is refused, so a name
// always says exactly which patches went in). It gzips the binary and uploads
// it to engines/<version>/spring-headless-patched-<semver>.gz only if that key
// is free: the same binary again is a no-op, a DIFFERENT binary under a taken
// name is an error (one version, one binary), so nothing a host may be
// downloading is ever overwritten. It then prints the line to add to
// patchedBuilds in internal/engine/patcheddl.go and the git tag that marks the
// source. Hosts start downloading the build only once that line is merged: the
// pin in the repo, not the presence of an object in the bucket, is what says a
// build passed the byte-identity gate (docs/building-recoil.md, "The PATCHED
// build"). Publish nothing that has not.
//
// Needs R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (./.env is read, as bringest
// does); the account and bucket come from the worker's wrangler.jsonc. -dry
// prints the hash and key without uploading.
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
	"os/signal"

	"github.com/mabn/barreplay/internal/engine"
	"github.com/mabn/barreplay/internal/envfile"
	"github.com/mabn/barreplay/internal/packer"
)

// stripHint is the size past which the binary almost certainly still carries
// its debug info (~780 MB of it), which every host would then download.
const stripHint = 200 << 20

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "publish-engine:", err)
		os.Exit(1)
	}
}

func run() error {
	version := flag.String("version", "", "engine version the binary was built from, e.g. 2026.07.04 (required)")
	workerDir := flag.String("worker-dir", "./worker", "worker project dir, for the account id and bucket in wrangler.jsonc")
	patchesDir := flag.String("patches", "./patches", "the repo's patches dir; the series in it names the build's revision")
	dry := flag.Bool("dry", false, "print the hash and key, upload nothing")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: publish-engine -version <ver> <path to spring-headless-patched>")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *version == "" || flag.NArg() != 1 {
		flag.Usage()
		os.Exit(2)
	}
	bin := flag.Arg(0)
	if _, err := envfile.Load(".env"); err != nil {
		return err
	}

	if err := engine.CheckBuildVersion(bin, *version); err != nil {
		return err
	}
	rev, err := engine.SeriesRevision(*patchesDir, *version)
	if err != nil {
		return err
	}
	name := engine.PatchedVersion(*version, rev)
	raw, err := os.ReadFile(bin)
	if err != nil {
		return err
	}
	if len(raw) > stripHint {
		fmt.Fprintf(os.Stderr, "warning: %s is %d MB, so it probably still has its debug info; "+
			"`strip --strip-debug` a copy first and every host downloads a fraction of it\n", bin, len(raw)>>20)
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
	fmt.Fprintf(os.Stderr, "%s: patched build %s, %d MB, %d MB gzipped, sha256 %s\n", bin, name, len(raw)>>20, gz.Len()>>20, shaHex)

	if !*dry {
		c := packer.NewR2ClientFromEnv(*workerDir)
		if c == nil {
			return fmt.Errorf("no R2 credentials: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (or put them in ./.env)")
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
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

	fmt.Printf("\nAdd to patchedBuilds in internal/engine/patcheddl.go:\n\n")
	fmt.Printf("\t%q: {Rev: %d, SHA256: %q}, // %s\n", *version, rev, shaHex, name)
	fmt.Printf("\nOnce that is merged, tag the source it was built from (any commit with this series):\n\n")
	tag := engine.PatchedVersionTag(*version, rev)
	fmt.Printf("\tgit tag -a %s -m %q origin/main && git push origin %s\n", tag, "patched engine "+name+", sha256 "+shaHex, tag)
	return nil
}

// samePublished checks that the object already at key holds the binary
// being published. A different one means this revision's name is taken by
// other bytes, which only a new revision of the series may fix.
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
