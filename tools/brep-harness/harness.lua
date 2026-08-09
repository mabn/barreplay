-- Harness for assets/lua/replay_uploader.lua: stubs the Spring/VFS API, runs
-- the real widget with BOTH emitters enabled over a deterministic simulated
-- game (movers, stationary structures, births, deaths, damage, and an enemy
-- team with scripted LOS/radar visibility windows exercising enemy recording
-- + ghost persistence), and leaves <gameId>.brsnap + <gameId>.brepstream
-- in the current directory.
--
-- The pair is committed as internal/capture/testdata fixtures (text gzipped);
-- TestBrepstreamMatchesTextFixture cross-checks that the Go .brepstream
-- decoder reconstructs the same game the battle-tested text parser sees, which
-- pins the Lua encoder <-> Go decoder lockstep. Regenerate after any widget
-- codec change (requires lua5.4 for string.pack):
--
--	cd internal/capture/testdata
--	lua5.4 ../../../tools/brep-harness/harness.lua ../../../assets/lua/replay_uploader.lua
--	gzip -9 -f harness.brsnap
--
-- The harness renames the outputs to harness.* for stable fixture names.

local widgetPath = arg[1] or "assets/lua/replay_uploader.lua"

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
-- the widget's enemy recording, ghost persistence, and death tombstones.
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
	{ { 10, 29, "los" }, { 30, 39, "radar" } },                    -- id 126: LOS -> radar -> ghost across keyframe 64
	{ { 20, 34, "radar" } },                                       -- id 129: never typed (def 0), then untyped ghost
	{ { 80, 94, "los" }, { 110, 124, "los" } },                    -- id 132: ghost -> live again -> ghost across keyframe 138
	{ { 71, 73, "los" } },                                         -- id 135: visible only while the widget is disabled
	{ { 0, 49, "los" } },                                          -- id 138: in the first keyframe, ghost until the segment restart
	{ { 55, 63, "los" } },                                         -- id 141: vanishes exactly at keyframe 64
	{ { 0, 999, "los" } },                                         -- id 144: plain live enemy across both segments
	{ { 90, 999, "radar" } },                                      -- id 147: wobbling blip to the end
	{ { 15, 24, "los" }, { 25, 44, "radar" }, { 45, 54, "los" } }, -- id 150: identity carried through radar
	{ { 30, 44, "los" } },                                         -- id 153: destroyed in view at s=44 (segment 1)
	{ { 0, 20, "los" }, { 40, 60, "los" } },                       -- id 156: ghost gap inside segment 1
	{ { 10, 24, "radar" }, { 25, 69, "dot" } },                    -- id 159: destroyed at s=40 while its dot persists (the resurrection bug)
	{ { 10, 19, "los" }, { 20, 29, "dot" } },                      -- id 162: destroyed in view s=20, corpse-dot through 29, id REUSED at s=30
	{ { 5, 19, "radar" }, { 20, 49, "dot" } },                     -- id 165: dies unseen at s=20; dot through 49, then our ghost to the end
	{ { 10, 29, "los" }, { 30, 33, "dying" } },                    -- id 168: killed in LOS at s=30, still readable (hp 0) through 33
	{ { 60, 69, "los" }, { 71, 76, "dying" } },                    -- id 171: killed at s=71 while the widget is DISABLED — no callin ever fires
	{ { 10, 24, "los" } },                                         -- id 174: ghost from s=25; its spot is SCOUTED empty at s=40 (see scoutWindows)
	{ { 10, 30, "los" } },                                         -- id 177: damaged on its LAST visible sample (s=30), spot scouted s=31..33 — the grace sample delays the drop to s=32
}
for i = 1, #enemyVis do
	addUnit(1, true).vis = enemyVis[i]
end
-- ids 174/177 must be STATIONARY: they "die" unseen where they stood, so the
-- scouted circle (centred on the unit's position in the IsPosInLos stub)
-- coincides with the ghost's frozen spot. A mobile unit would keep drifting
-- invisibly and the scout would sweep the wrong place.
units[174].mobile = false
units[177].mobile = false

local allyOf = { [0] = 0, [1] = 1, [2] = 0 }
local curFrame = 0

-- visState returns "los"/"radar"/nil for the CURRENT sample; friendlies (no
-- schedule) are always in LOS.
local function visState(u)
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
		parts[i] = string.pack("<" .. fmt, t[i])
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
-- frozen) position is in LOS. Targeted at specific units on purpose, so the
-- other ghost scenarios are never accidentally scouted.
local scoutWindows = {
	{ 40, 42, 174 }, -- id 174's ghost spot observed empty -> the widget must drop it
	{ 31, 33, 177 }, -- covers id 177's spot from the sample it vanishes: the
	-- widget saw its state change at s=30, so the scout check skips it at
	-- s=31 (grace) and drops it at s=32
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
		if allyOf[t] ~= 0 then
			return nil -- LOS: enemy economy unreadable
		end
		if kind == "metal" then
			return 100 + t, 500, 0, 0.5 + t
		end
		return 1000 + t, 6800, 0, 25 + t
	end,
	GetPlayerList = function() return { 0, 1 } end,
	GetPlayerInfo = function(p) return "Player " .. p, true, false, p end,
	GetSpectatingState = function() return false, false end,
	GetMyAllyTeamID = function() return 0 end,
	GetMyPlayerID = function() return 0 end,
	IsReplay = function() return false end,
}
Game = { gameSpeed = 30, mapName = "Harness Map 1.0", gameVersion = "Beyond All Reason test-harness" }
Engine = { version = "2026-harness" }
UnitDefs = {}
for d = 1, 38 do
	UnitDefs[d] = { name = "def" .. d, humanName = "Def " .. d, health = 1000 + d,
		xsize = 2, zsize = 2, canMove = true, isBuilding = false }
end
widgetHandler = { RemoveWidget = function() error("widget removed itself") end }
widget = {}

-- ---------------------------------------------------------------------------
-- Load the widget with the text emitter force-enabled (writeText is a debug
-- constant, false by default; the fixtures need both formats from one run).

local src = assert(io.open(widgetPath, "r")):read("a")
local patched, nsub = src:gsub("local writeText = false", "local writeText = true", 1)
assert(nsub == 1, "could not enable writeText in " .. widgetPath)
assert(load(patched, "@" .. widgetPath))()

widget:Initialize()

-- Mid-game the player disables the widget for a few samples, then re-enables
-- it: the handler shuts the instance down (saving its config) and later loads
-- a FRESH instance, restoring the config. The GameID callin does not re-fire,
-- so the new instance must recover the id from the config and APPEND a new
-- stream segment. Both fixture files therefore contain two segments.
local DISABLE_AT, ENABLE_AT = 70, 74
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
		widget = {}
		assert(load(patched, "@" .. widgetPath))()
		widget:SetConfigData(saved)
	elseif s == ENABLE_AT then
		widget:Initialize() -- no GameID callin this time
		widgetActive = true
	end
	-- Scripted enemy lifecycle: a mid-game enemy birth in view (s=85) and two
	-- deaths witnessed in LOS (the widget must bury those units' ghosts).
	-- Enemies that die out of view don't exist here — an invisible unit just
	-- keeps (or ends) its window and its ghost persists.
	--
	-- Tombstone scenarios: these two deaths fire UnitDestroyed WITHOUT
	-- removing the unit — its "dot" window keeps it in GetAllUnits, exactly
	-- the engine behavior that resurrected a buried ghost in a real capture.
	if s == 40 then
		units[159].dead = true
		widget:UnitDestroyed(159, units[159].def, units[159].team)
	end
	if s == 20 then
		units[162].dead = true
		widget:UnitDestroyed(162, units[162].def, units[162].team)
		units[165].dead = true -- dies out of view: no callin, only a memory dot
	end
	-- Killed in LOS: the callin fires AND the killed unit is still returned by
	-- GetAllUnits for a few samples (its "dying" window) reading hp 0. Trusting
	-- that read to mean "alive, so a new unit reused the id" is what left 57
	-- dead units standing in a real capture.
	if s == 30 then
		units[168].dead = true
		widget:UnitDestroyed(168, units[168].def, units[168].team)
	end
	-- id 177 takes damage on its LAST visible sample: the widget records the
	-- changed hp at s=30, so when the unit vanishes and its spot is already
	-- scouted (scoutWindows 31..33) the recent change grants one sample of
	-- grace before the LOS check may drop the ghost.
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
			widget:UnitDestroyed(id, u.def, u.team)
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
					widget:UnitDestroyed(id, units[id].def, units[id].team)
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
		widget:GameFrame(curFrame)
	end
end
widget:GameOver()
widget:Shutdown()

local id = "feed5eed00000000000000000000beef"
os.remove("harness.brsnap")
os.remove("harness.brepstream")
assert(os.rename(id .. ".brsnap", "harness.brsnap"))
assert(os.rename(id .. ".brepstream", "harness.brepstream"))
print("HARNESS: wrote harness.brsnap + harness.brepstream (" .. SAMPLES .. " samples)")
