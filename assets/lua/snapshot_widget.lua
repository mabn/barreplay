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
--   BRSNAP COMM <json>                         a player comm: chat / map drawing
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
-- string.format and table.concat are looked up through _ENV on every call, and
-- the per-unit sample loop calls format once per unit per sample — two hash
-- lookups each, for hundreds of units at 1 Hz over a whole game. Localise them
-- (measured: the per-unit formatting, not the engine queries, is ~7% of the
-- re-sim's sim wall; the engine calls are free by comparison).
local sformat = string.format
local tconcat = table.concat
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
		return sformat("%.0fus", ms * 1000)
	end
	return sformat("%.1fms", (os.clock() - t0) * 1000)
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
	for i = 1, math.min(#recs, 80) do
		lines[i] = sformat("BRSNAP PROF %.1f %s", recs[i].ms, recs[i].name)
	end
	writeChunk(tconcat(lines, "\n"))
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
	Echo(sformat("[barreplay] disabling %d default widgets (unsynced overhead only)", n))
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
			return sformat("%d", v)
		end
		return sformat("%.3f", v)
	end
	return "null"
end

-- jsonObject encodes { {key, value}, ... } pairs in order, skipping nils — so a
-- field the engine build does not expose simply does not appear.
local function jsonObject(fields)
	local parts = {}
	for _, kv in ipairs(fields) do
		if kv[2] ~= nil then
			parts[#parts + 1] = '"' .. kv[1] .. '":' .. jsonValue(kv[2])
		end
	end
	return "{" .. tconcat(parts, ",") .. "}"
end

-- defJSON serialises one unit def as a compact JSON object. Fields are listed in
-- a fixed order; any that the engine build does not expose (nil) is skipped, so
-- this stays robust across engine/mod versions.
local function defJSON(defID, ud)
	return jsonObject({
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
	})
end

-- ---------------------------------------------------------------------------
-- Player comms: what people write and draw, recorded as "BRSNAP COMM <json>"
-- lines — one per message or drawing command. JSON because chat text and
-- marker labels are free-form (spaces, quotes, UTF-8), like the DEF records.
--
--   {"f":<frame>,"k":"chat","p":<playerID>,"d":"all|ally|spec|private|lobby","t":"<text>"}
--   {"f":<frame>,"k":"point","p":<playerID>,"x":<x>,"z":<z>,"t":"<label>"}
--   {"f":<frame>,"k":"line","p":<playerID>,"x":<x>,"z":<z>,"x2":<x2>,"z2":<z2>}
--   {"f":<frame>,"k":"erase","p":<playerID>,"x":<x>,"z":<z>}
-- "n" carries the speaker's name only when "p" is -1 (unresolvable); otherwise
-- the roster's P lines name them.
--
-- This widget watches the demo as a full-view spectator, so the engine hands it
-- EVERY side's chat and drawings — unlike a live player's capture, which sees
-- only what its own client was allowed to.
--
--
-- NOTE: this is the FALLBACK source. Whenever a demo file is available the
-- pipeline replaces these records with the demo's packet stream, which holds
-- every side's chat on every channel and stamps each comm with the frame it
-- truly landed on (internal/demofile/comms.go). What is recorded here is what
-- a capture with no demo behind it still gets — and its frame stamps are
-- approximate, because the engine flushes console lines from its unsynced
-- update rather than when the chat arrives.
-- DRAWINGS come from MapDrawCmd, which is structured (playerID + world
-- coordinates). CHAT has none: BAR's widget handler does not forward
-- GotChatMsg, so the only source is AddConsoleLine — the console's DISPLAY
-- string, whose grammar CGame::HandleChatMsg fixes:
--   "<Name> body"                             a player
--   "[Name] body" / "[Name (replay)] body"    a spectator (demo players are
--                                             all "from demo", hence "(replay)")
--   "> <Name> body"                           relayed from the battleroom
-- with the channel as a prefix of the body ("Allies: ", "Spectators: ",
-- "Private: ", or " whispered <who>: "). A bracketed line only counts as chat
-- when the name belongs to a player of this game — the same disambiguation
-- BAR's own chat widget applies, and what keeps ordinary console output (this
-- widget's "[barreplay] ..." heartbeats included) out of the record.
-- "<Name> added point: <label>" lines are ignored on purpose: that marker
-- already arrived through MapDrawCmd, with coordinates.
--
-- Both callins are pcall-guarded, like the profiler dump: an error escaping a
-- callin makes BAR's handler unload the whole widget, which would silently kill
-- snapshot sampling too.

-- playerIDByName maps a player's engine name (what the console prints) to its
-- id; seeded from the preamble and kept current from PlayerAdded/PlayerChanged.
local playerIDByName = {}

local function notePlayer(playerID)
	local name = spGetPlayerInfo(playerID, false)
	if name and name ~= "" then
		playerIDByName[name] = playerID
	end
end

-- Cap on recorded comms: the viewer downloads the whole comm set before
-- playback, so a game full of enthusiastic drawers must not grow it without
-- bound. The engine already rate-limits drawing to one segment per 50 ms.
local maxComms = 20000
local commCount = 0

-- stripMarkup removes Spring's inline colour codes (a 0xFF byte plus three RGB
-- bytes, and the 0x08 reset) and flattens the remaining control characters, so
-- the recorded text is plain and the JSON stays valid UTF-8.
local function stripMarkup(s)
	s = string.gsub(s, "\255...", "")
	s = string.gsub(s, "%c", " ")
	return (string.gsub(s, "^%s*(.-)%s*$", "%1"))
end

local function writeComm(fields)
	if commCount >= maxComms then
		return
	end
	commCount = commCount + 1
	if commCount == maxComms then
		Echo("[barreplay] comm limit reached (" .. maxComms .. "); no more chat/drawings recorded")
	end
	writeChunk("BRSNAP COMM " .. jsonObject(fields))
end

-- commFrame is the sim frame a comm is stamped with, clamped at 0: chat can
-- arrive during loading, when the engine reports a negative frame.
local function commFrame()
	local f = Spring.GetGameFrame()
	if not f or f < 0 then
		return 0
	end
	return f
end

-- Channel prefixes the engine puts in front of a message body.
local chatChannels = {
	{ "Allies: ", "ally" },
	{ "Spectators: ", "spec" },
	{ "Private: ", "private" },
}

-- splitSpeaker returns name, body, fromLobby for a console line that looks like
-- chat, or nil for anything else.
local function splitSpeaker(line)
	-- Defensive, and only that: the "[f=…]" prefix is added by the FILE and
	-- CONSOLE log sinks (System/Log/FramePrefixer), while the sink feeding
	-- AddConsoleLine gets DefaultFormatter's output, which has no frame in it.
	-- Kept because BAR's own gui_chat strips it too and it costs one match.
	line = string.match(line, "^%[f=[-%d]+%]%s(.*)$") or line
	local lobby = false
	if string.sub(line, 1, 2) == "> " then
		-- The autohost relays battleroom chat as a server message whose body is
		-- itself a "<Name> text" line; a bare "> ..." is a server announcement.
		line = string.sub(line, 3)
		lobby = true
	end
	local first = string.sub(line, 1, 1)
	if first == "<" then
		local i = string.find(line, "> ", 2, true)
		if i then
			return string.sub(line, 2, i - 1), string.sub(line, i + 2), lobby
		end
	elseif first == "[" and not lobby then
		local i = string.find(line, "] ", 2, true)
		if i then
			local name = string.gsub(string.sub(line, 2, i - 1), " %(replay%)$", "")
			return name, string.sub(line, i + 2), false
		end
	end
	return nil
end

local function recordChat(line)
	local name, body, lobby = splitSpeaker(line)
	if not name or not body then
		return
	end
	local playerID = playerIDByName[name]
	if playerID == nil and not lobby then
		return -- ordinary console output that happens to be bracketed
	end
	local dest = "all"
	if lobby then
		dest = "lobby"
	else
		for i = 1, #chatChannels do
			local prefix = chatChannels[i][1]
			if string.sub(body, 1, #prefix) == prefix then
				body, dest = string.sub(body, #prefix + 1), chatChannels[i][2]
				break
			end
		end
		if dest == "all" then
			-- Whispers are readable in a replay: "<Name>  whispered <who>: text"
			-- (the label already ends in a space, hence the leading one here).
			local rest = string.match(body, "^ whispered [^:]*: (.*)$")
			if rest then
				body, dest = rest, "private"
			end
		end
	end
	body = stripMarkup(body)
	if body == "" then
		return
	end
	writeComm({
		{ "f", commFrame() },
		{ "k", "chat" },
		{ "p", playerID or -1 },
		{ "n", playerID == nil and name or nil },
		{ "d", dest },
		{ "t", body },
	})
end

-- One callin can carry several newline-joined lines. Failures are swallowed
-- SILENTLY on purpose: an Echo here would come straight back through this same
-- callin.
function widget:AddConsoleLine(lines, priority)
	if type(lines) ~= "string" then
		return
	end
	for line in string.gmatch(lines, "[^\n]+") do
		pcall(recordChat, line)
	end
end

local function recordDraw(playerID, cmdType, px, pz, a, _, c)
	if cmdType == "point" then
		local label = type(a) == "string" and stripMarkup(a) or ""
		writeComm({
			{ "f", commFrame() }, { "k", "point" }, { "p", playerID or -1 },
			{ "x", px }, { "z", pz },
			{ "t", label ~= "" and label or nil },
		})
	elseif cmdType == "line" then
		writeComm({
			{ "f", commFrame() }, { "k", "line" }, { "p", playerID or -1 },
			{ "x", px }, { "z", pz }, { "x2", a }, { "z2", c },
		})
	elseif cmdType == "erase" then
		writeComm({
			{ "f", commFrame() }, { "k", "erase" }, { "p", playerID or -1 },
			{ "x", px }, { "z", pz },
		})
	end
end

-- Point: a is the label. Line: a/b/c are the far end. Erase: a is the radius
-- (always the engine's constant 100, so it is not recorded). Returning a truthy
-- value would TAKE the event away from the engine, so this returns nothing.
function widget:MapDrawCmd(playerID, cmdType, px, py, pz, a, b, c)
	pcall(recordDraw, playerID, cmdType, px, pz, a, b, c)
end

function widget:PlayerAdded(playerID)
	pcall(notePlayer, playerID)
end

function widget:PlayerChanged(playerID)
	pcall(notePlayer, playerID)
end

local function emitPreamble()
	local parts = {}
	-- Stream-semantics marker (protocol 3 = income already per game-second);
	-- the caller's demo-seeded metadata wins over the other fields.
	parts[#parts + 1] = sformat(
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
			color = sformat("#%02x%02x%02x",
				math.floor(r * 255 + 0.5), math.floor(g * 255 + 0.5), math.floor(b * 255 + 0.5))
		end
		if side == nil or side == "" then
			side = "_"
		end
		parts[#parts + 1] = sformat("BRSNAP T %d %d %s %s", teamID, allyTeam or -1, side, color)
	end
	-- Players: name (last, may contain spaces), controlling team, spectator flag.
	for _, playerID in ipairs(spGetPlayerList()) do
		local name, _, spectator, teamID = spGetPlayerInfo(playerID, false)
		parts[#parts + 1] = sformat("BRSNAP P %d %d %d %s",
			playerID, teamID or -1, (spectator and 1) or 0, name or "")
		if name and name ~= "" then
			playerIDByName[name] = playerID
		end
	end
	parts[#parts + 1] = "BRSNAP READY"
	writeChunk(tconcat(parts, "\n"))
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
		Echo(sformat("[barreplay] snapshot widget loaded: writing %s, sampling every %d frames, heartbeat every %d, speed %d",
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
		local lines = { sformat("BRSNAP F %d %.3f %d", frame, spGetGameSeconds(), n) }
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
			lines[i + 1] = sformat("BRSNAP U %d %d %d %.1f %.1f %.1f %.1f %.1f %.2f %.2f %.2f %.3f %d",
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
			lines[#lines + 1] = sformat("BRSNAP R %d %.1f %.1f %.1f %.1f %.2f %.2f",
				teamID, m or 0, e or 0, mStore or 0, eStore or 0,
				mInc or 0, eInc or 0)
		end
		writeChunk(tconcat(lines, "\n"))
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
		local line = sformat("[barreplay] heartbeat frame=%d t=%.0fs units=%d draws=%d widgets=%s",
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
			for i = 1, math.min(8, #recs) do
				parts[i] = sformat("%s=%.0fms", recs[i].name, recs[i].ms)
			end
			Echo("[barreplay] prof " .. tconcat(parts, " "))
			-- In profile mode, also record per-scope cumulative totals with the
			-- current unit count into the stream: the CLI turns consecutive samples
			-- into per-interval deltas and reports which scopes grow with unit count.
			if profileMode then
				local lines = {}
				for i = 1, math.min(30, #recs) do
					lines[i] = sformat("BRSNAP PROFD %d %d %.1f %s", frame, n, recs[i].ms, recs[i].name)
				end
				writeChunk(tconcat(lines, "\n"))
			end
		end
	end
end

local function event(kind, unitID, defID, team)
	writeChunk(sformat("BRSNAP EV %d %s %d %d %d",
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
