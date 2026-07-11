-- Harness for assets/lua/replay_uploader.lua: stubs the Spring/VFS API, runs
-- the real widget with BOTH emitters enabled over a deterministic simulated
-- game (movers, stationary structures, births, deaths, damage, an enemy team
-- that must be filtered out), and leaves <gameId>.brsnap + <gameId>.brepstream
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

-- 40 friendly units (teams 0/2 -> ally 0; 60% stationary) + 12 enemy units
-- (team 1 -> ally 1) the widget must drop.
for i = 1, 40 do
	addUnit((i % 2 == 0) and 2 or 0, rnd() > 0.6)
end
for i = 1, 12 do
	addUnit(1, true)
end

local allyOf = { [0] = 0, [1] = 1, [2] = 0 }
local curFrame = 0

local function advance()
	for _, id in ipairs(order) do
		local u = units[id]
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

Spring = {
	Echo = function(...) print(...) end,
	GetAllUnits = function()
		local out = {}
		for i = 1, #order do
			out[i] = order[i]
		end
		return out
	end,
	GetUnitPosition = function(id) local u = units[id]; return u.x, 25, u.z end,
	GetUnitDefID = function(id) return units[id].def end,
	GetUnitTeam = function(id) return units[id].team end,
	GetUnitHealth = function(id)
		local u = units[id]
		return u.hp, u.maxHp, 0, 0, u.build
	end,
	GetUnitVelocity = function(id) local u = units[id]; return u.vx, 0, u.vz end,
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
widget:GameID("FEED5EED00000000000000000000BEEF")

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
	-- Births and deaths (friendly only, so both emitters see them). The world
	-- moves on while the widget is disabled; those events are simply lost.
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
