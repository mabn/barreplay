// Package envfile loads a shell-style KEY=VALUE file into the process
// environment, so the CLIs pick up local secrets (R2 keys, catalog tokens)
// without the caller having to remember `source .env` in the right shell.
//
// The format is the subset that is also valid to `source` from bash, so ONE
// file serves both uses:
//
//	# comment
//	export R2_ACCESS_KEY_ID=abc123
//	R2_BUCKET="barreplay-replays"
//
// Deliberately minimal (stdlib only, matching the repo's no-dependency rule):
// no interpolation, no multi-line values, and no inline-comment stripping —
// a `#` inside an unquoted value is part of the value, because secrets
// legitimately contain one and silently truncating a key is far worse than
// requiring quotes around a trailing comment.
package envfile

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
)

// Load reads path and sets every variable it declares that is NOT already
// present in the environment, returning how many it set.
//
// Already-set variables win, so an explicit `FOO=bar cmd` or a previously
// sourced shell still overrides the file — the file is a default, never an
// override. A missing file is not an error: it reports (0, nil), so shipping
// without a .env just means "no local secrets".
func Load(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	defer f.Close()

	n := 0
	sc := bufio.NewScanner(f)
	for line := 1; sc.Scan(); line++ {
		key, val, ok, err := parseLine(sc.Text())
		if err != nil {
			return n, fmt.Errorf("%s:%d: %w", path, line, err)
		}
		if !ok {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		if err := os.Setenv(key, val); err != nil {
			return n, fmt.Errorf("%s:%d: %w", path, line, err)
		}
		n++
	}
	if err := sc.Err(); err != nil {
		return n, err
	}
	return n, nil
}

// parseLine splits one line into a key/value pair. ok is false for blank
// lines and comments, which are skipped rather than rejected.
func parseLine(raw string) (key, val string, ok bool, err error) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.HasPrefix(s, "#") {
		return "", "", false, nil
	}
	// `export FOO=bar` is the form that also works when the file is sourced.
	if rest, found := strings.CutPrefix(s, "export "); found {
		s = strings.TrimSpace(rest)
	}
	name, value, found := strings.Cut(s, "=")
	if !found {
		return "", "", false, errors.New("not a KEY=VALUE line (missing '=')")
	}
	key = strings.TrimSpace(name)
	if key == "" {
		return "", "", false, errors.New("empty variable name")
	}
	if strings.ContainsAny(key, " \t") {
		return "", "", false, fmt.Errorf("invalid variable name %q", key)
	}
	return key, unquote(strings.TrimSpace(value)), true, nil
}

// unquote strips one layer of matching surrounding quotes. Quoting exists so
// a value can carry leading/trailing spaces or a trailing `#`; no escape
// sequences are interpreted, keeping the file's meaning identical whether it
// is parsed here or sourced by bash.
func unquote(v string) string {
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			return v[1 : len(v)-1]
		}
	}
	return v
}
