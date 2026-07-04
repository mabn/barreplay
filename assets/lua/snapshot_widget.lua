-- BAR Replay Snapshotter widget.
--
-- Injected into <write-dir>/LuaUI/Widgets/ by the Go tool before launching the
-- engine on a replay. It runs read-only: it never issues unit orders or mutates
-- simulation state, so it cannot desync the deterministic replay. It samples every
-- visible unit every `sampleEvery` frames and writes tagged lines directly to the
-- output file whose absolute path the Go tool substitutes into __OUTPUT_PATH__.
--
-- Writing to a dedicated file (not Spring.Echo) is deliberate: the engine flushes
-- its log on every Echo AND caps each Echo at a few hundred units, so streaming
-- snapshots through stdout was both slow and truncated. A plain file handle has
-- neither limit. Only the small `[barreplay] ...` heartbeat lines still go through
-- Spring.Echo, for infolog visibility / the -progress poller.
--
-- BAR only auto-runs a user widget whose name is already in its saved widget order
-- list, so `enabled = true` below is not sufficient on its own; the Go tool also
-- seeds LuaUI/Config/BYAR.lua to enable this widget (see internal/engine).
--
-- File format (see internal/capture/capture.go):
--   BRSNAP D <defID> <name>
--   BRSNAP T <teamID> <allyTeam> <side>
--   BRSNAP READY
--   BRSNAP F <frame> <timeSec> <count>
--   BRSNAP U <id> <def> <team> <x> <y> <z> <hp> <maxHp>
--   BRSNAP EV <frame> <kind> <id> <def> <team>
-- Plain "[barreplay] ..." heartbeat lines are also echoed for infolog visibility;
-- capture ignores anything without the BRSNAP tag.

function widget:GetInfo()
	return {
		name    = "BAR Replay Snapshotter",
		desc    = "Emits periodic unit-position snapshots to stdout for headless replay capture.",
		author  = "barreplay",
		date    = "2026",
		license = "MIT",
		layer   = 0,
		enabled = true, -- self-enable; the tool also seeds the widget order list
	}
end

-- Sampling interval in sim frames. Overridden at write time by the Go tool
-- substituting the __SAMPLE_EVERY__ token; falls back to 30 (1 Hz).
local sampleEvery = tonumber("__SAMPLE_EVERY__") or 30

-- Heartbeat interval in sim frames. BAR simulates at 30 frames/sec, so 300 frames
-- is one line every ~10s of game time (use 150 for ~5s).
local heartbeatEvery = 300

-- Target playback speed. setminspeed forces the sim up to this multiplier so the
-- replay fast-forwards instead of running realtime; the engine clamps to its own
-- ceiling and otherwise runs as fast as the CPU allows.
local playbackSpeed = 1000

-- Snapshot output file path (substituted by the Go tool). Spring's LuaIO sandbox
-- rejects absolute paths (see IsSafePath), so this is a RELATIVE path resolved
-- against the engine's write-dir; the Go tool reads it back from there. `out` is
-- the open file handle.
local outputPath = "__OUTPUT_PATH__"
local out = nil

local Echo = Spring.Echo
local spGetAllUnits    = Spring.GetAllUnits
local spGetUnitPosition = Spring.GetUnitPosition
local spGetUnitDefID   = Spring.GetUnitDefID
local spGetUnitTeam    = Spring.GetUnitTeam
local spGetUnitHealth  = Spring.GetUnitHealth
local spGetGameSeconds = Spring.GetGameSeconds

-- High-resolution timing for the per-sample processing cost. Spring.GetTimer /
-- DiffTimers give sub-millisecond precision (reported as microseconds); on an
-- engine without them we fall back to os.clock (millisecond resolution).
local spGetTimer = Spring.GetTimer
local spDiffTimers = Spring.DiffTimers
local hiResTimer = (spGetTimer ~= nil and spDiffTimers ~= nil)

local function startClock()
	if hiResTimer then
		return spGetTimer()
	end
	return os.clock()
end

-- elapsedStr returns the time since startClock() as "<n>us" (microseconds) when a
-- high-res timer is available, else "<n>ms" (milliseconds).
local function elapsedStr(t0)
	if hiResTimer then
		local ms = spDiffTimers(spGetTimer(), t0) -- milliseconds (float)
		return string.format("%.0fus", ms * 1000)
	end
	return string.format("%.1fms", (os.clock() - t0) * 1000)
end

local function forceMaxSpeed()
	Spring.SendCommands("setmaxspeed " .. playbackSpeed)
	Spring.SendCommands("setminspeed " .. playbackSpeed)
end

-- writeChunk writes s plus a trailing newline to the output file (no-op if the
-- file could not be opened).
local function writeChunk(s)
	if out then
		out:write(s, "\n")
	end
end

local function emitPreamble()
	local parts = {}
	-- Unit-def id -> internal name table (stable for the whole game).
	for defID, ud in pairs(UnitDefs) do
		parts[#parts + 1] = string.format("BRSNAP D %d %s", defID, ud.name)
	end
	-- Teams and their allyteam + side.
	for _, teamID in ipairs(Spring.GetTeamList()) do
		local _, _, _, _, side, allyTeam = Spring.GetTeamInfo(teamID, false)
		parts[#parts + 1] = string.format("BRSNAP T %d %d %s", teamID, allyTeam or -1, side or "")
	end
	parts[#parts + 1] = "BRSNAP READY"
	writeChunk(table.concat(parts, "\n"))
	if out then
		out:flush()
	end
end

function widget:Initialize()
	-- Run as fast as possible and see the whole map (spectator full view), so
	-- GetAllUnits returns every unit regardless of line-of-sight.
	forceMaxSpeed()
	Spring.SendCommands("spectatorfullview 1")
	out = io.open(outputPath, "w")
	if out then
		Echo(string.format("[barreplay] snapshot widget loaded: writing %s, sampling every %d frames, heartbeat every %d, speed %d",
			outputPath, sampleEvery, heartbeatEvery, playbackSpeed))
	else
		Echo("[barreplay] ERROR: could not open output file: " .. tostring(outputPath))
	end
	emitPreamble()
end

function widget:GameFrame(frame)
	local beat = (frame % heartbeatEvery == 0)
	local sample = (frame % sampleEvery == 0)
	if not beat and not sample then
		return
	end
	-- Time the whole sample, including gathering the unit list.
	local t0
	if sample then
		t0 = startClock()
	end
	local units = spGetAllUnits()
	local n = #units

	-- Write the whole sampled frame (F line + all U lines) to the output file in one
	-- write. A file handle has no per-write size cap and isn't flushed by the engine
	-- on every call, so this scales to thousands of units — unlike Spring.Echo.
	local sampleTime
	if sample then
		local lines = { string.format("BRSNAP F %d %.3f %d", frame, spGetGameSeconds(), n) }
		for i = 1, n do
			local unitID = units[i]
			local x, y, z = spGetUnitPosition(unitID)
			local defID = spGetUnitDefID(unitID)
			local team = spGetUnitTeam(unitID)
			local hp, maxHp = spGetUnitHealth(unitID)
			lines[i + 1] = string.format("BRSNAP U %d %d %d %.1f %.1f %.1f %.1f %.1f",
				unitID, defID or -1, team or -1, x or 0, y or 0, z or 0, hp or 0, maxHp or 0)
		end
		writeChunk(table.concat(lines, "\n"))
		if out then
			out:flush() -- flush every sample so the file is durable if the run is cut short
		end
		sampleTime = elapsedStr(t0)
	end

	if beat then
		-- Re-assert speed in case demo playback reset it, and show progress. Include
		-- the sample processing time when this heartbeat frame was also sampled.
		forceMaxSpeed()
		if sampleTime then
			Echo(string.format("[barreplay] heartbeat frame=%d t=%.0fs units=%d sample_time=%s",
				frame, spGetGameSeconds(), n, sampleTime))
		else
			Echo(string.format("[barreplay] heartbeat frame=%d t=%.0fs units=%d", frame, spGetGameSeconds(), n))
		end
	end
end

local function event(kind, unitID, defID, team)
	writeChunk(string.format("BRSNAP EV %d %s %d %d %d",
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

local function closeOut()
	if out then
		out:flush()
		out:close()
		out = nil
	end
end

function widget:GameOver()
	Echo("[barreplay] game over; quitting")
	closeOut()
	-- Clean, deterministic exit of the headless process.
	Spring.SendCommands("quitforce")
end

-- Shutdown fires on engine teardown even if GameOver did not (e.g. the run was
-- cut short); make sure the output file is flushed and closed.
function widget:Shutdown()
	closeOut()
end
