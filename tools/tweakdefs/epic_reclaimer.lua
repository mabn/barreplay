-- Epic Reclaimer — a tweakdefs script for Beyond All Reason.
--
-- Adds a new unit, "epicreclaimer": a flying, reclaim-only support aircraft.
--
--  * Model: the Epic Serpent (armserpt3) at 50% scale. Neither the Recoil
--    engine nor BAR's gamedata can rescale an .s3o model from a unit def
--    (UnitDef parsing reads no scale key, and there is no rescale gadget),
--    but ARMSERPT3.s3o is literally the base Serpent mesh scaled up 2x —
--    same pieces and vertex counts, every piece offset doubled (s3o radius
--    56 vs 28) — so the base ARMSERP model *is* the armserpt3 model at 50%
--    size (minus the epic's two small bolt-on turrets). We therefore point
--    the def at ARMSERP.s3o + its matching animation script.
--  * Flight: the def is a live deep copy of coraca (Advanced Construction
--    Aircraft), so it inherits coraca's exact flight model — speed 181.5,
--    maxacc 0.065, maxdec 0.4275, turnrate 240, cruisealtitude 70,
--    hoverattack — plus its sounds and physics.
--  * Role: reclaim ONLY. No build options, no assist, no repair, no
--    resurrect, no capture, no terraform. 10000 reclaim power.
--
-- This runs inside gamedata/unitdefs_post.lua's preProcessTweakOptions(),
-- i.e. BEFORE BAR's own post-processing, so the new def gets categories
-- (VTOL etc.), selection volumes, sound defaults and a _scav variant like
-- any shipped unit. The in-game name/tooltip ride on the
-- i18n_en_humanname/i18n_en_tooltip customparams (read by the
-- "Tweakdefs Custom Unit Names" widget).
--
-- Usage: base64-encode this file (URL-safe) and set it as the `tweakdefs`
-- modoption (`!bset tweakdefs <base64>` in a lobby). The unit is buildable
-- from the T1 and Advanced Aircraft Plants, or spawn one directly with cheats:
-- /cheat, then /give epicreclaimer

local UNITNAME      = "epicreclaimer"
local RECLAIM_POWER = 10000
local BUILD_RANGE   = 220     -- reclaim reach (elmos); coraca has 136
local HEALTH        = 1500
local METAL_COST    = 2600
local ENERGY_COST   = 42000
local BUILD_TIME    = 52000
local BUILT_BY      = { -- T1 + advanced aircraft plants
	"armap", "corap", "legap",
	"armaap", "coraap", "legaap",
}

local function deepcopy(t)
	local out = {}
	for k, v in pairs(t) do
		out[k] = (type(v) == "table") and deepcopy(v) or v
	end
	return out
end

local coraca  = UnitDefs.coraca
local armserp = UnitDefs.armserp -- model donor: the armserpt3 mesh at half scale
if not (coraca and armserp) then
	Spring.Echo("[epicreclaimer] missing base defs (coraca/armserp); tweak skipped")
	return
end

local ud = deepcopy(coraca) -- flight model, physics and sounds come from here

-- ===== model: armserpt3 at 50% (== the base Serpent model) =====
ud.objectname             = armserp.objectname  -- Units/ARMSERP.s3o
ud.script                 = armserp.script      -- Units/ARMSERP.cob
ud.buildpic               = "armserpt3.DDS"
ud.footprintx             = armserp.footprintx
ud.footprintz             = armserp.footprintz
ud.collisionvolumetype    = armserp.collisionvolumetype
ud.collisionvolumescales  = armserp.collisionvolumescales
ud.collisionvolumeoffsets = armserp.collisionvolumeoffsets

-- ===== reclaim-only builder =====
ud.builder        = true
ud.canreclaim     = true
ud.workertime     = RECLAIM_POWER
ud.reclaimspeed   = RECLAIM_POWER
ud.builddistance  = BUILD_RANGE
ud.buildoptions   = {}    -- builds nothing
ud.canassist      = false -- cannot help or finish constructions
ud.canrepair      = false
ud.canresurrect   = false
ud.cancapture     = false
ud.canrestore     = false -- no terraform
ud.terraformspeed = 0
ud.energymake     = 0
ud.energystorage  = 0

-- ===== identity / stats =====
ud.icontype   = "air_t1_rez"
ud.health     = HEALTH
ud.metalcost  = METAL_COST
ud.energycost = ENERGY_COST
ud.buildtime  = BUILD_TIME

ud.customparams = {
	unitgroup         = "builder",
	techlevel         = 2,
	model_author      = "FireStorm",
	normaltex         = "unittextures/Arm_normal.dds", -- the Serpent texture set
	i18n_en_humanname = "Epic Reclaimer",
	i18n_en_tooltip   = "Flying Salvage Serpent (can only reclaim)",
}

UnitDefs[UNITNAME] = ud

for _, fac in ipairs(BUILT_BY) do
	local f = UnitDefs[fac]
	if f then
		f.buildoptions = f.buildoptions or {}
		f.buildoptions[#f.buildoptions + 1] = UNITNAME
	end
end
