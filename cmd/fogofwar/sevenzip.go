package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/bodgit/sevenzip"
)

// extract7z unpacks a 7z archive into dir in-process. Windows ships no 7z
// command, and the engine release is a 7z, so the app brings its own reader
// (engine.Extract7z).
func extract7z(ctx context.Context, archive, dir string) error {
	r, err := sevenzip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	root, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	for _, f := range r.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		dst := filepath.Join(root, filepath.FromSlash(f.Name))
		// Refuse entries that would land outside dir ("../" in a name).
		if dst != root && !strings.HasPrefix(dst, root+string(os.PathSeparator)) {
			return fmt.Errorf("7z: entry %q escapes the target directory", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := extractOne(f, dst); err != nil {
			return fmt.Errorf("7z: %s: %w", f.Name, err)
		}
	}
	return nil
}

func extractOne(f *sevenzip.File, dst string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, rc); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
