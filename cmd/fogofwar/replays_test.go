package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPruneReplaysKeepsNewestAndOnlyOwnFiles(t *testing.T) {
	dir := t.TempDir()
	put := func(name string, age time.Duration) {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(-age)
		os.Chtimes(p, at, at)
	}
	for i := 0; i < 5; i++ {
		put(fmt.Sprintf("%032x.brp", i), time.Duration(i)*time.Hour)
	}
	put("notes.brp", 100*time.Hour)
	put(fmt.Sprintf("%032x.txt", 9), 100*time.Hour)

	removed := pruneReplays(dir, 3)
	if len(removed) != 2 || removed[0] != fmt.Sprintf("%032x.brp", 3) || removed[1] != fmt.Sprintf("%032x.brp", 4) {
		t.Fatalf("removed %q", removed)
	}
	for _, keep := range []string{fmt.Sprintf("%032x.brp", 0), fmt.Sprintf("%032x.brp", 2), "notes.brp", fmt.Sprintf("%032x.txt", 9)} {
		if _, err := os.Stat(filepath.Join(dir, keep)); err != nil {
			t.Errorf("%s was removed", keep)
		}
	}
	if pruneReplays(dir, 3) != nil {
		t.Fatal("second prune removed more")
	}
}
