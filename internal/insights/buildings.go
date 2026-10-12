package insights

import (
	_ "embed"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// STANDING BUILDINGS (Version 10). Each side's buildings are measured per
// step like its army — metal cost weighted by build progress, at the step's
// last sample — split into the categories of the study that put them into
// the win line (experiments/buildingworth, 2026-10-12): defences, the
// economy (power plants, metal converters and the builder structures), metal
// extractors, and everything else (factories, radar, storage, walls).
//
// Why they are in the line at all: the line used to read only the army and
// the economy's OUTPUT, so a side holding twice the base the other does read
// as even until the income caught up. Standing defences count with the army
// (on ranked maps the study found a defence's metal worth about an army
// unit's), the rest as a fifth input of its own.

// The building categories, as Series.BuildingCats names them.
var buildingCats = []string{"defence", "eco", "mex", "other"}

const (
	bcDefence = iota
	bcEco
	bcMex
	bcOther
)

var (
	converterNameRE = regexp.MustCompile(`^(arm|cor|leg)[a-z0-9]*(makr|mmkr|mmm|metalmaker|fmkr|conv|gmm)`)
	mexNameRE       = regexp.MustCompile(`^((arm|cor|leg)[a-z0-9]*(mex|moho|uwmme)|t3mmex)`)
)

// buildingCat is a def's building category, -1 for anything that is not a
// building (and for a commander, whatever its flags say). It is the study's
// rule (experiments/buildingworth cats.go), which the coefficients were
// fitted on: change it and the line needs a refit.
func buildingCat(d snapshot.UnitDef) int {
	name := strings.TrimSuffix(d.Name, "_scav")
	switch {
	case d.IsCommander || isCommander(name) || !isStructure(d):
		return -1
	case d.IsFactory:
		return bcOther
	case mexNameRE.MatchString(name):
		return bcMex
	case powerNameRE.MatchString(name) || converterNameRE.MatchString(name) || d.IsBuilder:
		return bcEco
	case d.WeaponCount > 0:
		return bcDefence
	}
	return bcOther
}

// legacyBuildings is every building's category and metal cost by def name,
// from the def tables of the 166 games the study read whole (Oct 2026
// builds; experiments/buildingworth -table). A replay rebuilt from its
// published pieces carries a cost only for its armed mobile units and no
// facts to sort a building by, so its buildings are read through this — as
// the study read the same replays when it fitted the line. A def it does not
// know (a renamed or a newer unit) counts for nothing, as it did there.
//
//go:embed legacybuildings.json
var legacyBuildingsJSON []byte

var legacyBuildings = func() map[string]struct {
	cat  int
	cost float64
} {
	var raw map[string][2]any
	if err := json.Unmarshal(legacyBuildingsJSON, &raw); err != nil {
		panic("insights: legacybuildings.json: " + err.Error())
	}
	idx := map[string]int{}
	for i, c := range buildingCats {
		idx[c] = i
	}
	out := make(map[string]struct {
		cat  int
		cost float64
	}, len(raw))
	for name, v := range raw {
		c, _ := v[0].(string)
		cost, _ := v[1].(float64)
		i, ok := idx[c]
		if !ok || cost <= 0 {
			panic("insights: legacybuildings.json: bad entry " + name)
		}
		out[name] = struct {
			cat  int
			cost float64
		}{i, cost}
	}
	return out
}()

// buildingOf is a def's building category (-1 for none) and the metal it is
// counted at standing. legacy is an input rebuilt from published pieces,
// whose defs are read by name through legacyBuildings.
func buildingOf(d snapshot.UnitDef, legacy bool) (int, float64) {
	if legacy {
		if b, ok := legacyBuildings[d.Name]; ok {
			return refineCat(d.Name, b.cat), b.cost
		}
		return -1, 0
	}
	c := buildingCat(d)
	if c < 0 || d.MetalCost <= 0 {
		return -1, 0
	}
	return refineCat(d.Name, c), float64(d.MetalCost)
}

// refineCat sorts a building the study filed under "other" by its name when
// that says it is an extractor or a converter (Legion's converters, the
// naval and the epic extractors, a mine that is also a factory). Display
// only: the line reads every building but the defences as one input, so
// moving one between eco, mex and other changes no number in it. A
// defence stays a defence.
func refineCat(name string, c int) int {
	name = strings.TrimSuffix(name, "_scav")
	switch {
	case c == bcDefence:
		return c
	case mexNameRE.MatchString(name):
		return bcMex
	case powerNameRE.MatchString(name) || converterNameRE.MatchString(name):
		return bcEco
	}
	return c
}
