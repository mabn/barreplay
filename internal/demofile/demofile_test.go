package demofile

import (
	"os"
	"testing"
)

func TestParseRealSample(t *testing.T) {
	f, err := os.Open("testdata/sample_header.sdfz")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()

	d, err := Parse(f)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	h := d.Header
	if h.Magic != "spring demofile" {
		t.Errorf("Magic = %q", h.Magic)
	}
	if h.Version != 5 {
		t.Errorf("Version = %d, want 5", h.Version)
	}
	if h.HeaderSize != 352 {
		t.Errorf("HeaderSize = %d, want 352", h.HeaderSize)
	}
	if h.EngineVersion != "2025.06.24" {
		t.Errorf("EngineVersion = %q, want 2025.06.24", h.EngineVersion)
	}
	if h.GameID != "836d486a5480a9e830be54db7d2c7be9" {
		t.Errorf("GameID = %q", h.GameID)
	}
	if h.ScriptSize != 7258 {
		t.Errorf("ScriptSize = %d, want 7258", h.ScriptSize)
	}

	ss := d.Startscript
	if ss.MapName != "Isidis crack 1.1" {
		t.Errorf("MapName = %q, want %q", ss.MapName, "Isidis crack 1.1")
	}
	if ss.GameType == "" {
		t.Error("GameType empty")
	}
	if len(ss.Players) == 0 {
		t.Error("no players parsed")
	}
	// Per-player metadata (flag/rank/OpenSkill/account) comes off the startscript.
	// Subsection order isn't stable, so look player0 up by index.
	var p0 *Player
	for i := range ss.Players {
		if ss.Players[i].Index == 0 {
			p0 = &ss.Players[i]
		}
	}
	if p0 == nil {
		t.Fatal("player0 not found")
	}
	if p0.Name != "[Crd]Stylyn" || p0.CountryCode != "CA" || p0.Rank != 4 {
		t.Errorf("player0 basics = %+v", *p0)
	}
	if p0.Skill != 31.24 || p0.AccountID != "202413" {
		t.Errorf("player0 skill/account = %+v", *p0)
	}
	// The sample has modoptions we can spot-check.
	if ss.ModOptions["zombies"] != "disabled" {
		t.Errorf("modoption zombies = %q, want disabled", ss.ModOptions["zombies"])
	}
	t.Logf("gameType=%q players=%d allyteams=%d modoptions=%d",
		ss.GameType, len(ss.Players), len(ss.AllyTeams), len(ss.ModOptions))
}

func TestParseStartscriptNested(t *testing.T) {
	const doc = `[game]
{
	mapname=Test Map;
	gametype=Some Mod 1.0;
	[player0]
	{
		name=Alice;
		team=0;
		spectator=0;
	}
	[player1]
	{
		name=Bob;
		spectator=1;
	}
	[allyteam0]
	{
		numallies=0;
	}
	[modoptions]
	{
		maxspeed=10; // inline comment
	}
}`
	ss, err := ParseStartscript(doc)
	if err != nil {
		t.Fatalf("ParseStartscript: %v", err)
	}
	if ss.MapName != "Test Map" {
		t.Errorf("MapName = %q", ss.MapName)
	}
	if ss.GameType != "Some Mod 1.0" {
		t.Errorf("GameType = %q", ss.GameType)
	}
	if len(ss.Players) != 2 {
		t.Fatalf("players = %d, want 2", len(ss.Players))
	}
	if ss.ModOptions["maxspeed"] != "10" {
		t.Errorf("modoption maxspeed = %q", ss.ModOptions["maxspeed"])
	}
	if len(ss.AllyTeams) != 1 {
		t.Errorf("allyteams = %d, want 1", len(ss.AllyTeams))
	}
}

// A modoption value may contain braces — BAR's lava tweak is
// `map_tweaklava={10,5,400},{80,1,130},...;` — and the value runs to its ';'
// terminator, so those braces must not close the section. A real Silveridge
// demo failed with "unbalanced '}'" at exactly that option before this held.
func TestParseStartscriptBracesInValue(t *testing.T) {
	const doc = `[game]
{
	mapname=Silveridge v1.0.1;
	[modoptions]
	{
		map_tweaklava={10,5,400},{80,1,130},{150,1,60};
		map_waterislava=1;
		tweakunits1=;
	}
	[player0]
	{
		name=Alice;
		team=0;
	}
}`
	ss, err := ParseStartscript(doc)
	if err != nil {
		t.Fatalf("ParseStartscript: %v", err)
	}
	if got := ss.ModOptions["map_tweaklava"]; got != "{10,5,400},{80,1,130},{150,1,60}" {
		t.Errorf("map_tweaklava = %q", got)
	}
	if ss.ModOptions["map_waterislava"] != "1" {
		t.Errorf("map_waterislava = %q (the option after the braces was lost)", ss.ModOptions["map_waterislava"])
	}
	if len(ss.Players) != 1 || ss.Players[0].Name != "Alice" {
		t.Errorf("players = %+v", ss.Players)
	}
}

// A pair with no ';' still ends at the closing brace, so a hand-written
// `key=v}` closes its section instead of swallowing the rest of the document.
func TestParseStartscriptUnterminatedPair(t *testing.T) {
	ss, err := ParseStartscript("[game]\n{\n\tmapname=Foo}\n[extra]\n{\n\tx=1;\n}")
	if err != nil {
		t.Fatalf("ParseStartscript: %v", err)
	}
	if ss.MapName != "Foo" {
		t.Errorf("MapName = %q", ss.MapName)
	}
}
