package engine

import (
	"bufio"
	"compress/gzip"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// gameWidgetNames lists the GetInfo names of the widgets a rapid game package
// ships (luaui/widgets/*.lua), read straight from the package index
// <data>/packages/<md5>.sdp and its pool files. A rapid .sdp is a gzipped list
// of entries: <u8 name length><name><16-byte md5><u32 crc32><u32 size>; the
// file itself is <data>/pool/<md5[0:2]>/<md5[2:]>.gz. A widget whose name is
// not a plain string literal in GetInfo is skipped (it then loads as before).
func gameWidgetNames(dataDir, pkgMD5 string) ([]string, error) {
	f, err := os.Open(filepath.Join(dataDir, "packages", pkgMD5+".sdp"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	r := bufio.NewReader(zr)
	seen := map[string]bool{}
	var names []string
	for {
		n, err := r.ReadByte()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		rec := make([]byte, int(n)+24)
		if _, err := io.ReadFull(r, rec); err != nil {
			return nil, fmt.Errorf("truncated package index: %w", err)
		}
		path := strings.ToLower(string(rec[:n]))
		if !strings.HasPrefix(path, "luaui/widgets/") || !strings.HasSuffix(path, ".lua") || strings.Count(path, "/") != 2 {
			continue
		}
		sum := hex.EncodeToString(rec[n : n+16])
		name, ok := poolWidgetName(filepath.Join(dataDir, "pool", sum[:2], sum[2:]+".gz"))
		if ok && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

var getInfoNameRE = regexp.MustCompile(`(?s)GetInfo\s*\(\s*\)[^}]*?\bname\s*=\s*"((?:[^"\\]|\\.)*)"`)

func poolWidgetName(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return "", false
	}
	b, err := io.ReadAll(io.LimitReader(zr, 4<<20))
	if err != nil {
		return "", false
	}
	m := getInfoNameRE.FindSubmatch(b)
	if m == nil || strings.Contains(string(m[1]), `\`) {
		return "", false
	}
	return string(m[1]), true
}
