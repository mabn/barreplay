package engine

import (
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakePRD writes a pr-downloader stand-in that prints script and exits with
// code: what the real one does when it cannot fetch anything.
func fakePRD(t *testing.T, script string, code int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell stand-in for pr-downloader")
	}
	p := filepath.Join(t.TempDir(), "pr-downloader")
	body := "#!/bin/sh\ncat <<'OUT'\n" + script + "\nOUT\nexit " + string(rune('0'+code)) + "\n"
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// seedVersions writes a cached rapid index naming one build, so EnsureContent
// resolves its md5 without the network.
func seedVersions(t *testing.T, data, line string) {
	t.Helper()
	dir := filepath.Join(data, "cache")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(dir, "versions.gz"))
	if err != nil {
		t.Fatal(err)
	}
	zw := gzip.NewWriter(f)
	zw.Write([]byte(line + "\n"))
	zw.Close()
	f.Close()
}

const testGame = "Beyond All Reason test-31720-0f97aa5"

// A game that is not installed and cannot be downloaded is the end of the run,
// with pr-downloader's own reason: the engine would otherwise start without it,
// load nothing, and the failure surfaced only as a missing widget output.
func TestEnsureContentFailsWhenGameMissing(t *testing.T) {
	data := t.TempDir()
	seedVersions(t, data, "byar:git:0f97aa5321c0e1cd458998fdbca277baadf054aa,f85d53404a2a0f16b33850b33466189e,,"+testGame)
	prd := fakePRD(t, `[Info] something
[Error] /build/src/tools/pr-downloader/src/pr-downloader.cpp:305:DownloadStart():Insufficient free disk space (736 MiB) on C:\data: 1024 MiB needed
[Error] /build/src/tools/pr-downloader/src/main.cpp:187:main():Error occurred while downloading: 5`, 5)
	e := &Engine{cfg: Config{DataDir: data}, prdPath: prd}
	err := e.EnsureContent(context.Background(), testGame, "")
	if err == nil {
		t.Fatal("EnsureContent succeeded with the game missing")
	}
	if !strings.Contains(err.Error(), "Insufficient free disk space (736 MiB) on C:\\data: 1024 MiB needed") {
		t.Errorf("error does not carry pr-downloader's reason: %v", err)
	}
	if strings.Contains(err.Error(), "/build/src") {
		t.Errorf("error carries the source path: %v", err)
	}
}

// A failed download of a game that IS installed stays a warning.
func TestEnsureContentToleratesFailureWhenInstalled(t *testing.T) {
	data := t.TempDir()
	seedVersions(t, data, "byar:git:0f97aa5321c0e1cd458998fdbca277baadf054aa,f85d53404a2a0f16b33850b33466189e,,"+testGame)
	if err := os.MkdirAll(filepath.Join(data, "packages"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(data, "packages", "f85d53404a2a0f16b33850b33466189e.sdp"), nil, 0o644)
	prd := fakePRD(t, "[Error] x.cpp:1:f():boom", 1)
	e := &Engine{cfg: Config{DataDir: data, ForceProvision: true}, prdPath: prd}
	if err := e.EnsureContent(context.Background(), testGame, ""); err != nil {
		t.Fatalf("EnsureContent: %v", err)
	}
}

func TestPRDReason(t *testing.T) {
	for in, want := range map[string]string{
		"[Error] /build/a/pr-downloader.cpp:305:DownloadStart():Insufficient free disk space": "Insufficient free disk space",
		"[Error] plain message": "plain message",
		"[Info] not an error":   "",
	} {
		if got := prdReason(in); got != want {
			t.Errorf("prdReason(%q) = %q, want %q", in, got, want)
		}
	}
}
