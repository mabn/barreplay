package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"

	"github.com/mabn/barreplay/snapshot"
)

// The gate's comparison. Byte-identical captures pass, as always. One
// difference is also accepted, because no build can avoid it: on a SANDBOXED
// BAR build (2026.10.13 on, every game the 2026.09.03 engine runs) a user
// widget gets a proxy handler, so on the stock engine its hits name no
// attacker and its blasts are only inferred from unit deaths, while the
// patched engine's event log (patch 0004) hands the same widget the real
// ones. The two captures then differ in H, W and the meta that sizes them,
// and in nothing else. sandboxEquivalent accepts exactly that, and only when
// the stock capture shows it is the case:
//
//   - every section other than M, H and W is byte-identical;
//   - the decoded meta is equal once the section layout and the blast count
//     are left out;
//   - the two have the same hits in the same order, every field equal except
//     the attacker and weapon fields, and the stock capture names no attacker
//     or weapon on any hit (were the real handler there, the bytes would match);
//   - every stock blast is one of the patched capture's.
//
// The simulation itself (frames, events, unit ends, visibility, facts) is
// still compared byte for byte. What the log ADDS (attackers, the real
// explosions) has no stock counterpart to compare with; the widget harness's
// enginelog mode pins it against the callins (TestEngineLogMatchesResim).

// gateCompare reports whether the patched capture passes against the stock
// one, and how ("identical" or the sandbox note).
func gateCompare(stockPath, patchedPath string) (ok bool, how string, err error) {
	same, sa, _, err := sameFile(stockPath, patchedPath)
	if err != nil {
		return false, "", err
	}
	if same {
		return true, "identical (sha256 " + sa + ")", nil
	}
	why, err := sandboxEquivalent(stockPath, patchedPath)
	if err != nil {
		return false, "", err
	}
	if why != "" {
		return false, why, nil
	}
	return true, "equivalent: the sandboxed widget's hits gained their attackers and its blasts the real explosions from the engine event log; everything else byte-identical", nil
}

// sandboxEquivalent returns "" when the two captures differ only as above,
// else what differs.
func sandboxEquivalent(stockPath, patchedPath string) (string, error) {
	secA, err := readSections(stockPath)
	if err != nil {
		return "", err
	}
	secB, err := readSections(patchedPath)
	if err != nil {
		return "", err
	}
	if len(secA) != len(secB) {
		return fmt.Sprintf("%d sections against %d", len(secA), len(secB)), nil
	}
	for i := range secA {
		a, b := secA[i], secB[i]
		if a.Tag != b.Tag {
			return fmt.Sprintf("section %d is %c against %c", i, a.Tag, b.Tag), nil
		}
		switch a.Tag {
		case 'H', 'W':
			continue // decoded below
		case 'M':
			if why, err := sameMeta(a.Payload, b.Payload); err != nil || why != "" {
				return why, err
			}
		default:
			if !bytes.Equal(a.Payload, b.Payload) {
				return fmt.Sprintf("section %c differs", a.Tag), nil
			}
		}
	}

	fa, err := parseBRP(stockPath)
	if err != nil {
		return "", err
	}
	fb, err := parseBRP(patchedPath)
	if err != nil {
		return "", err
	}
	ha, err := fa.Hits()
	if err != nil {
		return "", err
	}
	hb, err := fb.Hits()
	if err != nil {
		return "", err
	}
	if len(ha) != len(hb) {
		return fmt.Sprintf("%d hits against %d", len(ha), len(hb)), nil
	}
	for i := range ha {
		if ha[i].Attacker != -1 || ha[i].WeaponDef != -1 {
			return fmt.Sprintf("hit %d differs, and the stock capture names its attacker (not a sandboxed widget)", i), nil
		}
		x, y := withoutAttacker(ha[i]), withoutAttacker(hb[i])
		if x != y {
			return fmt.Sprintf("hit %d differs beyond its attacker: %+v against %+v", i, ha[i], hb[i]), nil
		}
	}
	ba, err := fa.Blasts()
	if err != nil {
		return "", err
	}
	bb, err := fb.Blasts()
	if err != nil {
		return "", err
	}
	have := make(map[snapshot.Blast]bool, len(bb))
	for _, b := range bb {
		have[b] = true
	}
	for _, b := range ba {
		if !have[b] {
			return fmt.Sprintf("the stock blast %+v is not in the patched capture", b), nil
		}
	}
	return "", nil
}

func withoutAttacker(h snapshot.Hit) snapshot.Hit {
	h.Attacker, h.AttackerDef, h.AttackerTeam, h.WeaponDef = 0, 0, 0, 0
	h.Projectile, h.ProjOwner, h.ProjTeam = false, 0, 0
	return h
}

// sameMeta compares the gzipped meta records with the fields that only size
// the H and W sections left out.
func sameMeta(a, b []byte) (string, error) {
	ma, err := metaMap(a)
	if err != nil {
		return "", err
	}
	mb, err := metaMap(b)
	if err != nil {
		return "", err
	}
	for _, m := range []map[string]any{ma, mb} {
		delete(m, "blasts")
		secs, _ := m["sections"].([]any)
		for _, s := range secs {
			if s, ok := s.(map[string]any); ok && (s["tag"] == "H" || s["tag"] == "W") {
				delete(s, "len")
			}
		}
	}
	if !reflect.DeepEqual(ma, mb) {
		return "the meta differs beyond the H and W section sizes", nil
	}
	return "", nil
}

func metaMap(payload []byte) (map[string]any, error) {
	zr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("meta: %w", err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return nil, fmt.Errorf("meta: %w", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("meta: %w", err)
	}
	return m, nil
}

func readSections(path string) ([]snapshot.Section, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	_, secs, err := snapshot.ReadContainer(f, "BRP1")
	return secs, err
}

func parseBRP(path string) (*snapshot.BRPFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return snapshot.ParseBRP(f)
}
