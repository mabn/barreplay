package insights

import (
	"regexp"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// A capture's unit defs carry no tech level and no build options, so what
// counts as "reaching T2" is named here, by def. The names are BAR's internal
// ones for Armada (arm), Cortex (cor) and Legion (leg); scavenger copies
// (suffix _scav) count as their originals.
var milestoneDefs = []struct {
	Key, Label string
	Names      []string
}{
	{"airlab", "First air lab", []string{"armap", "corap", "legap", "armplat", "corplat"}},
	{"t2lab", "First T2 lab", []string{
		"armalab", "coralab", "legalab",
		"armavp", "coravp", "legavp",
		"armaap", "coraap", "legaap",
		"armasy", "corasy", "legasy",
	}},
	{"fusion", "First fusion", []string{
		"armfus", "corfus", "legfus", "armckfus",
		"armuwfus", "coruwfus", "leguwfus",
		"armafus", "corafus", "legafus",
	}},
	{"antinuke", "First anti-nuke", []string{"armamd", "corfmd", "legabm"}},
	{"lrpc", "First long-range plasma cannon", []string{"armbrtha", "corint", "leglrpc", "armvulc", "corbuzz", "legstarfall"}},
	{"nuke", "First nuke silo", []string{"armsilo", "corsilo", "legsilo"}},
	{"t3lab", "First T3 gantry", []string{"armshltx", "corgant", "leggant", "armshltxuw", "corgantuw"}},
}

var milestoneByName = func() map[string]int {
	m := map[string]int{}
	for i, ms := range milestoneDefs {
		for _, n := range ms.Names {
			m[n] = i
		}
	}
	return m
}()

// milestoneOf returns the milestone a finished def reaches, or -1.
func milestoneOf(name string) int {
	name = strings.TrimSuffix(name, "_scav")
	if i, ok := milestoneByName[name]; ok {
		return i
	}
	return -1
}

// commanderRE is the viewer's definition of a player's commander (app.js
// COMMANDER_RE): every real commander, including its upgrade paths, and none
// of the decoys, effigies or scavenger bosses — bosses are excluded by name.
var commanderRE = regexp.MustCompile(`^(arm|cor|leg)com`)

func isCommander(name string) bool {
	return commanderRE.MatchString(name) && !strings.Contains(name, "boss")
}

// isArmy is the team statistics bar's army rule (viz wire.go ArmyCost plus
// app.js's commander exclusion): armed, mobile, has a price, not a commander.
func isArmy(d snapshot.UnitDef) bool {
	return d.WeaponCount > 0 && d.Speed > 0 && d.MetalCost > 0 && !isCommander(d.Name)
}

// isStructure matches the viewer's footprint rule: immobile or tagged a
// building (factories sometimes report CanMove).
func isStructure(d snapshot.UnitDef) bool {
	return !d.CanMove || d.IsBuilding
}

// Army categories. With no tech level in the defs, ground units are split by
// price, which tracks BAR's tiers closely enough to show a tech switch.
var armyCats = []string{"air", "light", "medium", "heavy", "experimental"}

func armyCat(d snapshot.UnitDef) int {
	switch {
	case d.CanFly:
		return 0
	case d.MetalCost < 250:
		return 1
	case d.MetalCost < 800:
		return 2
	case d.MetalCost < 3000:
		return 3
	default:
		return 4
	}
}
