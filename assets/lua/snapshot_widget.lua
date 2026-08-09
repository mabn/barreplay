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
--   BRSNAP GAME <json>                         stream semantics marker (protocol; preamble)
--   BRSNAP DEF <json>                          full unit-def (JSON; preamble)
--   BRSNAP T <teamID> <allyTeam> <side> <color>   team info (side "_" = none)
--   BRSNAP P <playerID> <team> <spectator> <name...>   player info (preamble)
--   BRSNAP READY
--   BRSNAP F <frame> <timeSec> <count>
--   BRSNAP U <id> <def> <team> <x> <y> <z> <hp> <maxHp> <vx> <vy> <vz> <build> <target>
--   BRSNAP R <teamID> <metal> <energy> <mStore> <eStore> <mIncome> <eIncome>   team economy
--   BRSNAP EV <frame> <kind> <id> <def> <team>
--   BRSNAP PROF <totalMs> <name>               engine time-profiler record (at game over)
--   BRSNAP PROFD <frame> <units> <totalMs> <name>   per-heartbeat profiler sample (-profile only)
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
		handler = true, -- grants widget.widgetHandler (used to disable the default suite)
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

-- Profile mode (substituted by the Go tool from -profile). When on, Initialize
-- enables the engine's time profiler so the fine-grained scopes (Sim::Unit::*,
-- Sim::Los, ...) record — CTimeProfiler drops non-"special" timers while
-- disabled — and each heartbeat writes per-scope PROFD samples to the stream.
local profileMode = ("__PROFILE__" == "1")

-- Disable BAR's default widget suite (substituted from -disable-widgets). In a
-- replay the game's whole UI widget set loads and runs per-frame callins nobody
-- watches — pure unsynced overhead (~15% of wall time measured). Widgets cannot
-- affect the synced sim, so disabling them cannot change the captured data.
local disableWidgets = ("__DISABLE_WIDGETS__" == "1")

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
local spGetUnitVelocity = Spring.GetUnitVelocity
local spGetUnitIsBuilding = Spring.GetUnitIsBuilding
local spGetGameSeconds = Spring.GetGameSeconds
local spGetTeamList    = Spring.GetTeamList
local spGetTeamInfo    = Spring.GetTeamInfo
local spGetTeamColor   = Spring.GetTeamColor
local spGetTeamResources = Spring.GetTeamResources
local spGetPlayerList  = Spring.GetPlayerList
local spGetPlayerInfo  = Spring.GetPlayerInfo

-- Sim frames per game-second (30 in BAR). Reported in the GAME preamble line
-- (the stream-semantics marker; see protocolVersion below).
local gameSpeed = (Game and Game.gameSpeed) or 30

-- Protocol version of the GAME line / capture stream semantics (shared with
-- the Replay uploader widget — see internal/capture).
-- 3: resource income is written as the engine reports it (already per
--    game-second — GetTeamResources' income accumulates over
--    TEAM_SLOWUPDATE_RATE = 30 sim frames = 1 game-second). Streams without a
--    GAME line (this widget pre-protocol-3) or with protocol <= 2 wrongly
--    multiplied it by gameSpeed; the decoder divides it back out.
local protocolVersion = 3

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
		-- DiffTimers returns SECONDS unless returnMs=true is passed — omitting it
		-- once made 2ms samples display as "2us".
		local ms = spDiffTimers(spGetTimer(), t0, true) -- milliseconds (float)
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

-- The engine keeps an internal time profiler (the /debug overlay data): named
-- scopes like "Sim", "Sim::Path", "Lua" with accumulated wall time. Recoil
-- exposes it to Lua, which lets us report where the replay run actually spends
-- its time. Scopes nest ("Sim::Path" time is also inside "Sim"), so totals
-- overlap and do not sum to wall time — read them as relative weights.
local spGetProfilerRecordNames = Spring.GetProfilerRecordNames
local spGetProfilerTimeRecord  = Spring.GetProfilerTimeRecord

-- collectProfilerTotals returns { {name=..., ms=<total accumulated ms>}, ... }
-- sorted largest first. May raise; call via profilerTotals.
local function collectProfilerTotals()
	local names = spGetProfilerRecordNames()
	if not names then
		return nil
	end
	local recs = {}
	for i = 1, #names do
		local name = names[i]
		-- The second (frameData) argument is nominally optional but MUST be passed:
		-- the engine pushes its return values before reading arg 2 at a fixed stack
		-- index, so with only one argument it reads its own pushed number there and
		-- raises "boolean expected, got number".
		local totalMs = spGetProfilerTimeRecord(name, false) -- first return: total ms
		if totalMs and totalMs > 0 then
			recs[#recs + 1] = { name = name, ms = totalMs }
		end
	end
	table.sort(recs, function(a, b) return a.ms > b.ms end)
	return recs
end

-- profilerTotals is the safe wrapper around collectProfilerTotals: profiling is
-- auxiliary, and an error escaping a callin makes BAR's widget handler unload the
-- whole widget — which would silently kill snapshot sampling too. On the first
-- failure it reports the error and disables further attempts.
local profilerBroken = false
local function profilerTotals()
	if profilerBroken or not (spGetProfilerRecordNames and spGetProfilerTimeRecord) then
		return nil
	end
	local ok, recs = pcall(collectProfilerTotals)
	if not ok then
		profilerBroken = true
		Echo("[barreplay] engine time profiler failed (" .. tostring(recs) .. "); disabling prof output")
		return nil
	end
	return recs
end

-- emitProfileTotals writes the largest profiler records as BRSNAP PROF lines to
-- the output file so the Go CLI can print a where-did-the-time-go summary.
local function emitProfileTotals()
	local recs = profilerTotals()
	if not recs or not recs[1] then
		Echo("[barreplay] engine time profiler not available; skipping PROF summary")
		return
	end
	local lines = {}
	for i = 1, math.min(#recs, 40) do
		lines[i] = string.format("BRSNAP PROF %.1f %s", recs[i].ms, recs[i].name)
	end
	writeChunk(table.concat(lines, "\n"))
end

-- Draw-frame counter: widget:Update fires exactly once per draw frame, so the
-- per-heartbeat delta is the engine's real draw rate — the direct check on
-- whether -throttle-draw is holding (the sim/draw balance can be overridden by
-- e.g. packet-queue starvation against the local demo server).
local drawFrames = 0
local lastDrawFrames = 0

function widget:Update()
	drawFrames = drawFrames + 1
end

-- activeWidgetCount reports how many widgets are currently active ("-" if the
-- handler is unavailable): confirms the default suite stayed disabled.
local function activeWidgetCount()
	local wh = widget.widgetHandler
	local ok, n = pcall(function() return #wh.widgets end)
	if ok and n then
		return tostring(n)
	end
	return "-"
end

-- disableOtherWidgets turns off every other active widget through the handler's
-- queued DisableWidget (callin-safe: the handler applies it between callins).
-- BAR auto-enables its whole game-archive widget suite in replays and a seeded
-- order list cannot prevent that (absent widgets re-enable at order 12345), so
-- runtime disabling via the handler is the only reliable off switch. Runs once,
-- from the first GameFrame, when the full suite is guaranteed loaded.
local widgetsDisabled = false
local function disableOtherWidgets()
	widgetsDisabled = true
	local wh = widget.widgetHandler
	if not (wh and wh.knownWidgets and wh.DisableWidget) then
		Echo("[barreplay] widget handler API unavailable; leaving default widgets enabled")
		return
	end
	local n = 0
	for name, ki in pairs(wh.knownWidgets) do
		if ki.active and name ~= "BAR Replay Snapshotter" then
			wh:DisableWidget(name)
			n = n + 1
		end
	end
	Echo(string.format("[barreplay] disabling %d default widgets (unsynced overhead only)", n))
end

-- jsonEscape escapes the characters JSON forbids raw in a string. Unit-def
-- humanNames can carry spaces, quotes and non-ASCII (translated), so the def
-- table is emitted as JSON rather than space-delimited fields; raw UTF-8 bytes
-- are left as-is (valid JSON).
local function jsonEscape(s)
	s = string.gsub(s, "\\", "\\\\")
	s = string.gsub(s, '"', '\\"')
	s = string.gsub(s, "\n", "\\n")
	s = string.gsub(s, "\r", "\\r")
	s = string.gsub(s, "\t", "\\t")
	return s
end

-- jsonValue encodes a scalar Lua value (string/number/boolean) as JSON.
local function jsonValue(v)
	local t = type(v)
	if t == "string" then
		return '"' .. jsonEscape(v) .. '"'
	elseif t == "boolean" then
		return v and "true" or "false"
	elseif t == "number" then
		if v == math.floor(v) and math.abs(v) < 1e15 then
			return string.format("%d", v)
		end
		return string.format("%.3f", v)
	end
	return "null"
end

-- defJSON serialises one unit def as a compact JSON object. Fields are listed in
-- a fixed order; any that the engine build does not expose (nil) is skipped, so
-- this stays robust across engine/mod versions.
local function defJSON(defID, ud)
	local fields = {
		{ "id", defID },
		{ "name", ud.name },
		{ "humanName", ud.translatedHumanName or ud.humanName },
		{ "metalCost", ud.metalCost },
		{ "energyCost", ud.energyCost },
		{ "buildTime", ud.buildTime },
		{ "maxHealth", ud.health },
		{ "speed", ud.speed },
		{ "xsize", ud.xsize },
		{ "zsize", ud.zsize },
		{ "iconType", ud.iconType },
		{ "isBuilder", ud.isBuilder },
		{ "isBuilding", ud.isBuilding },
		{ "isFactory", ud.isFactory },
		{ "canFly", ud.canFly },
		{ "canMove", ud.canMove },
		{ "weaponCount", ud.weapons and #ud.weapons or nil },
	}
	local parts = {}
	for _, kv in ipairs(fields) do
		if kv[2] ~= nil then
			parts[#parts + 1] = '"' .. kv[1] .. '":' .. jsonValue(kv[2])
		end
	end
	return "{" .. table.concat(parts, ",") .. "}"
end

local function emitPreamble()
	local parts = {}
	-- Stream-semantics marker (protocol 3 = income already per game-second);
	-- the caller's demo-seeded metadata wins over the other fields.
	parts[#parts + 1] = string.format(
		'BRSNAP GAME {"protocol":%d,"mode":"replay","sampleEvery":%d,"gameSpeed":%d}',
		protocolVersion, sampleEvery, gameSpeed)
	-- Full unit-def table (stable for the whole game). Mods add/modify units, so
	-- the whole definition is dumped, not just id->name.
	for defID, ud in pairs(UnitDefs) do
		parts[#parts + 1] = "BRSNAP DEF " .. defJSON(defID, ud)
	end
	-- Teams: allyteam, side and in-game colour (side "_" = none, so the colour
	-- token stays in a fixed position).
	for _, teamID in ipairs(spGetTeamList()) do
		local _, _, _, _, side, allyTeam = spGetTeamInfo(teamID, false)
		local r, g, b = spGetTeamColor(teamID)
		local color = "-"
		if r then
			color = string.format("#%02x%02x%02x",
				math.floor(r * 255 + 0.5), math.floor(g * 255 + 0.5), math.floor(b * 255 + 0.5))
		end
		if side == nil or side == "" then
			side = "_"
		end
		parts[#parts + 1] = string.format("BRSNAP T %d %d %s %s", teamID, allyTeam or -1, side, color)
	end
	-- Players: name (last, may contain spaces), controlling team, spectator flag.
	for _, playerID in ipairs(spGetPlayerList()) do
		local name, _, spectator, teamID = spGetPlayerInfo(playerID, false)
		parts[#parts + 1] = string.format("BRSNAP P %d %d %d %s",
			playerID, teamID or -1, (spectator and 1) or 0, name or "")
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
	if profileMode then
		-- "debug <drawDebug> <draw4Real>": arg 1 enables CTimeProfiler collection
		-- (unlocking the non-"special" scopes like Sim::Unit::*), arg 2 keeps the
		-- ProfileDrawer overlay off — there is nothing to draw headless.
		Spring.SendCommands("debug 1 0")
		Echo("[barreplay] profile mode: engine time profiler enabled (debug 1 0)")
	end
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
	if disableWidgets and not widgetsDisabled then
		local ok, err = pcall(disableOtherWidgets)
		if not ok then
			Echo("[barreplay] disabling widgets failed (" .. tostring(err) .. "); continuing")
		end
	end
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
			-- GetUnitHealth's 5th return is buildProgress (1 = finished, <1 = under
			-- construction). Velocity is the current movement vector.
			local hp, maxHp, _, _, buildProgress = spGetUnitHealth(unitID)
			local vx, vy, vz = spGetUnitVelocity(unitID)
			-- Build/assist/repair target (nil for non-builders and idle builders).
			local tgt = spGetUnitIsBuilding ~= nil and spGetUnitIsBuilding(unitID) or nil
			lines[i + 1] = string.format("BRSNAP U %d %d %d %.1f %.1f %.1f %.1f %.1f %.2f %.2f %.2f %.3f %d",
				unitID, defID or -1, team or -1, x or 0, y or 0, z or 0, hp or 0, maxHp or 0,
				vx or 0, vy or 0, vz or 0, buildProgress or 1, tgt or 0)
		end
		-- Per-team economy at this frame. GetTeamResources returns
		-- current, storage, pull, income, ... — income is already per
		-- game-second (accumulated over TEAM_SLOWUPDATE_RATE = 30 sim frames),
		-- so it is written as-is. The widget spectates full-view, so it can
		-- read every team's resources.
		for _, teamID in ipairs(spGetTeamList()) do
			local m, mStore, _, mInc = spGetTeamResources(teamID, "metal")
			local e, eStore, _, eInc = spGetTeamResources(teamID, "energy")
			lines[#lines + 1] = string.format("BRSNAP R %d %.1f %.1f %.1f %.1f %.2f %.2f",
				teamID, m or 0, e or 0, mStore or 0, eStore or 0,
				mInc or 0, eInc or 0)
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
		local draws = drawFrames - lastDrawFrames
		lastDrawFrames = drawFrames
		local line = string.format("[barreplay] heartbeat frame=%d t=%.0fs units=%d draws=%d widgets=%s",
			frame, spGetGameSeconds(), n, draws, activeWidgetCount())
		if sampleTime then
			line = line .. " sample_time=" .. sampleTime
		end
		Echo(line)
		-- Top profiler scopes so far (infolog only): shows whether the frame cost
		-- is drifting (e.g. Sim growing with unit count) as the replay progresses.
		local recs = profilerTotals()
		if recs and recs[1] then
			local parts = {}
			for i = 1, math.min(5, #recs) do
				parts[i] = string.format("%s=%.0fms", recs[i].name, recs[i].ms)
			end
			Echo("[barreplay] prof " .. table.concat(parts, " "))
			-- In profile mode, also record per-scope cumulative totals with the
			-- current unit count into the stream: the CLI turns consecutive samples
			-- into per-interval deltas and reports which scopes grow with unit count.
			if profileMode then
				local lines = {}
				for i = 1, math.min(15, #recs) do
					lines[i] = string.format("BRSNAP PROFD %d %d %.1f %s", frame, n, recs[i].ms, recs[i].name)
				end
				writeChunk(table.concat(lines, "\n"))
			end
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
	emitProfileTotals()
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
