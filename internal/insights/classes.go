package insights

import (
	"regexp"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// A unit's CLASS is what the page's battle phrases are built on: "Blue
// bombers level the base", "Red defences hold". The defs carry no role, so
// the air roles and the long-range guns are curated tables, read off BAR's
// own icon assignments (icontypes.lua: air_bomber*, air_t2_bomber*,
// air_hover*, ...) — the one place BAR states what a unit is for. Everything
// else comes from facts every def carries. A def the tables do not know (a
// mod's own unit) falls through to the generic classes, never to a wrong
// specific one, so a phrase that needs a role simply does not fire for it.
// Version 8.

// The classes, as written to Def.Class.
const (
	classCommander    = "commander"
	classNuke         = "nuke"
	classLRGun        = "lrgun"
	classBomber       = "bomber"
	classFighter      = "fighter"
	classGunship      = "gunship"
	classAir          = "air"
	classShip         = "ship"
	classExperimental = "experimental"
	classFactory      = "factory"
	classEco          = "eco"
	classDefence      = "defence"
	classBuilding     = "building"
	classArmy         = "army"
	classUnit         = "unit"
)

var (
	// Bombers: BAR's air_bomber*, air_t2_bomber*, air_liche and torpedo
	// bomber icons.
	bomberRE = regexp.MustCompile(`^(armthund|corshad|legcib|legmineb|armsb|corsb|legspbomber|armpnix|corhurc|legnap|armliche|armlichet4|armlance|cortitan|legatorpbomber)$`)
	// Fighters: the air and air_t2 icons (and the seaplane fighters).
	fighterRE = regexp.MustCompile(`^(armfig|corveng|legfig|armhawk|corvamp|legafigdef|legionnaire|legvenator|armsfig|armsfig2|corsfig|corsfig2|legspfighter)$`)
	// Gunships: the air_hover*, air_bladew, air_krow and torpedo gunship
	// icons. Drones are left out: a carrier's drones are its weapon.
	gunshipRE = regexp.MustCompile(`^(armkam|armbrawl|armblade|corape|corbw|armsaber|corcut|legmos|legmost3|corcrw|corcrwh|armseap|corseap|legsptorpgunship|legspsurfacegunship)$`)
	// Long-range guns: the milestone's plasma cannons and rapid-fire
	// cannons, and their smaller copies.
	lrGunRE = regexp.MustCompile(`^(armbrtha|corint|leglrpc|armvulc|corbuzz|legstarfall|armminivulc|corminibuzz|legministarfall)$`)
	// Ships and submarines: every ship_*, sub_* and battlesub_* icon.
	shipRE = regexp.MustCompile(`^(armaas|armacsub|armantiship|armbats|armcarry|armcrus|armcs|armdecade|armdecadet3|armdronecarry|armepoch|armexcalibur|armhaca|armlship|armmls|armmship|armpship|armpshipt3|armpt|armptt2|armrecl|armroy|armseadragon|armserp|armserpt3|armsjam|armsub|armsubk|armtorps|armtrident|coracsub|corantiship|corarch|corbats|corblackhy|corcarry|corcrus|corcs|cordesolator|cordronecarry|coresupp|coresuppt3|corfship|corhacs|cormls|cormship|coronager|corprince|corpship|corpt|correcl|corroy|corsentinel|corshark|corsjam|corslrpc|corssub|corsub|leganavyaaship|leganavyantinukecarrier|leganavyantiswarm|leganavyartyship|leganavybattleship|leganavybattlesub|leganavyconsub|leganavycruiser|leganavyengineer|leganavyflagship|leganavyheavysub|leganavymissileship|leganavyradjamship|leghastatus|leghastatusalt|legnavyaaship|legnavyartyship|legnavyconship|legnavydestro|legnavyfrigate|legnavyrezsub|legnavyscout|legnavysub|legoptio|legpontus|legstingray|legtriarius|legtriariusalt|legvelite)$`)
	// Nukes: the silos (the engine credits a missile's kills to its silo)
	// and the tactical launchers.
	nukeRE = regexp.MustCompile(`^(armsilo|corsilo|legsilo|cortron|legperdition)$`)
)

// unitClass names what a def is, for the battle phrases.
func unitClass(d snapshot.UnitDef) string {
	name := strings.TrimSuffix(d.Name, "_scav")
	switch {
	case isCommander(name) || d.IsCommander:
		return classCommander
	case nukeRE.MatchString(name):
		return classNuke
	case lrGunRE.MatchString(name):
		return classLRGun
	case bomberRE.MatchString(name):
		return classBomber
	case fighterRE.MatchString(name):
		return classFighter
	case gunshipRE.MatchString(name):
		return classGunship
	case d.IsFactory:
		return classFactory
	case isStructure(d) && isEcoBuilding(d):
		return classEco
	case isStructure(d) && d.WeaponCount > 0:
		return classDefence
	case isStructure(d):
		return classBuilding
	case d.CanFly:
		return classAir
	case shipRE.MatchString(name):
		return classShip
	case d.MetalCost >= experimentalCost && d.WeaponCount > 0:
		return classExperimental
	case d.WeaponCount > 0:
		return classArmy
	}
	return classUnit
}
