package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type fakeBucket struct {
	mu      sync.Mutex
	objects map[string][]byte
	types   map[string]string
	puts    int
}

func (b *fakeBucket) Size(_ context.Context, key string) (int64, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	body, ok := b.objects[key]
	return int64(len(body)), ok, nil
}

func (b *fakeBucket) PutWithMeta(_ context.Context, key string, body []byte, contentType, _ string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if key == "maps/highres/Broken_1.0_4096x4096.png" {
		return fmt.Errorf("boom")
	}
	b.objects[key] = body
	b.types[key] = contentType
	b.puts++
	return nil
}

func TestUploadSkipsSameSizeAndKeepsGoingPastFailures(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("AcidicQuarry_5.17_4096x4096.png", "aaaa")
	write("Avalanche_3.4_4096x4096.png", "bbbbbb")
	write("Aurelia_v4.1_4096x4096.png", "new bytes")
	write("Broken_1.0_4096x4096.png", "x")
	write("notes.txt", "not a map")

	b := &fakeBucket{
		objects: map[string][]byte{
			"maps/highres/AcidicQuarry_5.17_4096x4096.png": []byte("AAAA"), // same size: skipped
			"maps/highres/Aurelia_v4.1_4096x4096.png":      []byte("old"),  // different size: replaced
		},
		types: map[string]string{},
	}
	files, err := pngFiles([]string{dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 4 {
		t.Fatalf("found %d png files, want 4: %v", len(files), files)
	}
	err = upload(context.Background(), b, files, options{prefix: "maps/highres/", jobs: 3})
	if err == nil {
		t.Fatal("want an error naming the failed file")
	}
	if b.puts != 2 {
		t.Errorf("puts = %d, want 2 (Avalanche, Aurelia)", b.puts)
	}
	if got := string(b.objects["maps/highres/AcidicQuarry_5.17_4096x4096.png"]); got != "AAAA" {
		t.Errorf("same-size file was re-uploaded: %q", got)
	}
	if got := b.types["maps/highres/Avalanche_3.4_4096x4096.png"]; got != "image/png" {
		t.Errorf("content type = %q", got)
	}

	b.puts = 0
	if err := upload(context.Background(), b, files[:3], options{prefix: "maps/highres/", jobs: 2, dry: true}); err != nil {
		t.Fatal(err)
	}
	if b.puts != 0 {
		t.Errorf("dry run uploaded %d files", b.puts)
	}
}
