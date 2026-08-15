package envfile

import (
	"os"
	"path/filepath"
	"testing"
)

// write puts content in a temp file and returns its path.
func write(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadSetsVariables(t *testing.T) {
	path := write(t, `
# a comment, and a blank line above
export R2_ACCESS_KEY_ID=abc123
R2_BUCKET="barreplay-replays"
R2_ENDPOINT='https://acct.r2.cloudflarestorage.com'
  export SPACED_KEY = spaced value
`)
	for _, k := range []string{"R2_ACCESS_KEY_ID", "R2_BUCKET", "R2_ENDPOINT", "SPACED_KEY"} {
		t.Setenv(k, "") // registers cleanup; unset below so Load sees them absent
		os.Unsetenv(k)
	}

	n, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if n != 4 {
		t.Errorf("set %d vars, want 4", n)
	}
	want := map[string]string{
		"R2_ACCESS_KEY_ID": "abc123",
		"R2_BUCKET":        "barreplay-replays",                     // quotes stripped
		"R2_ENDPOINT":      "https://acct.r2.cloudflarestorage.com", // single quotes too
		"SPACED_KEY":       "spaced value",                          // key/value trimmed
	}
	for k, v := range want {
		if got := os.Getenv(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
}

// The environment is authoritative: the file is a default, so an explicit
// `FOO=bar cmd` or an already-sourced shell must not be clobbered.
func TestLoadDoesNotOverrideExisting(t *testing.T) {
	path := write(t, "R2_BUCKET=from-file\nR2_ENDPOINT=from-file\n")
	t.Setenv("R2_BUCKET", "from-environment")
	os.Unsetenv("R2_ENDPOINT")
	t.Setenv("R2_ENDPOINT", "")
	os.Unsetenv("R2_ENDPOINT")

	n, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if n != 1 {
		t.Errorf("set %d vars, want 1 (only the unset one)", n)
	}
	if got := os.Getenv("R2_BUCKET"); got != "from-environment" {
		t.Errorf("R2_BUCKET = %q, want the pre-existing value to win", got)
	}
	if got := os.Getenv("R2_ENDPOINT"); got != "from-file" {
		t.Errorf("R2_ENDPOINT = %q, want the file value", got)
	}
}

// A secret may legitimately contain '#', so an unquoted value keeps it
// rather than being silently truncated into a wrong-but-plausible key.
func TestLoadKeepsHashInValue(t *testing.T) {
	path := write(t, "SECRET=abc#def\n")
	t.Setenv("SECRET", "")
	os.Unsetenv("SECRET")

	if _, err := Load(path); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := os.Getenv("SECRET"); got != "abc#def" {
		t.Errorf("SECRET = %q, want %q", got, "abc#def")
	}
}

// Shipping without a .env is the normal case for anyone who exports the
// variables by other means, so it must not be an error.
func TestLoadMissingFileIsNoOp(t *testing.T) {
	n, err := Load(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil {
		t.Fatalf("missing file should not error, got %v", err)
	}
	if n != 0 {
		t.Errorf("set %d vars, want 0", n)
	}
}

func TestLoadRejectsMalformedLine(t *testing.T) {
	path := write(t, "GOOD=1\nthis line has no equals sign\n")
	t.Setenv("GOOD", "")
	os.Unsetenv("GOOD")

	if _, err := Load(path); err == nil {
		t.Fatal("want an error naming the bad line, got nil")
	}
}
