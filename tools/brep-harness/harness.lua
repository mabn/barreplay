-- Harness for assets/lua/replay_uploader.lua: stubs the Spring/VFS API and
-- runs the REAL widget over a deterministic simulated game (movers, stationary
-- structures, births, deaths, damage, and an enemy team with scripted
-- LOS/radar visibility windows exercising enemy recording, visibility-driven
-- dropping, and death tombstones), leaving a .brepstream in the current
-- directory. Two modes, one fixture each:
--
--   (default)  the live uploader, as a player on ally team 0 records it
--              -> harness.brepstream
--   resim      the re-simulation sampler: the Go tool's substitutions applied,
--              a full-view spectator of a replay, with scripted damage,
--              kills, a unit changing hands, a team dying, a player leaving,
--              team statistics, per-side LOS and profiler readings
--              -> harness_resim.brepstream
--
-- The streams are committed as internal/capture/testdata fixtures, and the
-- tests there decode them against golden JSON dumps (TestHarnessGolden),
-- which pins the Lua encoder <-> Go decoder lockstep. Regenerate after any
-- widget codec change (requires Lua 5.4 for string.pack):
--
--	cd internal/capture/testdata
--	lua5.4 ../../../tools/brep-harness/harness.lua ../../../assets/lua/replay_uploader.lua
--	lua5.4 ../../../tools/brep-harness/harness.lua ../../../assets/lua/replay_uploader.lua resim
--	cd .. && go test -run TestHarnessGolden -update .
--
-- and read the golden diff: it is the change in what the widget records.

local widgetPath = arg[1] or "assets/lua/replay_uploader.lua"
local resim = (arg[2] == "resim")
local outName = resim and "harness_resim.brepstream" or "harness.brepstream"

-- Deterministic PRNG (LCG) so regenerated fixtures only change when the codec
-- does. Do not use math.random: it differs across Lua versions.
local seed = 0x2545F491
local function rnd() -- [0,1)
	seed = (seed * 1103515245 + 12345) % 2147483648
	return seed / 2147483648
end

-- ---------------------------------------------------------------------------
-- Simulated game state.

local SAMPLES = 140     -- crosses two keyframe boundaries (64, 128)
local sampleEvery = 30

local units = {}   -- id -> unit
local order = {}   -- ids in GetAllUnits order (kept sorted for determinism)
local nextID = 3

local function addUnit(team, mobile)
	local u = {
		id = nextID,
		team = team,
		def = (nextID % 37) + 1,
		x = rnd() * 8000,
		z = rnd() * 8000,
		vx = 0,
		vz = 0,
		hp = 200 + rnd() * 3500,
		maxHp = 0,
		build = (rnd() < 0.2) and rnd() or 1,
		mobile = mobile,
	}
	u.maxHp = u.hp
	nextID = nextID + 3
	units[u.id] = u
	order[#order + 1] = u.id
	table.sort(order)
	return u
end

-- 40 friendly units (teams 0/2 -> ally 0; 60% stationary) + 19 enemy units
-- (team 1 -> ally 1) with scripted visibility windows (below) that exercise
-- the widget's enemy recording, visibility-driven dropping, and death
-- tombstones.
for i = 1, 40 do
	addUnit((i % 2 == 0) and 2 or 0, rnd() > 0.6)
end

-- Enemy visibility schedules: ranges {fromSample, toSample, state}, hardcoded
-- on purpose — stub call COUNTS depend on widget internals, so driving
-- visibility or wobble from the shared LCG would couple fixture bytes to the
-- widget beyond the codec. States: "los" (full data), "radar" (returned by
-- GetAllUnits but def/health/velocity read back nil and the position wobbles;
-- team stays readable, matching the live engine), "dot" (the engine's frozen
-- radar-MEMORY dot for an unseen unit: still returned by GetAllUnits, typed
-- def + team readable, health/velocity nil, position frozen at where it was
-- last seen — the dot SURVIVES the unit's death, which is how a real capture
-- resurrected a tombstoned ghost), "dying" (the KILLED unit itself, in LOS
-- and not yet deleted while its death sequence runs: everything reads back
-- normally except health, which is 0, and GetUnitIsDead says true — the
-- second way a real capture resurrected a tombstoned ghost), no window =
-- invisible.
-- Context: keyframes land at samples 0/64 (segment 1) and 74/138 (segment 2);
-- the widget is disabled for samples 70..73; scripted deaths/reuse happen at
-- s=20/30/40/44/71/100 (see the main loop).
local enemyVis = {
	{ { 5, 999, "los" } },                                         -- id 123: in view until destroyed at s=100
	{ { 10, 29, "los" }, { 30, 39, "radar" } },                    -- id 126: LOS -> radar -> dropped from s=40 (unlisted)
	{ { 20, 34, "radar" } },                                       -- id 129: never typed (def 0), dropped from s=35
	{ { 80, 94, "los" }, { 110, 124, "los" } },                    -- id 132: visibility gap 95..109, re-recorded across keyframe 138
	{ { 71, 73, "los" } },                                         -- id 135: visible only while the widget is disabled
	{ { 0, 49, "los" } },                                          -- id 138: in the first keyframe, dropped from s=50
	{ { 55, 63, "los" } },                                         -- id 141: vanishes exactly at keyframe 64
	{ { 0, 999, "los" } },                                         -- id 144: plain live enemy across both segments
	{ { 90, 999, "radar" } },                                      -- id 147: wobbling blip to the end
	{ { 15, 24, "los" }, { 25, 44, "radar" }, { 45, 54, "los" } }, -- id 150: identity carried through radar
	{ { 30, 44, "los" } },                                         -- id 153: destroyed in view at s=44 (segment 1)
	{ { 0, 20, "los" }, { 40, 60, "los" } },                       -- id 156: visibility gap 21..39 inside segment 1
	{ { 10, 24, "radar" }, { 25, 69, "dot" } },                    -- id 159: destroyed at s=40 while its dot persists (the resurrection bug)
	{ { 10, 19, "los" }, { 20, 29, "dot" } },                      -- id 162: destroyed in view s=20, corpse-dot through 29, id REUSED at s=30
	{ { 5, 19, "radar" }, { 20, 49, "dot" } },                     -- id 165: dies unseen at s=20; its dot is recorded through 49, dropped from s=50
	{ { 10, 29, "los" }, { 30, 33, "dying" } },                    -- id 168: killed in LOS at s=30, still readable (hp 0) through 33
	{ { 60, 69, "los" }, { 71, 76, "dying" } },                    -- id 171: killed at s=71 while the widget is DISABLED — no callin ever fires
	{ { 10, 24, "los" } },                                         -- id 174: dropped the moment it goes unlisted (s=25)
	{ { 10, 30, "los" } },                                         -- id 177: damaged on its LAST visible sample (s=30), dropped from s=31
}
for i = 1, #enemyVis do
	addUnit(1, true).vis = enemyVis[i]
end
-- Kept stationary since the pre-1.5.0 scout-check fixtures so regenerated
-- streams stay comparable across widget versions.
units[174].mobile = false
units[177].mobile = false

local allyOf = { [0] = 0, [1] = 1, [2] = 0 }
local projectiles = {} -- projectile id -> { owner, team }
local killedShooters = {} -- units killed so far, in order: { id, team }
local curFrame = 0

-- building maps builderID -> the id it is constructing/assisting this sample
-- (the GetUnitIsBuilding stub). Recomputed each sample from the deterministic
-- state: every friendly under-construction unit is assigned one finished
-- friendly unit as its builder, in id order — so targets appear, follow their
-- construction for ~16 samples (build += 0.05), and vanish when it finishes,
-- exercising the target column across keyframes and restatements.
local building = {}
local function assignBuilders()
	building = {}
	local taken = {}
	for _, id in ipairs(order) do
		local u = units[id]
		if allyOf[u.team] == 0 and u.build < 1 then
			for _, bid in ipairs(order) do
				local b = units[bid]
				if bid ~= id and allyOf[b.team] == 0 and b.build >= 1
					and taken[bid] == nil then
					building[bid] = id
					taken[bid] = true
					break
				end
			end
		end
	end
end

-- visState returns "los"/"radar"/nil for the CURRENT sample; friendlies (no
-- schedule) are always in LOS.
local function visState(u)
	if resim then
		-- Full view: everything alive is listed, a killed unit only while
		-- its death sequence runs ("dying"), nothing as a memory dot.
		if u.dead then
			local s = math.floor(curFrame / sampleEvery)
			for i = 1, #(u.vis or {}) do
				local w = u.vis[i]
				if s >= w[1] and s <= w[2] and w[3] == "dying" then
					return "dying"
				end
			end
			return nil
		end
		return "los"
	end
	if not u.vis then
		return "los"
	end
	local s = math.floor(curFrame / sampleEvery)
	for i = 1, #u.vis do
		local w = u.vis[i]
		if s >= w[1] and s <= w[2] then
			return w[3]
		end
	end
	return nil
end

local function advance()
	for _, id in ipairs(order) do
		local u = units[id]
		-- A unit entering its "dot" window freezes at the position it was
		-- last seen — BEFORE this sample's movement (the engine's memory dot
		-- shows where the player lost it, not where it secretly went).
		local vs = u.vis and visState(u) or nil
		if u.frozen == nil and (vs == "dot" or vs == "dying") then
			u.frozen = { u.x, u.z }
		end
		if u.mobile then
			if rnd() < 0.15 then
				u.vx, u.vz = (rnd() - 0.5) * 6, (rnd() - 0.5) * 6
			end
			u.x = math.max(0, math.min(12000, u.x + u.vx * sampleEvery))
			u.z = math.max(0, math.min(12000, u.z + u.vz * sampleEvery))
		end
		if rnd() < 0.08 then
			u.hp = u.hp * 0.9
		end
		if u.build < 1 then
			u.build = math.min(1, u.build + 0.05)
		end
	end
end

-- ---------------------------------------------------------------------------
-- Spring/VFS/engine stubs.

local function pk(fmt, t)
	if type(t) ~= "table" then
		t = { t }
	end
	local parts = {}
	for i = 1, #t do
		local v = t[i]
		-- Spring's Lua numbers are single-precision floats; Lua 5.4's are
		-- not. An integer column value a float cannot hold exactly would be
		-- silently wrong in the real engine (0xFFFFFFFF packed as 0 once),
		-- so the harness refuses it rather than packing what the engine
		-- never would.
		if fmt ~= "f" and v ~= string.unpack("<f", string.pack("<f", v)) then
			error(("Pack%s(%s): not exact as a float32, Spring's Lua number"):format(fmt, tostring(v)), 2)
		end
		parts[i] = string.pack("<" .. fmt, v)
	end
	return table.concat(parts)
end

VFS = {
	PackU8 = function(t) return pk("I1", t) end,
	PackU16 = function(t) return pk("I2", t) end,
	PackU32 = function(t) return pk("I4", t) end,
	PackS16 = function(t) return pk("i2", t) end,
	PackF32 = function(t) return pk("f", t) end,
}

-- The GameID rules param appears shortly after game start (BAR's game_id.lua
-- gadget publishes it) — the harness delays it past the first sample so the
-- widget's buffer-until-resolved path is exercised too.
local rulesGameID = nil

-- Scouted areas driving the IsPosInLos stub: {fromSample, toSample, unitID} —
-- during the window, everything within 64 elmos of that unit's current (or
-- frozen) position is in LOS. Widget >= 1.5.0 no longer runs the ghost scout
-- check, so IsPosInLos goes uncalled — the stub (and these windows) stay so
-- the harness still runs a pre-1.5.0 widget for fixture archaeology.
local scoutWindows = {
	{ 40, 42, 174 },
	{ 31, 33, 177 },
}

-- Scripted player comms: {sample, callin, args...}. "console" drives
-- widget:AddConsoleLine with a raw engine console line, "draw" drives
-- widget:MapDrawCmd. Between them these cover every branch of the widget's
-- comm recording: each chat channel and speaker shape, colour-code stripping,
-- a multi-line console payload, all three draw command types — and the lines
-- that must NOT be recorded (engine noise, the widget's own heartbeat echo, and
-- the "added point" console line that duplicates a MapDrawCmd already seen).
-- GetPlayerInfo below names the two players "Player 0" and "Player 1".
local commScript = {
	{ 2, "console", "<Player 0> hello team" },
	{ 3, "console", "[f=0000090] <Player 1> Allies: pushing north" },
	{ 5, "console", "[Player 1] Spectators: nice game" },
	{ 6, "console", "> <LobbyOnly> from the battleroom" },
	{ 8, "console", "<Player 0>  whispered Player 1: psst" },
	{ 9, "console", "<Player 1> \255\255\000\000red\bnormal" },
	{ 11, "console", "<Player 0> line one\n<Player 1> line two" },
	{ 12, "console", "Player 0 added point: here" },   -- MapDrawCmd already has it
	{ 12, "console", "[replay-uploader] heartbeat frame=360" }, -- our own echo
	{ 12, "console", "Game will start in 5 seconds" }, -- engine noise
	{ 12, "console", "<NotAPlayer> unknown speaker" }, -- no such player
	{ 12, "draw", 0, "point", 1200.5, 80, 3400.25, "here" },
	{ 13, "draw", 1, "point", 5000, 80, 5000, "" },    -- unlabelled marker
	{ 14, "draw", 0, "line", 1200, 80, 3400, 1260, 80, 3450 },
	{ 15, "draw", 0, "line", 1260, 80, 3450, 1330, 80, 3505 },
	{ 16, "draw", 1, "erase", 5000, 80, 5000, 100 },
	{ 90, "console", "<Player 0> gg" },
	{ 91, "draw", 0, "point", -20, 80, 9000, "off-map" }, -- negative coordinate
}

Spring = {
	Echo = function(...) print(...) end,
	GetGameRulesParam = function(k)
		if k == "GameID" then
			return rulesGameID
		end
		return nil
	end,
	GetAllUnits = function()
		local out = {}
		for i = 1, #order do
			if visState(units[order[i]]) ~= nil then
				out[#out + 1] = order[i]
			end
		end
		return out
	end,
	GetUnitPosition = function(id)
		local u = units[id]
		local vs = visState(u)
		if vs == "radar" then
			-- Deterministic wobble, LCG-free (see the enemyVis comment).
			return u.x + ((id * 7919 + curFrame * 131) % 65) - 32, 25,
				u.z + ((id * 104729 + curFrame * 37) % 65) - 32
		end
		if vs == "dot" or vs == "dying" then
			-- The engine's memory dot is frozen where the unit was last seen
			-- (captured lazily at the first dot-state read); the real unit —
			-- or nothing at all, if it died — keeps moving underneath. A
			-- "dying" unit stops where it was killed.
			if u.frozen == nil then
				u.frozen = { u.x, u.z }
			end
			return u.frozen[1], 25, u.frozen[2]
		end
		return u.x, 25, u.z
	end,
	GetUnitDefID = function(id)
		if visState(units[id]) == "radar" then
			return nil -- untyped radar contact; a memory dot stays typed
		end
		return units[id].def
	end,
	GetUnitTeam = function(id) return units[id].team end, -- readable even on radar
	-- Projectiles in flight from a unit that has since died (see combat).
	GetProjectileTeamID = function(pid) return projectiles[pid] and projectiles[pid].team end,
	GetProjectileOwnerID = function(pid) return projectiles[pid] and projectiles[pid].owner end,
	GetUnitHealth = function(id)
		local u = units[id]
		local vs = visState(u)
		if vs == "radar" or vs == "dot" then
			return nil
		end
		if vs == "dying" then
			return 0, u.maxHp, 0, 0, u.build -- killed, not deleted yet
		end
		return u.hp, u.maxHp, 0, 0, u.build
	end,
	GetGroundHeight = function(x, z) return 25 end,
	-- Position-level LOS for the ghost scout check. True only inside an
	-- active scoutWindows entry, near its target unit's frozen (or live)
	-- position — everywhere else the fog stays shut.
	IsPosInLos = function(x, y, z)
		local smp = math.floor(curFrame / sampleEvery)
		for i = 1, #scoutWindows do
			local w = scoutWindows[i]
			if smp >= w[1] and smp <= w[2] then
				local u = units[w[3]]
				if u ~= nil then
					local ux = (u.frozen and u.frozen[1]) or u.x
					local uz = (u.frozen and u.frozen[2]) or u.z
					if (x - ux) * (x - ux) + (z - uz) * (z - uz) <= 4096 then -- 64^2
						return true
					end
				end
			end
		end
		return false
	end,
	-- Engine truth about a unit the client can currently sense. A memory dot
	-- is remembered, not sensed, so it reads back nil like every other
	-- LOS-gated getter.
	GetUnitIsDead = function(id)
		local u = units[id]
		local vs = u and visState(u)
		if vs == nil or vs == "dot" then
			return nil
		end
		return u.dead == true
	end,
	GetUnitIsBuilding = function(id) return building[id] end,
	GetUnitVelocity = function(id)
		local u = units[id]
		local vs = visState(u)
		if vs == "radar" or vs == "dot" then
			return nil
		end
		return u.vx, 0, u.vz
	end,
	GetGameSeconds = function() return curFrame / 30 end,
	GetGameFrame = function() return curFrame end,
	GetTeamList = function() return { 0, 1, 2 } end,
	GetTeamInfo = function(t) return t, 0, false, false, (t == 1) and "cortex" or "armada", allyOf[t] end,
	GetTeamColor = function(t) return 0.25 * (t + 1), 0.5, 0.75 end,
	GetTeamResources = function(t, kind)
		if allyOf[t] ~= 0 and not resim then
			return nil -- LOS: enemy economy unreadable
		end
		if kind == "metal" then
			return 100 + t, 500, 0, 0.5 + t
		end
		return 1000 + t, 6800, 0, 25 + t
	end,
	GetPlayerList = function() return { 0, 1 } end,
	GetPlayerInfo = function(p) return "Player " .. p, true, false, p end,
	GetSpectatingState = function() return resim, resim end,
	GetMyAllyTeamID = function() return 0 end,
	GetMyPlayerID = function() return 0 end,
	IsReplay = function() return resim end,
	SendCommands = function(cmd) sentCommands[#sentCommands + 1] = cmd end,
	GetAllyTeamList = function() return { 0, 1 } end,
	GetGaiaTeamID = function() return 99 end, -- not in the team list: no gaia side
	-- Raw LOS bits (1 = in LOS, 2 = in radar, 4 = previously in LOS, 8 =
	-- continuous radar). Ally 0 sees team 1 through the scripted enemyVis
	-- windows; ally 1 sees ally 0 on a fixed deterministic rotation; a side
	-- always sees its own units fully.
	GetUnitLosState = function(id, allyTeam, raw)
		local u = units[id]
		if allyOf[u.team] == allyTeam then
			return 15
		end
		if allyTeam == 0 then
			if not u.vis then
				return 0
			end
			local s = math.floor(curFrame / sampleEvery)
			for i = 1, #u.vis do
				local w = u.vis[i]
				if s >= w[1] and s <= w[2] then
					return (w[3] == "los" or w[3] == "dying") and 3 or (w[3] == "radar" and 2 or 4)
				end
			end
			return 0
		end
		return (id + math.floor(curFrame / 300)) % 4
	end,
	GetUnitExperience = function(id) return (id % 7) * 0.125 end,
	-- The engine's team statistics: count, then the rows in a range.
	GetTeamStatsHistory = function(t, from, to)
		if from == nil then
			return 3
		end
		local rows = {}
		for i = from, to - 1 do
			rows[#rows + 1] = { frame = i * 450, metalProduced = 100 * i + t, energyProduced = 1000 * i,
				damageDealt = 50 * i * (t + 1), unitsKilled = i + t, unitsDied = i }
		end
		return rows
	end,
	GetProfilerRecordNames = function() return { "Sim", "Sim::Path", "Lua" } end,
	GetProfilerTimeRecord = function(name, frameData)
		local base = ({ Sim = 4000, ["Sim::Path"] = 600, Lua = 250 })[name]
		return base + curFrame / 10
	end,
}
Game = { gameSpeed = 30, mapName = "Harness Map 1.0", gameVersion = "Beyond All Reason test-harness" }
Engine = { version = "2026-harness" }
UnitDefs = {}
for d = 1, 38 do
	UnitDefs[d] = { name = "def" .. d, humanName = "Def " .. d, health = 1000 + d,
		xsize = 2, zsize = 2, canMove = true, isBuilding = false,
		maxWeaponRange = (d % 3 == 0) and 0 or 300 + d,
		customParams = { techlevel = tostring(1 + d % 3), unitgroup = (d % 2 == 0) and "weapon" or "builder",
			iscommander = (d == 1) and "1" or nil },
		deathExplosion = "deathblast" }
end
WeaponDefs = {}
for w = 0, 4 do
	WeaponDefs[w] = { name = "weapon" .. w, description = (w == 0) and "" or "Weapon " .. w,
		type = "Cannon", range = 300 + 50 * w, reload = 1.5, damages = { [0] = 100 + w },
		paralyzer = (w == 4) }
end
-- Every unit's death blast: a chain explosion's weapon (see kill).
WeaponDefs[5] = { id = 5, name = "deathblast", type = "Cannon", range = 0, reload = 0,
	damages = { [0] = 500 }, damageAreaOfEffect = 1e6 }
WeaponDefNames = { deathblast = WeaponDefs[5] }
sentCommands = {}
widgetHandler = { RemoveWidget = function() error("widget removed itself") end }
-- The handler API the resim sampler uses to switch BAR's own widget suite off.
local disabledWidgets = {}
local function newWidget()
	return {
		widgetHandler = {
			widgets = { 1, 2, 3 },
			knownWidgets = {
				["BAR Replay Snapshotter"] = { active = true },
				["Some BAR widget"] = { active = true },
				["An inactive widget"] = { active = false },
			},
			DisableWidget = function(self, name) disabledWidgets[#disabledWidgets + 1] = name end,
			-- BAR's handler (luaui/barwidgets.lua) forwards UnitDamaged with
			-- its first five arguments only, and its top-level callin is a
			-- closure over this method rebuilt by UpdateCallIn. Mirrored here
			-- so the widget's way around it is what the fixture exercises.
			UnitDamaged = function(self, unitID, unitDefID, unitTeam, damage, paralyzer)
				if widget.UnitDamaged then
					widget:UnitDamaged(unitID, unitDefID, unitTeam, damage, paralyzer)
				end
			end,
			UpdateCallIn = function(self, name)
				local f = self[name]
				engineCallIns[name] = function(...) return f(self, ...) end
			end,
		},
	}
end
-- The engine's view of LuaUI's callins: what it calls, with every argument.
engineCallIns = {}
widget = newWidget()
widget.widgetHandler:UpdateCallIn("UnitDamaged")

-- unitDamaged is the engine delivering a hit to LuaUI.
local function unitDamaged(...)
	engineCallIns.UnitDamaged(...)
end

-- ---------------------------------------------------------------------------
-- Load the widget. In resim mode, apply the Go tool's substitutions exactly as
-- internal/engine WriteWidget does (every switch on).

local patched = assert(io.open(widgetPath, "r")):read("a")
if resim then
	local subs = {
		__RESIM__ = "1", __OUTPUT_PATH__ = outName, __SAMPLE_EVERY__ = tostring(sampleEvery),
		__PROFILE__ = "1", __DISABLE_WIDGETS__ = "1", __DAMAGE__ = "1", __VISIBILITY__ = "1",
	}
	for token, value in pairs(subs) do
		local n
		patched, n = patched:gsub(token, value)
		assert(n > 0, "token " .. token .. " not found in " .. widgetPath)
	end
end
assert(load(patched, "@" .. widgetPath))()

widget:Initialize()

-- Resim-only scripted combat. firstOf returns the first live unit of an ally
-- team in id order — the scripted attacker. Nothing here consumes the LCG, so
-- the live fixture's simulated game is the same with or without it.
local function firstOf(ally, except)
	for _, id in ipairs(order) do
		local u = units[id]
		if u and not u.dead and allyOf[u.team] == ally and id ~= except then
			return u
		end
	end
	return nil
end

-- killer returns the destroyed-callin attacker arguments for a death: the
-- first unit of the other side and a weapon (live mode: the engine hands a
-- playing client nothing).
local function killer(victim)
	if not resim then
		return nil
	end
	local a = firstOf(allyOf[victim.team] == 0 and 1 or 0, victim.id)
	if a == nil then
		return nil
	end
	return a.id, a.def, a.team, victim.id % 4
end

-- kill delivers a killing blow (a hit past the remaining health, so the
-- damage window records overkill) and the destroyed callin with its cause.
local function kill(id)
	local u = units[id]
	local aID, aDef, aTeam, weapon = killer(u)
	if resim and widget.UnitDamaged and aID then
		local before = u.hp
		u.hp = -25
		unitDamaged(id, u.def, u.team, before + 25, false, weapon, 1, aID, aDef, aTeam)
	end
	widget:UnitDestroyed(id, u.def, u.team, aID, aDef, aTeam, weapon)
	killedShooters[#killedShooters + 1] = { id = id, team = u.team }
	-- Its death blast hits a teammate: the engine names no attacker and no
	-- projectile, only the blast weapon, and the widget credits the killer.
	if resim and widget.UnitDamaged and aID then
		local n = firstOf(allyOf[u.team], id)
		if n then
			unitDamaged(n.id, n.def, n.team, 40, false, 5, -1, nil, nil, nil)
			-- ...and sometimes the engine names the exploding unit itself as
			-- the attacker: still the killer's credit, not the dead unit's.
			if id % 2 == 0 then
				unitDamaged(n.id, n.def, n.team, 30, false, 5, -1, id, u.def, u.team)
			end
		end
	end
end

-- combat lands this sample's scripted hits: every unit whose id and sample
-- line up is hit by the first unit of the other side, with a paralyzer
-- weapon (4) now and then, and every so often by nothing at all (a crash,
-- a self-destruct: no attacker).
local function combat(s)
	if not (resim and widget.UnitDamaged) then
		return
	end
	for _, id in ipairs(order) do
		local u = units[id]
		if u and not u.dead and (id + s) % 13 == 0 then
			local a = firstOf(allyOf[u.team] == 0 and 1 or 0, id)
			local weapon = (id + s) % 5
			local dmg = 10 + (id * 7 + s) % 50
			local dead = killedShooters[#killedShooters]
			if s % 17 == 0 or a == nil then
				unitDamaged(id, u.def, u.team, dmg, false, nil, nil, nil, nil, nil)
			elseif s % 7 == 0 then
				-- lava (the engine's water damage, -5): no weapon, no projectile
				unitDamaged(id, u.def, u.team, dmg, false, -5, -1, nil, nil, nil)
			elseif s % 5 == 0 and dead and allyOf[dead.team] ~= allyOf[u.team] then
				-- a shell from a unit that has died since it fired: the engine
				-- names no attacker, the projectile still knows its owner
				local pid = 1000 + dead.id
				projectiles[pid] = { owner = dead.id, team = dead.team }
				unitDamaged(id, u.def, u.team, dmg, false, weapon, pid, nil, nil, nil)
			else
				unitDamaged(id, u.def, u.team, dmg, weapon == 4, weapon, 1, a.id, a.def, a.team)
			end
		end
	end
end

-- Mid-game the player disables the widget for a few samples, then re-enables
-- it: the handler shuts the instance down (saving its config) and later loads
-- a FRESH instance, restoring the config. The GameID callin does not re-fire,
-- so the new instance must recover the id from the config and APPEND a new
-- stream segment. Both fixture files therefore contain two segments.
-- (Live mode only: a re-simulation is one uninterrupted process.)
local DISABLE_AT, ENABLE_AT = 70, 74
if resim then
	DISABLE_AT, ENABLE_AT = -1, -1
end
local widgetActive = true

for s = 0, SAMPLES - 1 do
	curFrame = s * sampleEvery
	if s > 0 then
		advance()
	end
	if s == 1 then
		-- game_id.lua has run by now; the first sample (s=0) was buffered
		-- and must be drained into the files this opens. Uppercase: the
		-- widget lowercases ids.
		rulesGameID = "FEED5EED00000000000000000000BEEF"
	end
	if s == DISABLE_AT then
		local saved = widget:GetConfigData()
		widget:Shutdown()
		widgetActive = false
		widget = newWidget()
		assert(load(patched, "@" .. widgetPath))()
		widget:SetConfigData(saved)
	elseif s == ENABLE_AT then
		widget:Initialize() -- no GameID callin this time
		widgetActive = true
	end
	-- Scripted enemy lifecycle: a mid-game enemy birth in view (s=85) and two
	-- deaths witnessed in LOS (the widget must tombstone those units).
	-- Enemies that die out of view don't exist here — an invisible unit just
	-- keeps (or ends) its window; unlisted means unrecorded.
	--
	-- Tombstone scenarios: these two deaths fire UnitDestroyed WITHOUT
	-- removing the unit — its "dot" window keeps it in GetAllUnits, exactly
	-- the engine behavior that resurrected a buried ghost in a real capture.
	if s == 40 then
		kill(159)
		units[159].dead = true
	end
	if s == 20 then
		kill(162)
		units[162].dead = true
		units[165].dead = true -- dies out of view: no callin, only a memory dot
	end
	-- Killed in LOS: the callin fires AND the killed unit is still returned by
	-- GetAllUnits for a few samples (its "dying" window) reading hp 0. Trusting
	-- that read to mean "alive, so a new unit reused the id" is what left 57
	-- dead units standing in a real capture.
	if s == 30 then
		kill(168)
		units[168].dead = true
	end
	-- id 177 takes damage on its LAST visible sample: the changed hp is
	-- recorded at s=30 and the unit vanishes from the stream at s=31.
	if s == 30 then
		units[177].hp = units[177].hp - 100
	end
	-- Killed while the widget is DISABLED (samples 70..73): the fresh instance
	-- never sees a UnitDestroyed for it and has no tombstone — the hp 0 read is
	-- the only evidence it is dead.
	if s == 71 then
		units[171].dead = true
	end
	if s == 30 then
		-- The engine reuses ids: a NEW enemy unit takes id 162 (created out
		-- of view, so no UnitCreated callin) and is in LOS from here — the
		-- widget must notice the reuse (readable health) and un-tombstone it.
		local u = units[162]
		u.def, u.team = 20, 1
		u.x, u.z = u.x + 2000, u.z + 2000
		u.vx, u.vz = 0, 0
		u.hp, u.maxHp = 900, 900
		u.build = 1
		u.frozen, u.dead = nil, nil
		u.vis = { { 30, 999, "los" } }
	end
	if s == 85 then
		local u = addUnit(1, true)
		u.vis = { { 85, 99, "los" }, { 100, 109, "radar" } }
		if widgetActive then
			widget:UnitCreated(u.id, u.def, u.team)
		end
	end
	if s == 44 or s == 100 then
		local id = (s == 44) and 153 or 123
		local u = units[id]
		if widgetActive then
			kill(id)
		end
		units[id] = nil
		for i = 1, #order do
			if order[i] == id then
				table.remove(order, i)
				break
			end
		end
	end
	-- Births and deaths (friendly only). The world moves on while the widget
	-- is disabled; those events are simply lost.
	if s % 7 == 3 then
		local u = addUnit(0, true)
		if widgetActive then
			widget:UnitCreated(u.id, u.def, u.team)
		end
	end
	if s % 9 == 5 then
		for _, id in ipairs(order) do
			if allyOf[units[id].team] == 0 then
				if widgetActive then
					kill(id)
				end
				units[id] = nil
				for i = 1, #order do
					if order[i] == id then
						table.remove(order, i)
						break
					end
				end
				break
			end
		end
	end
	if widgetActive then
		for _, c in ipairs(commScript) do
			if c[1] == s then
				if c[2] == "console" then
					widget:AddConsoleLine(c[3], 0)
				else
					widget:MapDrawCmd(c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10])
				end
			end
		end
	end
	-- Re-sim only: a unit whose health runs out but which the engine keeps
	-- listing for a while before it is destroyed (a crashing aircraft) must
	-- be RECORDED, at 0 hp, every sample until its destroyed event — the
	-- viewer draws it grey. Unit 144 crashes at s=60 and is destroyed at 63.
	if resim and s == 60 then
		units[144].hp = -5
	end
	if resim and s == 63 then
		kill(144)
		units[144] = nil
		for i = 1, #order do
			if order[i] == 144 then
				table.remove(order, i)
				break
			end
		end
	end
	if widgetActive then
		combat(s)
		-- A unit changing hands: the first team-2 unit goes to team 0 (the
		-- engine fires UnitTaken for the old owner as well; the widget
		-- records one event per transfer).
		if s == 50 then
			for _, id in ipairs(order) do
				local u = units[id]
				if u.team == 2 then
					u.team = 0
					if widget.UnitTaken then widget:UnitTaken(id, u.def, 2, 0) end
					widget:UnitGiven(id, u.def, 0, 2)
					break
				end
			end
		end
		if s == 110 then
			widget:PlayerRemoved(1, 1)
		end
		if s == 120 then
			widget:TeamDied(1)
		end
	end
	assignBuilders()
	if widgetActive then
		widget:GameFrame(curFrame)
	end
end
curFrame = SAMPLES * sampleEvery - 5
widget:GameOver({ 0 })
widget:Shutdown()

if resim then
	assert(#disabledWidgets == 1 and disabledWidgets[1] == "Some BAR widget",
		"resim must disable exactly the other active widget, got " .. table.concat(disabledWidgets, ","))
	assert(sentCommands[#sentCommands] == "quitforce", "resim must quit at game over")
else
	assert(#disabledWidgets == 0 and #sentCommands == 0, "the uploader must not touch the game")
	local id = "feed5eed00000000000000000000beef"
	os.remove(outName)
	assert(os.rename(id .. ".brepstream", outName))
end
print("HARNESS: wrote " .. outName .. " (" .. SAMPLES .. " samples)")
