package demofile

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// TDFSection is a parsed node of a Spring startscript (TDF): a set of scalar
// key=value pairs plus nested named subsections. Names are lower-cased.
type TDFSection struct {
	Values      map[string]string
	Subsections map[string]*TDFSection
}

func newSection() *TDFSection {
	return &TDFSection{Values: map[string]string{}, Subsections: map[string]*TDFSection{}}
}

// Startscript is the interpreted top-level [game] section of a replay.
type Startscript struct {
	Root       *TDFSection // the [game] section
	MapName    string
	GameType   string // mod/game version, e.g. "Beyond All Reason test-30541-1efcf40"
	Players    []Player
	AllyTeams  []AllyTeam
	ModOptions map[string]string
}

// Player is one [player N] entry. Beyond the roster basics, BAR replays carry
// per-player metadata: country flag, ladder rank, OpenSkill rating ("OS") and
// its uncertainty, the BAR account id, and whether the player is a game boss.
type Player struct {
	Index            int
	Name             string
	Team             int
	Spectator        bool
	CountryCode      string  // ISO country code for the flag, e.g. "US"
	Rank             int     // ladder rank
	Skill            float64 // OpenSkill rating (the "OS" number)
	SkillUncertainty float64 // OpenSkill sigma
	AccountID        string  // BAR account id
	Boss             bool    // game boss (can pause/manage the game)
}

// AllyTeam is one [allyteam N] entry.
type AllyTeam struct {
	Index int
}

// ParseStartscript parses a TDF startscript document and extracts the fields the
// tool needs. The parser is intentionally small: TDF here is only nested
// [section]{ key=value; ... } with // and /* */ comments.
func ParseStartscript(s string) (*Startscript, error) {
	root, err := parseTDF(s)
	if err != nil {
		return nil, err
	}
	game := root.Subsections["game"]
	if game == nil {
		// Some tools omit the wrapping [game]; treat root as game.
		game = root
	}

	out := &Startscript{
		Root:       game,
		MapName:    game.Values["mapname"],
		GameType:   game.Values["gametype"],
		ModOptions: map[string]string{},
	}
	if mo := game.Subsections["modoptions"]; mo != nil {
		out.ModOptions = mo.Values
	}
	// Subsections is a map, so ranging it visits the player/allyteam sections in
	// a per-process RANDOM order — and that order reached the capture's player
	// roster verbatim, which made the .brp writer's "same capture -> byte-
	// identical file" guarantee false: two runs of ONE engine binary over ONE
	// demo produced .brp files differing in the meta record's player list. That
	// is invisible day to day (nothing reads the roster positionally) and fatal
	// to any byte-comparison of two captures, which is how engine changes are
	// verified to be output-safe. Collect, then sort by the index the section
	// name carries, which is the startscript's own order.
	for name, sub := range game.Subsections {
		switch {
		case strings.HasPrefix(name, "player"):
			idx, _ := strconv.Atoi(strings.TrimPrefix(name, "player"))
			team, _ := strconv.Atoi(sub.Values["team"])
			rank, _ := strconv.Atoi(sub.Values["rank"])
			unc, _ := strconv.ParseFloat(sub.Values["skilluncertainty"], 64)
			out.Players = append(out.Players, Player{
				Index:            idx,
				Name:             sub.Values["name"],
				Team:             team,
				Spectator:        sub.Values["spectator"] == "1",
				CountryCode:      sub.Values["countrycode"],
				Rank:             rank,
				Skill:            parseSkill(sub.Values["skill"]),
				SkillUncertainty: unc,
				AccountID:        sub.Values["accountid"],
				Boss:             sub.Values["boss"] == "1",
			})
		case strings.HasPrefix(name, "allyteam"):
			idx, _ := strconv.Atoi(strings.TrimPrefix(name, "allyteam"))
			out.AllyTeams = append(out.AllyTeams, AllyTeam{Index: idx})
		}
	}
	sort.Slice(out.Players, func(i, j int) bool { return out.Players[i].Index < out.Players[j].Index })
	sort.Slice(out.AllyTeams, func(i, j int) bool { return out.AllyTeams[i].Index < out.AllyTeams[j].Index })
	return out, nil
}

// parseTDF parses a TDF document into a synthetic root section whose subsections
// are the document's top-level [sections].
func parseTDF(s string) (*TDFSection, error) {
	s = stripComments(s)
	root := newSection()
	stack := []*TDFSection{root}
	i, n := 0, len(s)

	for i < n {
		c := s[i]
		switch {
		case c == '[':
			end := strings.IndexByte(s[i:], ']')
			if end < 0 {
				return nil, fmt.Errorf("unterminated section header at %d", i)
			}
			name := strings.ToLower(strings.TrimSpace(s[i+1 : i+end]))
			i += end + 1
			// Expect an opening brace next (possibly after whitespace).
			for i < n && isSpace(s[i]) {
				i++
			}
			if i >= n || s[i] != '{' {
				return nil, fmt.Errorf("section %q not followed by '{'", name)
			}
			i++ // consume '{'
			sec := newSection()
			stack[len(stack)-1].Subsections[name] = sec
			stack = append(stack, sec)
		case c == '}':
			if len(stack) <= 1 {
				return nil, fmt.Errorf("unbalanced '}' at %d", i)
			}
			stack = stack[:len(stack)-1]
			i++
		case isSpace(c):
			i++
		default:
			// key=value; pair. Read until ';' or newline or '}'.
			end := i
			for end < n && s[end] != ';' && s[end] != '\n' && s[end] != '}' {
				end++
			}
			pair := strings.TrimSpace(s[i:end])
			if pair != "" {
				if eq := strings.IndexByte(pair, '='); eq >= 0 {
					key := strings.ToLower(strings.TrimSpace(pair[:eq]))
					val := strings.TrimSpace(pair[eq+1:])
					stack[len(stack)-1].Values[key] = val
				}
			}
			// Advance past the terminator, but leave '}' for the next iteration.
			if end < n && s[end] != '}' {
				end++
			}
			i = end
		}
	}
	return root, nil
}

// stripComments removes // line and /* block */ comments, preserving byte
// positions is unnecessary here since we re-scan.
func stripComments(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	i, n := 0, len(s)
	for i < n {
		if i+1 < n && s[i] == '/' && s[i+1] == '/' {
			for i < n && s[i] != '\n' {
				i++
			}
			continue
		}
		if i+1 < n && s[i] == '/' && s[i+1] == '*' {
			i += 2
			for i+1 < n && !(s[i] == '*' && s[i+1] == '/') {
				i++
			}
			i += 2
			continue
		}
		if i < n {
			b.WriteByte(s[i])
			i++
		}
	}
	return b.String()
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\r' || c == '\n' }

// parseSkill parses BAR's OpenSkill value, which is written wrapped in brackets
// (e.g. "[31.24]"). Returns 0 for an empty or unparseable value.
func parseSkill(s string) float64 {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f
}
