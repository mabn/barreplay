// Command publish-engine uploads a gated patched engine build to the bucket,
// so every re-sim host downloads it (engine.EnsurePatchedEngine) instead of
// spending ~35 minutes compiling its own.
//
// Usage:
//
//	publish-engine -version 2026.07.04 <data>/engine/2026.07.04/spring-headless-patched
//
// It gzips the binary, uploads it under engines/<version>/<name>-<sha>.gz —
// content-addressed and written only if absent, so nothing a host may be
// downloading is ever overwritten — and prints the line to add to
// patchedBuilds in internal/engine/patcheddl.go. Hosts start downloading the
// build only once that line is merged: the pin in the repo, not the presence
// of an object in the bucket, is what says a build passed the byte-identity
// gate (docs/building-recoil.md, "The PATCHED build"). Publish nothing that
// has not.
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
	key := engine.PatchedBuildKey(*version, shaHex)

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
	fmt.Fprintf(os.Stderr, "%s: %d MB, %d MB gzipped, sha256 %s\n", bin, len(raw)>>20, gz.Len()>>20, shaHex)

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
		} else {
			fmt.Fprintf(os.Stderr, "%s is already published\n", key)
		}
	}

	fmt.Printf("\nAdd to patchedBuilds in internal/engine/patcheddl.go:\n\n")
	fmt.Printf("\t%q: {Key: %q, SHA256: %q},\n", *version, key, shaHex)
	return nil
}
