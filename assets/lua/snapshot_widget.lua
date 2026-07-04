-- BAR Replay Snapshotter widget.
--
-- Injected into <write-dir>/LuaUI/Widgets/ by the Go tool before launching
-- spring-headless on a replay. It runs read-only: it never issues unit orders or
-- mutates simulation state, so it cannot desync the deterministic replay. It
-- samples every visible unit every `sampleEvery` frames and emits tagged lines to
-- stdout (via Spring.Echo) which the Go `capture` package parses.
--
-- Wire format (see internal/capture/capture.go):
--   BRSNAP D <defID> <name>
--   BRSNAP T <teamID> <allyTeam> <side>
--   BRSNAP READY
--   BRSNAP F <frame> <timeSec> <count>
--   BRSNAP U <id> <def> <team> <x> <y> <z> <hp> <maxHp>
--   BRSNAP EV <frame> <kind> <id> <def> <team>

function widget:GetInfo()
	return {
		name    = "BAR Replay Snapshotter",
		desc    = "Emits periodic unit-position snapshots to stdout for headless replay capture.",
		author  = "barreplay",
		date    = "2026",
		license = "MIT",
		layer   = 0,
		enabled = true, -- self-enable so it runs unattended in headless mode
	}
end

-- Sampling interval in sim frames. Overridden at write time by the Go tool
-- substituting the __SAMPLE_EVERY__ token; falls back to 30 (1 Hz).
local sampleEvery = tonumber("__SAMPLE_EVERY__") or 30

local Echo = Spring.Echo
local spGetAllUnits    = Spring.GetAllUnits
local spGetUnitPosition = Spring.GetUnitPosition
local spGetUnitDefID   = Spring.GetUnitDefID
local spGetUnitTeam    = Spring.GetUnitTeam
local spGetUnitHealth  = Spring.GetUnitHealth
local spGetGameSeconds = Spring.GetGameSeconds

local function emitPreamble()
	-- Unit-def id -> internal name table (stable for the whole game).
	for defID, ud in pairs(UnitDefs) do
		Echo(string.format("BRSNAP D %d %s", defID, ud.name))
	end
	-- Teams and their allyteam + side.
	for _, teamID in ipairs(Spring.GetTeamList()) do
		local _, _, _, _, side, allyTeam = Spring.GetTeamInfo(teamID, false)
		Echo(string.format("BRSNAP T %d %d %s", teamID, allyTeam or -1, side or ""))
	end
	Echo("BRSNAP READY")
end

function widget:Initialize()
	-- Run as fast as the CPU allows and see the whole map (spectator full view),
	-- so GetAllUnits returns every unit regardless of line-of-sight.
	Spring.SendCommands("setmaxspeed 1000")
	Spring.SendCommands("setminspeed 1000")
	Spring.SendCommands("spectatorfullview 1")
	emitPreamble()
end

function widget:GameFrame(frame)
	if frame % sampleEvery ~= 0 then
		return
	end
	local units = spGetAllUnits()
	local n = #units
	Echo(string.format("BRSNAP F %d %.3f %d", frame, spGetGameSeconds(), n))
	for i = 1, n do
		local unitID = units[i]
		local x, y, z = spGetUnitPosition(unitID)
		local defID = spGetUnitDefID(unitID)
		local team = spGetUnitTeam(unitID)
		local hp, maxHp = spGetUnitHealth(unitID)
		Echo(string.format("BRSNAP U %d %d %d %.1f %.1f %.1f %.1f %.1f",
			unitID, defID or -1, team or -1, x or 0, y or 0, z or 0, hp or 0, maxHp or 0))
	end
end

local function event(kind, unitID, defID, team)
	Echo(string.format("BRSNAP EV %d %s %d %d %d",
		Spring.GetGameFrame(), kind, unitID, defID or -1, team or -1))
end

function widget:UnitCreated(unitID, unitDefID, unitTeam)
	event("created", unitID, unitDefID, unitTeam)
end

function widget:UnitFinished(unitID, unitDefID, unitTeam)
	event("finished", unitID, unitDefID, unitTeam)
end

function widget:UnitDestroyed(unitID, unitDefID, unitTeam)
	event("destroyed", unitID, unitDefID, unitTeam)
end

function widget:GameOver()
	Echo("BRSNAP READY") -- ensure meta flushes even for zero-frame games
	-- Clean, deterministic exit of the headless process.
	Spring.SendCommands("quitforce")
end
