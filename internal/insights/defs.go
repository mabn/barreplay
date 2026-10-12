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
// price, which tracks BAR's tiers closely enough to show a tech switch. Air
// is one band below the experimental price: a flying experimental (a
// Liche, a Dragon) is an experimental first.
var armyCats = []string{"air", "light", "medium", "heavy", "experimental"}

const experimentalCost = 3000

func armyCat(d snapshot.UnitDef) int {
	switch {
	case d.MetalCost >= experimentalCost:
		return 4
	case d.CanFly:
		return 0
	case d.MetalCost < 250:
		return 1
	case d.MetalCost < 800:
		return 2
	default:
		return 3
	}
}

// ecoNameRE matches BAR's economy buildings by name, for captures whose defs
// carry no UnitGroup (before stream protocol 4): extractors, wind and tidal
// generators, solars, fusions, geothermals and metal makers.
var ecoNameRE = regexp.MustCompile(`^(arm|cor|leg)[a-z]*(mex|moho|win|sol|fus|geo|tide|makr|mmkr|mmm)`)

// powerNameRE matches BAR's power plants: wind and tidal generators,
// solars, fusions (the legendary one has no faction prefix) and geothermals.
// Energy storage shares their UnitGroup, which is why the name decides.
var powerNameRE = regexp.MustCompile(`^((arm|cor|leg)[a-z0-9]*(win|sol|fus|geo|tide)|afuslegendary)`)

// powerWorth is what a lost power plant counts for per metal of its cost when
// a battle's winner is decided (Marcin's rule): a fusion's loss is its metal
// AND the energy it would have made, which has a metal equivalent.
const powerWorth = 2.5

// buildingWorth is what any other lost building counts for per metal when a
// battle's winner is decided (Version 10): a building has to be rebuilt just
// to stand where its side stood, where a unit lost has already done its job.
// Measured on 2,271 battles of 164 re-simulated games, 2x moved 6% of the
// verdicts and 68% of the moved ones named the side that went on to win the
// game; 3x moved more, but those extra ones were close to a coin toss.
// Only in a capture that names killers: without them a reclaimed wind farm or
// an upgraded extractor reads as a loss, and doubling it doubles the noise.
const buildingWorth = 2.0

func isPowerPlant(d snapshot.UnitDef) bool {
	return isStructure(d) && (d.UnitGroup == "energy" || d.UnitGroup == "") && powerNameRE.MatchString(d.Name)
}

// worthPerMetal is what a lost unit of def d counts for per metal of its
// cost when a battle's winner is decided; causes is whether the capture
// names killers.
func worthPerMetal(d snapshot.UnitDef, causes bool) float64 {
	switch {
	case isPowerPlant(d):
		return powerWorth
	case causes && isStructure(d):
		return buildingWorth
	}
	return 1
}

// isEcoBuilding is whether a def is a structure that makes metal or energy.
func isEcoBuilding(d snapshot.UnitDef) bool {
	if !isStructure(d) {
		return false
	}
	switch d.UnitGroup {
	case "metal", "energy":
		return true
	case "":
		return ecoNameRE.MatchString(d.Name)
	}
	return false
}
