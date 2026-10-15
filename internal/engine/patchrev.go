package engine

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// patchSeries records every revision of each engine version's patch series
// (patches/engine-<version>/series and the patches it lists), oldest first:
// revision N is the Nth entry, its value the series' SeriesDigest. A build is
// versioned by the revision it was made from (PatchedVersion), so changing a
// patch without appending here would publish different code under an old
// version — TestPatchSeriesIsPinned fails until the new digest is added.
var patchSeries = map[string][]string{
	"2026.07.04": {
		"dc6c23e9b5915079323c8d3f51f8c430f8e20d928d1a59dd41f103fe3ccead9b",
	},
}

// PatchedVersion is the semver of a patched build: the engine's version with
// its leading zeros dropped (2026.07.04 is not valid semver), then the series
// revision as a pre-release, so revisions of one engine order numerically —
// "2026.7.4-barreplay.1" < "2026.7.4-barreplay.2". Not build metadata ("+barreplay.1"), which
// semver ignores when ordering.
func PatchedVersion(engineVersion string, rev int) string {
	parts := strings.Split(engineVersion, ".")
	for i, p := range parts {
		if n, err := strconv.Atoi(p); err == nil {
			parts[i] = strconv.Itoa(n)
		}
	}
	return strings.Join(parts, ".") + "-barreplay." + strconv.Itoa(rev)
}

// PatchedVersionTag is the git tag marking the barreplay commit whose
// patches/ a published build was made from. Not "v<semver>": the Go module
// proxy would read a root "v…" tag as a version of this module.
func PatchedVersionTag(engineVersion string, rev int) string {
	return "patched-engine/" + PatchedVersion(engineVersion, rev)
}

// SeriesRevision returns which revision of engineVersion's patch series is in
// patchesDir (the repo's patches/ directory), refusing a series that is not
// pinned in patchSeries.
func SeriesRevision(patchesDir, engineVersion string) (int, error) {
	digest, err := SeriesDigest(filepath.Join(patchesDir, "engine-"+engineVersion))
	if err != nil {
		return 0, err
	}
	for i, d := range patchSeries[engineVersion] {
		if d == digest {
			return i + 1, nil
		}
	}
	return 0, fmt.Errorf("engine: the %s patch series (digest %s) is not a pinned revision; "+
		"append that digest to patchSeries in internal/engine/patchrev.go", engineVersion, digest)
}

// SeriesDigest hashes a patch series: the order of the patches in dir/series
// and each patch's contents. Comment and blank lines in series are ignored,
// so editing the explanation at its top is not a new revision.
func SeriesDigest(dir string) (string, error) {
	series, err := os.ReadFile(filepath.Join(dir, "series"))
	if err != nil {
		return "", fmt.Errorf("engine: read patch series: %w", err)
	}
	var list bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(series))
	for sc.Scan() {
		name := strings.TrimSpace(sc.Text())
		if name == "" || strings.HasPrefix(name, "#") {
			continue
		}
		patch, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			return "", fmt.Errorf("engine: patch series: %w", err)
		}
		sum := sha256.Sum256(patch)
		fmt.Fprintf(&list, "%s %s\n", hex.EncodeToString(sum[:]), name)
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	if list.Len() == 0 {
		return "", fmt.Errorf("engine: %s lists no patches", filepath.Join(dir, "series"))
	}
	sum := sha256.Sum256(list.Bytes())
	return hex.EncodeToString(sum[:]), nil
}
