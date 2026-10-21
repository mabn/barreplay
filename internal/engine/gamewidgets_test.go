package engine

import (
	"bytes"
	"compress/gzip"
	"crypto/md5"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// writeRapid builds a rapid package <data>/packages/<pkg>.sdp + pool files.
func writeRapid(t *testing.T, data, pkg string, files map[string]string) {
	t.Helper()
	var idx bytes.Buffer
	for name, body := range files {
		sum := md5.Sum([]byte(body))
		hexsum := hex.EncodeToString(sum[:])
		dir := filepath.Join(data, "pool", hexsum[:2])
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		var gz bytes.Buffer
		w := gzip.NewWriter(&gz)
		w.Write([]byte(body))
		w.Close()
		if err := os.WriteFile(filepath.Join(dir, hexsum[2:]+".gz"), gz.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		idx.WriteByte(byte(len(name)))
		idx.WriteString(name)
		idx.Write(sum[:])
		idx.Write(make([]byte, 8)) // crc32 + size, unread
	}
	if err := os.MkdirAll(filepath.Join(data, "packages"), 0o755); err != nil {
		t.Fatal(err)
	}
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	w.Write(idx.Bytes())
	w.Close()
	if err := os.WriteFile(filepath.Join(data, "packages", pkg+".sdp"), gz.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGameWidgetNamesReadsThePackage(t *testing.T) {
	data := t.TempDir()
	writeRapid(t, data, "abc", map[string]string{
		"luaui/widgets/gui_a.lua":     "function widget:GetInfo()\n\treturn {\n\t\tname = \"Alpha\",\n\t\tenabled = true,\n\t}\nend",
		"LuaUI/Widgets/gui_b.lua":     "function widget:GetInfo() return { desc = \"x\", name = \"Beta Widget\" } end",
		"luaui/widgets/gui_c.lua":     "local n = 'C'\nfunction widget:GetInfo() return { name = n } end", // not a literal: skipped
		"luaui/widgets/sub/inner.lua": "function widget:GetInfo() return { name = \"Nested\" } end",       // not a top-level widget
		"luarules/gadgets/g.lua":      "function gadget:GetInfo() return { name = \"Gadget\" } end",
		"luaui/widgets/gui_a_dup.lua": "function widget:GetInfo() return { name = \"Alpha\" } end",
	})
	got, err := gameWidgetNames(data, "abc")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"Alpha", "Beta Widget"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestWidgetConfigListsGameWidgetsOff(t *testing.T) {
	lua := widgetConfigLua("BAR Replay Snapshotter", "Alpha", "BAR Replay Snapshotter", "Beta")
	if !strings.Contains(lua, `order = { ["BAR Replay Snapshotter"] = 1, ["Alpha"] = 0, ["Beta"] = 0 }`) {
		t.Fatalf("unexpected order list:\n%s", lua)
	}
}
