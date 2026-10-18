// Command upload-maps uploads high-resolution BAR map images (the PNGs the
// BAR team provided, named like AcidicQuarry_5.17_4096x4096.png) into the
// replay bucket under maps/highres/, keeping each file's name as its key.
//
// Usage, from the repo root (it reads ./.env for the R2 credentials, like
// bringest and publish-engine):
//
//	go run ./cmd/upload-maps <dir or file.png>...
//	go run ./cmd/upload-maps -dry <dir>      # list what would be uploaded
//
// A file already in the bucket with the same size is skipped, so a run that
// stops halfway can simply be started again. Uploads run -j at a time.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/mabn/barreplay/internal/envfile"
	"github.com/mabn/barreplay/internal/packer"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "upload-maps:", err)
		os.Exit(1)
	}
}

// bucket is what upload-maps needs of the R2 client.
type bucket interface {
	Size(ctx context.Context, key string) (int64, bool, error)
	PutWithMeta(ctx context.Context, key string, body []byte, contentType, cacheControl string) error
}

type options struct {
	prefix       string
	cacheControl string
	jobs         int
	dry          bool
	force        bool
}

func run() error {
	if _, err := envfile.Load(".env"); err != nil {
		return err
	}
	var o options
	flag.StringVar(&o.prefix, "prefix", "maps/highres/", "key prefix in the bucket")
	flag.StringVar(&o.cacheControl, "cache-control", "public, max-age=31536000, immutable", "Cache-Control stored on each object (the names carry the map version, so the bytes under one never change)")
	flag.IntVar(&o.jobs, "j", 8, "uploads at once")
	flag.BoolVar(&o.dry, "dry", false, "check the bucket and list what would be uploaded, upload nothing")
	flag.BoolVar(&o.force, "force", false, "upload even when the bucket already has a file of the same size")
	workerDir := flag.String("worker-dir", "./worker", "worker project dir, for the account id and bucket in wrangler.jsonc")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: upload-maps [flags] <dir or file.png>...")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	if o.jobs < 1 {
		o.jobs = 1
	}
	files, err := pngFiles(flag.Args())
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no .png files in %s", strings.Join(flag.Args(), " "))
	}
	client := packer.NewR2ClientFromEnv(*workerDir)
	if client == nil {
		return fmt.Errorf("no R2 credentials: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (in ./.env or the environment)")
	}
	fmt.Fprintf(os.Stderr, "bucket %s, prefix %s\n", client.Bucket, o.prefix)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return upload(ctx, client, files, o)
}

// pngFiles expands the arguments into .png files, sorted by name. A
// directory contributes the .png files directly inside it.
func pngFiles(args []string) ([]string, error) {
	var files []string
	for _, a := range args {
		st, err := os.Stat(a)
		if err != nil {
			return nil, err
		}
		if !st.IsDir() {
			files = append(files, a)
			continue
		}
		entries, err := os.ReadDir(a)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if e.Type().IsRegular() && strings.EqualFold(filepath.Ext(e.Name()), ".png") {
				files = append(files, filepath.Join(a, e.Name()))
			}
		}
	}
	sort.Slice(files, func(i, j int) bool { return filepath.Base(files[i]) < filepath.Base(files[j]) })
	return files, nil
}

// upload sends every file to prefix+<file name>, skipping those the bucket
// already holds at the same size. It goes on past a failed file and reports
// the failures at the end, so one bad file does not stop the other uploads.
func upload(ctx context.Context, b bucket, files []string, o options) error {
	var total int64
	for _, f := range files {
		st, err := os.Stat(f)
		if err != nil {
			return err
		}
		total += st.Size()
	}
	fmt.Fprintf(os.Stderr, "%d files, %s\n", len(files), human(total))

	var done, uploaded, skipped, failed atomic.Int64
	var bytesDone atomic.Int64
	var mu sync.Mutex
	report := func(format string, a ...any) {
		mu.Lock()
		defer mu.Unlock()
		n := done.Add(1)
		fmt.Fprintf(os.Stderr, "[%d/%d %s/%s] %s\n", n, len(files), human(bytesDone.Load()), human(total), fmt.Sprintf(format, a...))
	}

	work := make(chan string)
	var wg sync.WaitGroup
	for range min(o.jobs, len(files)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for f := range work {
				key := o.prefix + filepath.Base(f)
				st, err := os.Stat(f)
				if err != nil {
					failed.Add(1)
					report("FAILED %s: %v", key, err)
					continue
				}
				if !o.force {
					size, exists, err := b.Size(ctx, key)
					if err != nil {
						failed.Add(1)
						report("FAILED %s: %v", key, err)
						continue
					}
					if exists && size == st.Size() {
						skipped.Add(1)
						bytesDone.Add(st.Size())
						report("skipped %s (already uploaded)", key)
						continue
					}
				}
				if o.dry {
					uploaded.Add(1)
					bytesDone.Add(st.Size())
					report("would upload %s (%s)", key, human(st.Size()))
					continue
				}
				body, err := os.ReadFile(f)
				if err == nil {
					err = b.PutWithMeta(ctx, key, body, "image/png", o.cacheControl)
				}
				if err != nil {
					failed.Add(1)
					report("FAILED %s: %v", key, err)
					continue
				}
				uploaded.Add(1)
				bytesDone.Add(st.Size())
				report("uploaded %s (%s)", key, human(st.Size()))
			}
		}()
	}
	for _, f := range files {
		if ctx.Err() != nil {
			break
		}
		work <- f
	}
	close(work)
	wg.Wait()

	verb := "uploaded"
	if o.dry {
		verb = "to upload"
	}
	fmt.Fprintf(os.Stderr, "done: %d %s, %d skipped, %d failed\n", uploaded.Load(), verb, skipped.Load(), failed.Load())
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if n := failed.Load(); n > 0 {
		return fmt.Errorf("%d files failed; run the same command again to retry them", n)
	}
	return nil
}

func human(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}
