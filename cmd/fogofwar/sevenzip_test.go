package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestExtractRecoilRelease unpacks a real Recoil release when one is named in
// FOGOFWAR_TEST_7Z (the archives are tens of MB, so none is committed).
func TestExtractRecoilRelease(t *testing.T) {
	src := os.Getenv("FOGOFWAR_TEST_7Z")
	if src == "" {
		t.Skip("FOGOFWAR_TEST_7Z not set")
	}
	dir := t.TempDir()
	if err := extract7z(context.Background(), src, dir); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"spring-headless.exe", "pr-downloader.exe", "base"} {
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			t.Errorf("missing %s: %v", n, err)
		}
	}
}
