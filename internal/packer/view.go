package packer

// Whose point of view an UPLOADED capture is, read off its frames rather than
// taken from what the capture says about itself. A .brp's meta and a stream's
// recorder record are both written by the uploader, so either can claim a
// full view it never had — and a full view takes the game's main name and
// retires the game's re-simulation. The frames are harder to fake: in the
// first seconds of a game every side's units stand at its own start position,
// out of every other side's sight, so a capture made from inside one side
// cannot hold an identified unit of another yet.

import (
	"fmt"
	"slices"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// viewCheckFrame is the last sim frame the check reads: 10 game-seconds.
// Commanders are on the map from the first frames, and no side has scouted
// another by then.
const viewCheckFrame = 300

// ViewCheck is what ViewFromFrames saw.
type ViewCheck struct {
	// View is "full" (units of two or more sides), "ally" (one side, Ally),
	// or "" when the opening frames are not in the capture or hold no units —
	// a capture that started late says nothing either way.
	View string
	Ally int32
	// Sides are the ally teams seen, ascending.
	Sides []int32
}

// String is the one line the job record carries.
func (v ViewCheck) String() string {
	switch v.View {
	case "full":
		return fmt.Sprintf("full view: saw %d sides in the first 10 s", len(v.Sides))
	case "ally":
		return fmt.Sprintf("one side: saw only ally team %d in the first 10 s", v.Ally)
	}
	return "inconclusive: no units in the first 10 s"
}

// ViewFromFrames reads the capture's opening frames (the first chunk, up to
// viewCheckFrame) and counts the sides owning an IDENTIFIED unit there. Radar
// contacts carry def 0, and are left out: a radar blip of a unit the recorder
// cannot see is exactly what a one-sided capture may hold. So are teams with
// no faction (Gaia) and scavenger/raptor units, which belong to no side.
func ViewFromFrames(bf *snapshot.BRPFile) (ViewCheck, error) {
	var vc ViewCheck
	if len(bf.Chunks) == 0 {
		return vc, nil
	}
	frames, err := bf.DecodeChunk(0)
	if err != nil {
		return vc, err
	}
	teamAlly := map[int32]int32{}
	for _, t := range bf.Meta.Teams {
		if t.Side != "" {
			teamAlly[t.TeamID] = t.AllyTeam
		}
	}
	seen := map[int32]bool{}
	for _, fr := range frames {
		if fr.Frame > viewCheckFrame {
			break
		}
		for _, u := range fr.Units {
			ally, ok := teamAlly[u.Team]
			if !ok || u.DefID == 0 || pveDef(bf.Meta.UnitDefs[u.DefID].Name) {
				continue
			}
			if !seen[ally] {
				seen[ally] = true
				vc.Sides = append(vc.Sides, ally)
			}
		}
	}
	slices.Sort(vc.Sides)
	switch len(vc.Sides) {
	case 0:
	case 1:
		vc.View, vc.Ally = "ally", vc.Sides[0]
	default:
		vc.View = "full"
	}
	return vc, nil
}

// UploadView is the point of view to publish an uploaded capture under, given
// what its frames show: the frames win whenever they say something. When they
// say nothing, a claim of one side stands (it costs nobody anything: the game
// still wants its full view), but a claim of a full view is not believed
// without them and publishes as "unknown". The returned ally is set only for
// "ally".
func UploadView(m snapshot.Meta, vc ViewCheck) (view string, ally *int32) {
	switch vc.View {
	case "full":
		return "full", nil
	case "ally":
		a := vc.Ally
		return "ally", &a
	}
	if CapturesAllTeams(m, "") {
		return "unknown", nil
	}
	return "", nil
}

// pveDef reports a scavenger or raptor unit def (the same name rule the game
// summary uses for its PvE teams).
func pveDef(name string) bool {
	return strings.HasSuffix(name, "_scav") || strings.HasPrefix(name, "raptor") || strings.HasPrefix(name, "scav")
}
