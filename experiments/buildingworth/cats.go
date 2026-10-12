package main

import (
	"regexp"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// Unit categories, after Marcin's split: units that fight, buildings that
// fight, other buildings, and the economy buildings whose loss hurts most
// (power plants, metal converters, build turrets). Extractors, builders and
// commanders are kept apart so each can be weighed on its own.
const (
	catArmy = "army" // mobile and armed, not a commander
	catCon  = "con"  // mobile and unarmed (builders, scouts, transports)
	catCom  = "com"  // commanders
	catDef  = "def"  // structure with a weapon (not a factory)
	catEco  = "eco"  // power plant, metal converter, build turret
	catMex  = "mex"  // metal extractor
	catBld  = "bld"  // any other structure: factories, radar, storage, walls
)

var cats = []string{catArmy, catCon, catCom, catDef, catEco, catMex, catBld}

var (
	commanderRE = regexp.MustCompile(`^(arm|cor|leg)com`)
	powerRE     = regexp.MustCompile(`^((arm|cor|leg)[a-z0-9]*(win|sol|fus|geo|tide)|afuslegendary)`)
	converterRE = regexp.MustCompile(`^(arm|cor|leg)[a-z0-9]*(makr|mmkr|mmm|metalmaker)`)
	mexRE       = regexp.MustCompile(`^(arm|cor|leg)[a-z0-9]*(mex|moho)`)
)

func category(d snapshot.UnitDef) string {
	name := strings.TrimSuffix(d.Name, "_scav")
	structure := !d.CanMove || d.IsBuilding
	switch {
	case d.IsCommander || (commanderRE.MatchString(name) && !strings.Contains(name, "boss")):
		return catCom
	case !structure && d.WeaponCount > 0:
		return catArmy
	case !structure:
		return catCon
	case d.IsFactory:
		return catBld
	case mexRE.MatchString(name):
		return catMex
	case powerRE.MatchString(name) || converterRE.MatchString(name) || d.IsBuilder:
		return catEco
	case d.WeaponCount > 0:
		return catDef
	}
	return catBld
}
