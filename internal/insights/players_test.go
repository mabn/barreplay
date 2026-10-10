package insights

import (
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

func playerOf(t *testing.T, ins *Insights, team int32) Player {
	t.Helper()
	for _, p := range ins.Players {
		if p.Team == team {
			return p
		}
	}
	t.Fatalf("no report for team %d", team)
	return Player{}
}

func TestPlayerReports(t *testing.T) {
	ins := computeFixture(t)
	if len(ins.Players) != 4 {
		t.Fatalf("players = %d, want 4 (Gaia has none)", len(ins.Players))
	}
	ann, bob, cid := playerOf(t, ins, 0), playerOf(t, ins, 1), playerOf(t, ins, 2)
	if ann.Player != "Ann" || ann.Side != 0 {
		t.Errorf("ann = %+v", ann)
	}
	// Strip: Ann's raiders die from 200 s, and she said "gl hf" at the start.
	lost := 0
	for _, n := range ann.Strip.LostN {
		lost += n
	}
	if lost != 7 && lost != 14 {
		t.Errorf("ann lost %d units", lost)
	}
	if ann.Strip.Chat[0] != 1 {
		t.Errorf("ann chat = %v", ann.Strip.Chat[:2])
	}
	// Bob's constructor never builds and never moves, nor does his commander.
	if nb := bob.Leaks.NotBuilding; nb == nil || *nb < 0.99 {
		t.Errorf("bob not building = %v, want ~1", nb)
	}
	// Team 0 alone sat on full storage; team 1 never did, so the side never
	// floated.
	if ann.Leaks.FloatSec != 0 {
		t.Errorf("ann floated %v s, want 0 (her ally had room)", ann.Leaks.FloatSec)
	}
	if ann.Style.T2 != 120*30 || cid.Style.T2 != 150*30 || bob.Style.T2 != -1 {
		t.Errorf("t2 = %d / %d / %d", ann.Style.T2, cid.Style.T2, bob.Style.T2)
	}
	// Each side holds its raiders short of the middle (3800 vs 4200).
	if f := ann.Style.ForwardShare; f == nil || *f > 0.5 {
		t.Errorf("ann forward share = %v, want under half", f)
	}
	if ann.Commander.Died != -1 || ann.Commander.Path[0] == nil {
		t.Errorf("ann commander = died %d, first point %v", ann.Commander.Died, ann.Commander.Path[0])
	}
	if ann.Commander.FirstContact < 0 || ann.Commander.FirstContact > 200*30 {
		t.Errorf("ann first contact at frame %d", ann.Commander.FirstContact)
	}
	share := ann.Style.IncomeShare + bob.Style.IncomeShare
	if share < 0.99 || share > 1.01 {
		t.Errorf("side 0 income shares sum to %v", share)
	}
}

// A side floats only when every team on it is full.
func TestFloatingNeedsTheWholeSide(t *testing.T) {
	in, err := FromBRP(parseFixture(t, writeFixture(t)))
	if err != nil {
		t.Fatal(err)
	}
	frames := in.Frames
	in.Frames = func(yield func(f snapshot.Frame) error) error {
		return frames(func(f snapshot.Frame) error {
			for i := range f.Resources {
				if f.Resources[i].Team <= 1 && f.Frame >= 100*30 && f.Frame < 160*30 {
					f.Resources[i].Metal = f.Resources[i].MetalStorage
				}
			}
			return yield(f)
		})
	}
	ins, err := Compute(in)
	if err != nil {
		t.Fatal(err)
	}
	ann := playerOf(t, ins, 0)
	if ann.Leaks.FloatSec != 60 || ann.Leaks.FloatMetal != 600 {
		t.Errorf("ann floated %v s / %v metal, want 60 s / 600", ann.Leaks.FloatSec, ann.Leaks.FloatMetal)
	}
}

// A team with two commanders (a teammate's, given when they left) keeps
// following the one its path is on, rather than whichever the frame lists
// first.
func TestCommanderPathFollowsOneCommander(t *testing.T) {
	in, err := FromBRP(parseFixture(t, writeFixture(t)))
	if err != nil {
		t.Fatal(err)
	}
	frames := in.Frames
	n := 0
	in.Frames = func(yield func(f snapshot.Frame) error) error {
		return frames(func(f snapshot.Frame) error {
			for _, u := range f.Units {
				if u.Team == 0 && u.DefID == defCom {
					far := u
					far.UnitID = 9999
					far.Pos.X += 3000
					// The second commander comes first in every other frame.
					if n++; n%2 == 0 {
						f.Units = append([]snapshot.UnitState{far}, f.Units...)
					} else {
						f.Units = append(f.Units, far)
					}
					break
				}
			}
			return yield(f)
		})
	}
	ins, err := Compute(in)
	if err != nil {
		t.Fatal(err)
	}
	var prev []int32
	for i, pt := range playerOf(t, ins, 0).Commander.Path {
		if pt == nil {
			continue
		}
		if prev != nil {
			if dx := pt[0] - prev[0]; dx > 1000 || dx < -1000 {
				t.Fatalf("step %d: path jumps from %v to %v", i, prev, pt)
			}
		}
		prev = pt
	}
	if prev == nil {
		t.Fatal("no commander path")
	}
}
