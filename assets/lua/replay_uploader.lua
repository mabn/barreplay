-- Replay uploader widget, and the re-simulation sampler.
--
-- ONE file, two modes.
--
-- As the REPLAY UPLOADER (the file as published) it is a player-installable
-- widget: it runs during a LIVE game on a player's machine, samples the units
-- the player can legitimately see (their own ally team fully; enemy units while
-- in LOS or radar — see recordEnemies below; everything when spectating with
-- full view), and records them to <write-dir>/<gameId>.brepstream — a compact
-- binary stream (columnar VFS.Pack* frames, keyframe + changed-units-only
-- delta). Every knob is a constant below, so one copy works for every game.
--
-- As the RE-SIMULATION SAMPLER the Go tool (internal/engine WriteWidget)
-- injects this same file into a headless engine replaying a demo, with its
-- substitution tokens filled in (the resim flag, the output path, the sample
-- interval, and the profiling/widget/damage/visibility switches). Resim mode
-- watches as a full-view spectator, forces maximum playback speed, disables
-- BAR's own widget suite, quits the engine at game over, and additionally
-- records what only a full view can know: the killer of every unit, damage per
-- second, per-unit totals, per-side visibility, the end of the game and the
-- engine's own team statistics. A file taken straight from the repo has the
-- tokens unfilled and runs as the uploader.
--
-- The output file name is the game's unique id (32-hex, the same id stored in
-- the .sdfz demo header and used by api.bar-rts.com, so this capture
-- self-correlates with the replay), obtained from the "GameID" GameRulesParam
-- that BAR's game_id.lua gadget publishes at game start — BAR's widget handler
-- does NOT forward the engine's GameID callin to widgets, so the callin below
-- is only a fallback for handlers that do. Sampling starts into memory buffers
-- immediately; the file opens the moment the id resolves.
--
-- The widget is read-only (Get* calls and its own output file); it never issues
-- orders or mutates synced state, so it cannot desync a replay. In a live game
-- it must be a polite guest: no speed commands, no spectatorfullview, no
-- quitting, no touching other widgets, and every callin body is pcall-guarded
-- so an error can never unload it mid-game (BAR's handler removes a widget
-- whose callin raises) — after repeated sample failures it closes its file and
-- removes itself instead. Filling number columns and packing them with a few
-- VFS.Pack* C calls costs well under 1 ms per sample.
--
-- .brepstream layout (spec: docs/brepstream-format.md; decoder:
-- internal/capture/brep.go — the two must evolve in lockstep, versioned by the
-- header line and the GAME line's protocol):
--   line "BREPSTREAM 1"
--   text preamble (BRSNAP GID/GAME/DEF/T/P lines), terminated by "BRSNAP READY"
--   then length-framed binary records: <tag u8> <len u32le> <payload>
--   (the whole block may repeat: a widget re-enabled mid-game APPENDS a new
--   segment — see openOutputs; a rejoining client re-simulates from frame 0
--   and truncates instead)
--     F  frame: header + columnar unit data (quantized exactly like .brp:
--        whole elmos / whole hp / velocity as per-sample-interval displacement /
--        build 1/255; y and vy are not stored at all). A keyframe (flag bit 0)
--        carries every visible unit and resets decoder state; a delta frame
--        carries only units that moved off their own prediction (x+dvx, z+dvz,
--        other columns unchanged) plus an explicit dead-id list. Every
--        keyframeEvery-th sample is a keyframe. Flag bit 1 marks the target
--        column (the unit id this one is building/assisting, 0 = none;
--        widget >= 1.4.0).
--     E  unit lifecycle event, text payload
--        "<frame> <kind> <id> <def> <team> [<aID> <aDef> <aTeam> <weapon>]"
--        (the bracketed cause columns: protocol >= 4, see event())
--     C  a player comm — chat message or map drawing — JSON payload
--        (widget >= 1.6.0; see the comms section below)
--     G  a game fact, JSON payload (protocol >= 4; see the game facts section)
--     D  one damage window, packed (resim only; see the damage section)
--     S  per-unit lifetime totals, packed (resim only; see the damage section)
--     V  per-side visibility changes, packed (resim only; see visibility)
--     P  engine time-profiler readings, JSON (resim only; see profiling)
--     X  end of stream, text payload = reason (gameover|shutdown|error)

-- Widget version (semver) and the date that version was cut. Bump BOTH on any
-- user-visible or wire-visible change; they are reported in GetInfo, the load
-- Echo, and the stream's GAME line, so every capture records which encoder
-- produced it (the copy on a player's machine can be arbitrarily old — the
-- server/decoder needs to know, and the catalog stores it per replay).
local widgetVersion = "1.8.0"
local widgetDate = "2026-10-10"

-- Git SHA of this exact file, stamped when the widget is published for
-- download: worker/tools/sync-assets.mjs replaces the token below with the SHA
-- of the last commit that touched this file as it copies it into the worker's
-- public/. Version+date say which release a capture came from; the SHA says
-- which bytes, which is the difference between "1.7.0" and "the 1.7.0 that was
-- actually being served that week".
--
-- A copy taken straight from the repo (or from a working tree with local
-- edits, which the sync refuses to stamp) keeps the token, and the token is
-- not 40 hex, so stampedSha below reports nothing rather than a lie.
local widgetSha = "__WIDGET_SHA__"

-- stampedSha returns the SHA when this copy carries a real one, else nil (the
-- GAME line then omits the field). Deliberately a shape test rather than a
-- comparison against the token: the substituter does a plain textual replace,
-- so a second literal token here would be replaced too and the guard would
-- report every stamped widget as unstamped.
local function stampedSha()
	if #widgetSha == 40 and widgetSha:match("^%x+$") then
		return widgetSha
	end
	return nil
end

-- Re-simulation mode and its switches, filled in by the Go tool when it injects
-- this file into a headless replay (internal/engine WriteWidget). Each test is
-- against a literal "1", so an unsubstituted copy — the published uploader —
-- reads every switch as off.
local resim = ("__RESIM__" == "1")
-- Engine time profiler (the -profile flag): Initialize enables collection and
-- each heartbeat writes the per-scope totals to the stream (P records).
local profileMode = resim and ("__PROFILE__" == "1")
-- Disable BAR's own widget suite (-disable-widgets): in a replay the game's
-- whole UI widget set loads and runs per-frame callins nobody watches — pure
-- unsynced overhead. Widgets cannot affect the synced sim.
local disableWidgets = resim and ("__DISABLE_WIDGETS__" == "1")
-- Damage windows and per-unit totals (D and S records; -damage).
local recordDamage = resim and ("__DAMAGE__" == "1")
-- Per-side visibility (V records; -visibility).
local recordVisibility = resim and ("__VISIBILITY__" == "1")
-- Output path for resim mode. Spring's LuaIO sandbox rejects absolute paths
-- (IsSafePath), so it is RELATIVE to the engine's write-dir, which the Go tool
-- sets as the engine's working directory and reads the stream back from.
local outputPath = resim and "__OUTPUT_PATH__" or nil

-- Log prefix. The Go tool watches the engine's stdout for the first
-- "[barreplay]" line to split load time from sim time, and the -progress
-- poller reads the heartbeats, so resim mode speaks under that tag.
local logTag = resim and "[barreplay]" or "[replay-uploader]"

function widget:GetInfo()
	return {
		-- Resim mode keeps the name the Go tool seeds into BAR's widget order
		-- list (internal/engine/widgetconfig.go): a user widget runs in a
		-- replay only if its name is already there.
		name    = resim and "BAR Replay Snapshotter" or "Replay uploader",
		desc    = "Records unit snapshots (your team + visible enemies) to <gameId>.brepstream for post-game replay visualization.",
		author  = "barreplay",
		version = widgetVersion,
		date    = widgetDate,
		license = "MIT",
		layer   = 0,
		enabled = true,
		-- Grants widget.widgetHandler, which disabling the default suite
		-- needs; the uploader asks for nothing it does not use.
		handler = resim or nil,
	}
end

-- Protocol version of the GAME line / capture stream semantics.
-- 3: resource income is written as the engine reports it (already per
--    game-second — GetTeamResources' income accumulates over
--    TEAM_SLOWUPDATE_RATE = 30 sim frames = 1 game-second). Protocol <= 2
--    widgets wrongly multiplied it by gameSpeed (30x too high); the decoder
--    repairs those streams by dividing it back out.
-- 4: E records may carry the cause columns (killer / previous owner), the
--    "given" event kind exists, DEF carries the techLevel/unitGroup/
--    isCommander/maxWeaponRange extras, and the G/D/S/V/P record types may
--    appear. Purely additive: a protocol-3 decoder skips all of it.
local protocolVersion = 4

-- Enemy recording: units of other ally teams are recorded while visible (in
-- LOS or on radar — Spring.GetAllUnits already returns only what this client
-- can see, so the engine is the visibility filter). The engine's listing IS
-- the record: an enemy that drops out of it (no LOS, no radar signature)
-- disappears from the stream on that very sample — dropped, not marked dead
-- (no destroyed event; it may well be alive in fog) — and is simply recorded
-- afresh if it is ever listed again. Widgets before 1.5.0 instead froze such
-- units into the stream as immobile "ghosts" at their last-known state; that
-- persistence is gone — the capture now shows exactly what this player's
-- sensors report each sample.
-- A death the player could see still buries the unit for good — whether it
-- arrived as a UnitDestroyed callin or simply as a health read of 0 — even
-- though the engine may keep returning its id from GetAllUnits afterwards,
-- as a stale frozen radar-memory dot or as the killed unit itself, still
-- undeleted while its death sequence runs (see buried and unburied below).
-- Radar-only contacts are recorded immediately: their position is the
-- engine's wobbled radar reading, and unreadable columns fall back to the
-- last-known value (def 0 = never identified). false restores the pre-1.1
-- own-ally-team-only behavior.
local recordEnemies = true

-- Sampling interval in sim frames (30 = 1 Hz at BAR's 30 fps sim). A constant
-- for the uploader: every uploader in a game must sample at the same frames
-- (frame % sampleEvery == 0) so the server can merge streams by exact frame
-- number. Resim mode takes the Go tool's -every.
local sampleEvery = (resim and tonumber("__SAMPLE_EVERY__")) or 30

-- Samples per keyframe (64 ≈ one keyframe per minute at 1 Hz, matching the
-- .brp chunk size). A keyframe re-states every unit absolutely and resets the
-- delta predictor, bounding both crash loss and any decoder drift.
local keyframeEvery = 64

-- Heartbeat interval in sim frames (~10s of game time): a small infolog line
-- proving the widget is alive and how cheap each sample was.
local heartbeatEvery = 300

local Echo = Spring.Echo
local spGetAllUnits     = Spring.GetAllUnits
local spGetUnitPosition = Spring.GetUnitPosition
local spGetUnitDefID    = Spring.GetUnitDefID
local spGetUnitTeam     = Spring.GetUnitTeam
local spGetUnitHealth   = Spring.GetUnitHealth
local spGetUnitIsDead   = Spring.GetUnitIsDead -- may be absent on old engines
local spGetUnitVelocity = Spring.GetUnitVelocity
local spGetUnitIsBuilding = Spring.GetUnitIsBuilding
local spGetGameSeconds  = Spring.GetGameSeconds
local spGetGameFrame    = Spring.GetGameFrame
local spGetTeamList     = Spring.GetTeamList
local spGetTeamInfo     = Spring.GetTeamInfo
local spGetTeamColor    = Spring.GetTeamColor
local spGetTeamResources = Spring.GetTeamResources
local spGetPlayerList   = Spring.GetPlayerList
local spGetPlayerInfo   = Spring.GetPlayerInfo
local spGetSpectatingState = Spring.GetSpectatingState
local spGetMyAllyTeamID = Spring.GetMyAllyTeamID
local spGetMyPlayerID   = Spring.GetMyPlayerID
local spGetGameRulesParam = Spring.GetGameRulesParam
local spGetUnitExperience = Spring.GetUnitExperience
local spGetUnitLosState = Spring.GetUnitLosState
local spGetAllyTeamList = Spring.GetAllyTeamList
local spGetGaiaTeamID   = Spring.GetGaiaTeamID
local spGetTeamStatsHistory = Spring.GetTeamStatsHistory

local mathFloor = math.floor

-- Sim frames per game-second (30 in BAR). Reported in the GAME line: the
-- decoder derives frame timestamps (t = frame/gameSpeed) from it, and uses it
-- to repair the over-scaled income of protocol <= 2 streams.
local gameSpeed = (Game and Game.gameSpeed) or 30

-- High-resolution timing for the heartbeat's per-sample cost report.
local spGetTimer = Spring.GetTimer
local spDiffTimers = Spring.DiffTimers
local hiResTimer = (spGetTimer ~= nil and spDiffTimers ~= nil)

local function startClock()
	if hiResTimer then
		return spGetTimer()
	end
	return os.clock()
end

local function elapsedStr(t0)
	if hiResTimer then
		-- DiffTimers returns SECONDS unless returnMs=true is passed.
		local ms = spDiffTimers(spGetTimer(), t0, true)
		return string.format("%.0fus", ms * 1000)
	end
	return string.format("%.1fms", (os.clock() - t0) * 1000)
end

-- ---------------------------------------------------------------------------
-- Binary packing. VFS.PackU8/U16/U32/S16/F32 turn a table of numbers into a
-- little-endian byte string in one C call — the whole point of the binary
-- format: no per-unit string.format. Availability is feature-detected in
-- Initialize; without it the widget cannot record and removes itself.

local PackU8, PackU16, PackU32, PackS16, PackF32

local function detectPack()
	if type(VFS) ~= "table" then
		return false
	end
	PackU8, PackU16, PackU32 = VFS.PackU8, VFS.PackU16, VFS.PackU32
	PackS16, PackF32 = VFS.PackS16, VFS.PackF32
	return PackU8 ~= nil and PackU16 ~= nil and PackU32 ~= nil
		and PackS16 ~= nil and PackF32 ~= nil
end

-- Quantization matches snapshot/brp.go's storage precision: positions/health
-- to whole units, velocity as displacement per sample interval, build progress
-- 0..255. Rounding is floor(v+0.5) INLINED in the sample loop — a q() helper
-- costs a Lua function call per field, and at ~16 fields x thousands of units
-- that overhead measurably beat the arithmetic itself (Lua 5.1, no JIT).
local function clamp(v, lo, hi)
	if v < lo then return lo end
	if v > hi then return hi end
	return v
end

-- ---------------------------------------------------------------------------
-- Output file. The gameId arrives at game start (see resolveGameID), which may
-- be after Initialize, so every record produced before the file can be opened
-- is buffered and drained the moment it opens. Spring's LuaIO sandbox rejects
-- absolute paths, so the path is relative to the engine write-dir:
-- "<gameId>.brepstream" lands in the data directory (resim mode writes to the
-- Go tool's outputPath instead).

local gameId = nil      -- 32-hex-char game id (nil until it resolves)
local bout = nil        -- output handle
local pendingBin = {}   -- byte-strings buffered before open (nil once open/failed)

-- Config persistence (widget:Get/SetConfigData): BAR's handler saves this on
-- disable/shutdown and hands it back when the widget is re-enabled. The GameID
-- callin fires only once at game start, so a re-enabled widget recovers the id
-- from here (guarded, since the config also survives across games).
local savedConfig = nil
local lastSampledFrame = 0
local gameEnded = false

-- writeRecord appends one framed binary record to the stream.
local function writeRecord(tag, payload)
	if not (bout or pendingBin) then
		return
	end
	local rec = tag .. PackU32({ #payload }) .. payload
	if bout then
		bout:write(rec)
	else
		pendingBin[#pendingBin + 1] = rec
	end
end

local function flushOut()
	if bout then
		bout:flush()
	end
end

-- preambleStr is built at Initialize and written into the stream when it
-- opens (the binary stream keeps a human-readable text head).
local preambleStr = nil

-- normalizeGameID returns the 32-char lowercase hex form of the GameID callin
-- argument. Recoil passes a hex string already; be defensive and hex-encode if
-- an engine ever hands over the 16 raw bytes instead.
local function normalizeGameID(id)
	if type(id) ~= "string" then
		return nil
	end
	if #id == 32 and id:match("^%x+$") then
		return id:lower()
	end
	if #id == 16 then
		return (id:gsub(".", function(c) return string.format("%02x", c:byte()) end))
	end
	return nil
end

-- fallbackGameID names the file when the GameID callin never fired (e.g. the
-- widget was loaded/reloaded mid-game, after the callin). Wall-clock based, so
-- it cannot collide with a real 32-hex id.
local function fallbackGameID()
	local ok, stamp = pcall(os.date, "%Y%m%d_%H%M%S")
	if not ok or type(stamp) ~= "string" then
		stamp = tostring(mathFloor((os.clock() or 0) * 1000))
	end
	return "unknown_" .. stamp
end

-- openOutputs opens the output file and drains the pre-gameId buffer.
--
-- Open mode depends on when in the game this happens. Near frame 0 (game
-- start, or a crashed player REJOINING — the rejoin re-simulates the whole
-- game from the beginning, so the widget re-records everything) any existing
-- <gameId> file is stale or superseded: TRUNCATE. Mid-game (the player
-- re-enabled the widget, or enabled it late) the existing file holds the only
-- copy of the earlier part of the game: APPEND a fresh self-contained segment
-- (header + preamble + records; the decoder treats a "BREPSTREAM 1" line
-- between records as a segment restart). Frames only move forward within a
-- process, so appended segments never overlap the ones before them. A
-- re-simulation is one process from start to end: always truncate.
local function openOutputs(id)
	if gameId then
		return
	end
	gameId = id
	local frame = (spGetGameFrame and spGetGameFrame()) or 0
	local append = not resim and frame > sampleEvery
	local head = "BRSNAP GID " .. id .. "\n" .. (preambleStr or "")
	local path = outputPath or (id .. ".brepstream")
	bout = io.open(path, append and "ab" or "wb")
	if bout then
		bout:write("BREPSTREAM 1\n", head)
		for i = 1, #pendingBin do
			bout:write(pendingBin[i])
		end
		Echo(string.format("%s recording to %s%s (sampling every %d frames, keyframe every %d samples)",
			logTag, path, append and " (appending)" or "", sampleEvery, keyframeEvery))
	else
		Echo(logTag .. " ERROR: could not open " .. path)
	end
	pendingBin = nil
	flushOut()
end

-- ---------------------------------------------------------------------------
-- JSON helpers (unit-def names and map names may contain spaces/quotes/UTF-8).

local function jsonEscape(s)
	s = string.gsub(s, "\\", "\\\\")
	s = string.gsub(s, '"', '\\"')
	s = string.gsub(s, "\n", "\\n")
	s = string.gsub(s, "\r", "\\r")
	s = string.gsub(s, "\t", "\\t")
	return s
end

local function jsonValue(v)
	local t = type(v)
	if t == "string" then
		return '"' .. jsonEscape(v) .. '"'
	elseif t == "boolean" then
		return v and "true" or "false"
	elseif t == "number" then
		if v == mathFloor(v) and math.abs(v) < 1e15 then
			return string.format("%d", v)
		end
		return string.format("%.3f", v)
	end
	return "null"
end

-- jsonObject encodes { {key, value}, ... } pairs in order, skipping nils. A
-- pair with a truthy third element carries a value that is ALREADY JSON
-- (a nested array or object) and is written verbatim.
local function jsonObject(fields)
	local parts = {}
	for _, kv in ipairs(fields) do
		if kv[2] ~= nil then
			parts[#parts + 1] = '"' .. kv[1] .. '":' .. (kv[3] and kv[2] or jsonValue(kv[2]))
		end
	end
	return "{" .. table.concat(parts, ",") .. "}"
end

-- jsonArray encodes a Lua array of scalars.
local function jsonArray(t)
	local parts = {}
	for i = 1, #t do
		parts[i] = jsonValue(t[i])
	end
	return "[" .. table.concat(parts, ",") .. "]"
end

-- customParam reads one of BAR's unit customParams, which are always strings
-- in the def table (techlevel "2", iscommander "1"). Numeric ones come back as
-- numbers, flags as booleans; anything absent is nil (omitted from the JSON).
local function customParam(ud, key, kind)
	local cp = ud.customParams
	local v = cp and cp[key]
	if v == nil or v == "" then
		return nil
	end
	if kind == "number" then
		return tonumber(v)
	elseif kind == "flag" then
		return v ~= "0" and v ~= "false" and v ~= false
	end
	return tostring(v)
end

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
		-- Protocol 4 extras, all from BAR's own data: the tech tier and
		-- unit group (customParams.techlevel / unitgroup — "T2 came at
		-- minute 9", "the army was mostly bots"), whether BAR calls it a
		-- commander (customParams.iscommander, which also covers the
		-- decoys BAR does NOT flag), and the longest weapon range.
		{ "techLevel", customParam(ud, "techlevel", "number") },
		{ "unitGroup", customParam(ud, "unitgroup", "string") },
		{ "isCommander", customParam(ud, "iscommander", "flag") or nil },
		{ "maxWeaponRange", (ud.maxWeaponRange or 0) > 0 and ud.maxWeaponRange or nil },
	})
end

-- ---------------------------------------------------------------------------
-- Visibility. A playing client's Get* calls are LOS-gated: the own ally team
-- is fully readable; enemies flicker in and out of GetAllUnits with wobbled
-- radar positions and nil defIDs (until identified). With recordEnemies the
-- widget records enemies exactly as this client perceives them, sample by
-- sample (see the flag comment above); with it off, a player records ONLY
-- units of their own ally team. A full-view spectator (LOS-free) always
-- records everything.
-- Team->allyteam is static, built once in the preamble.

local allyTeamOf = {} -- teamID -> allyTeam
local myAllyTeam = -1

-- playerIDByName maps a player's ENGINE name to its id. Chat arrives as a
-- console display string naming its speaker (see the comms section below), and
-- this is what turns that name back into the roster entry the stream already
-- carries. Seeded with the preamble, kept current from PlayerAdded/
-- PlayerChanged so a late joiner's messages still resolve.
local playerIDByName = {}

local function notePlayer(playerID)
	local name = spGetPlayerInfo(playerID, false)
	if name and name ~= "" then
		playerIDByName[name] = playerID
	end
end

-- recordAll returns true when every unit GetAllUnits returns is fair game
-- (spectating with full view — also the case after death/resign, so a player
-- who stays to watch keeps contributing, with wider coverage).
local function recordAll()
	local spec, fullView = spGetSpectatingState()
	return spec and fullView
end

-- ---------------------------------------------------------------------------
-- Preamble: capture context + unit defs + teams + players. Built once at
-- Initialize as a string; written into both streams when they open.

local function buildPreamble()
	local parts = {}
	local spec = spGetSpectatingState()
	parts[#parts + 1] = "BRSNAP GAME " .. jsonObject({
		{ "protocol", protocolVersion },
		{ "widgetVersion", widgetVersion },
		{ "widgetDate", widgetDate },
		{ "widgetSha", stampedSha() },
		{ "mode", (Spring.IsReplay and Spring.IsReplay()) and "replay" or "live" },
		{ "map", Game and Game.mapName or nil },
		{ "gameVersion", Game and Game.gameVersion or nil },
		{ "engineVersion", Engine and (Engine.versionFull or Engine.version) or nil },
		{ "sampleEvery", sampleEvery },
		{ "gameSpeed", gameSpeed },
		{ "recordEnemies", recordEnemies },
		{ "playerID", spGetMyPlayerID and spGetMyPlayerID() or nil },
		{ "allyTeam", spGetMyAllyTeamID and spGetMyAllyTeamID() or nil },
		{ "spectator", spec and true or false },
		-- A re-simulation's sampler, not a player's capture: the decoder
		-- then records neither a recorder nor a widget build for it.
		{ "resim", resim or nil },
	})
	for defID, ud in pairs(UnitDefs) do
		parts[#parts + 1] = "BRSNAP DEF " .. defJSON(defID, ud)
	end
	for _, teamID in ipairs(spGetTeamList()) do
		local _, _, _, _, side, allyTeam = spGetTeamInfo(teamID, false)
		allyTeamOf[teamID] = allyTeam or -1
		local r, g, b = spGetTeamColor(teamID)
		local color = "-"
		if r then
			color = string.format("#%02x%02x%02x",
				mathFloor(r * 255 + 0.5), mathFloor(g * 255 + 0.5), mathFloor(b * 255 + 0.5))
		end
		if side == nil or side == "" then
			side = "_"
		end
		parts[#parts + 1] = string.format("BRSNAP T %d %d %s %s", teamID, allyTeam or -1, side, color)
	end
	for _, playerID in ipairs(spGetPlayerList()) do
		local name, _, spectator, teamID = spGetPlayerInfo(playerID, false)
		parts[#parts + 1] = string.format("BRSNAP P %d %d %d %s",
			playerID, teamID or -1, (spectator and 1) or 0, name or "")
		if name and name ~= "" then
			playerIDByName[name] = playerID
		end
	end
	parts[#parts + 1] = "BRSNAP READY"
	return table.concat(parts, "\n") .. "\n"
end

-- ---------------------------------------------------------------------------
-- Delta predictor state for the binary emitter. prev[id] holds the QUANTIZED
-- values the decoder currently has for that unit; the encoder advances it by
-- the exact prediction rule the decoder applies (x += dvx, z += dvz, all other
-- columns carried), so both sides stay in lockstep by construction. p.f marks
-- the sim frame the unit was last seen (dead detection without a second table).
local prev = {}
local sampleIdx = 0 -- samples emitted so far; every keyframeEvery-th is a keyframe

-- Last-known QUANTIZED state of every enemy unit sampled (recordEnemies
-- only): the identity/health fallback for radar-only reads, which return nil
-- for columns the sensors cannot resolve — so an enemy once identified in LOS
-- keeps its def/health across later radar-only contacts instead of degrading
-- to an untyped blip. Purely a read-side cache: a unit absent from
-- GetAllUnits is NOT emitted from here (pre-1.5.0 "ghost" persistence is
-- gone). Entries are removed on a witnessed UnitDestroyed, when the id
-- reappears as a non-enemy unit (the engine reuses unit ids), and wholesale
-- under full view (nothing is LOS-gated there).
local lastKnown = {}

-- Wire team is u8 and 0 is a real team id, so an unknown team must not map to
-- 0 (it would paint the unit as the recording player's). Real ids are 0..254.
local unknownTeam = 255

-- Tombstones for witnessed deaths: buried[unitID] = {x, z, def, team}, the
-- dead unit's last-known fingerprint. Needed because the engine can KEEP
-- RETURNING a dead enemy's id from GetAllUnits — a frozen radar-memory dot
-- (or briefly the corpse) survives a death the player did not see in LOS —
-- which would re-record the dead unit right after UnitDestroyed removed it
-- (observed in a real capture: a morphed enemy commander's dot persisted for
-- thousands of frames past its recorded destroyed event). A tombstoned id is
-- skipped by the sample loop until it is demonstrably a NEW unit reusing the
-- id (see unburied). Memory is bounded by total deaths — trivial.
local buried = {}

-- unburied decides whether a tombstoned id showing up in GetAllUnits is a NEW
-- unit reusing the id (clear the tombstone, record it) or still the dead unit
-- — a frozen radar-memory dot or a unit the engine has killed but not yet
-- deleted (keep skipping it). Tells for a new unit: readable POSITIVE health
-- (alive in LOS), a different def or team than the unit that died, or a
-- position 48+ elmos from where it died (a stale dot sits frozen exactly at
-- the death spot; a new unit spawns elsewhere). Called only for tombstoned
-- ids, so the extra Get* reads are rare. Compares only when both sides are
-- known — nil reads prove nothing.
--
-- Readable health alone is NOT proof of life: UnitDestroyed fires while the
-- unit still exists (the engine deletes it only after its death sequence, and
-- a morph or a scripted DestroyUnit kills it outright at full health), so the very
-- next sample can still read it out of GetAllUnits — with health 0, or even
-- intact. Trusting that read cleared the tombstone and re-recorded the corpse
-- for the rest of the game: a real 8v8 capture ended with 57 dead units still
-- standing at 0 hp. isDead answers it directly where the engine offers it;
-- hp <= 0 covers the rest (a live unit never reads <= 0 — the engine kills it
-- the moment it does, and even a fresh nanoframe starts positive).
local function unburied(unitID, team)
	local tomb = buried[unitID]
	if spGetUnitIsDead ~= nil and spGetUnitIsDead(unitID) then
		return false -- killed, just not deleted yet
	end
	local hp = spGetUnitHealth(unitID)
	if hp == nil or hp <= 0 then
		local defID = spGetUnitDefID(unitID)
		local x, _, z = spGetUnitPosition(unitID)
		local moved = x ~= nil and tomb.x ~= nil
			and (x - tomb.x) * (x - tomb.x) + (z - tomb.z) * (z - tomb.z) >= 2304 -- 48^2
		if not ((defID ~= nil and tomb.def ~= nil and defID ~= tomb.def)
			or (team ~= nil and tomb.team ~= nil and team ~= tomb.team)
			or moved) then
			return false
		end
	end
	buried[unitID] = nil
	return true
end

-- Reusable column buffers for the changed-unit list. Pack* reads the array
-- part [1..n]; n is tracked explicitly and stale tails are never packed
-- because a fresh table is sliced per pack call... instead we pass exact-size
-- tables: buffers are rebuilt each sample (a handful of table allocations, not
-- thousands of strings).

local function packFrameRecord(frame, keyframe, n, cid, cdef, cteam, cx, cz, chp, cmax, cdvx, cdvz, cb, ct, dead, nR, rteam, rcols)
	-- flags bit 1 marks the target column's presence (widget >= 1.4.0); the
	-- decoder reads streams with and without it.
	local parts = {
		PackU32({ frame }),
		PackU8({ 2 + (keyframe and 1 or 0) }),
		PackU16({ n }),
		PackU16({ #dead }),
		PackU8({ nR }),
	}
	if n > 0 then
		parts[#parts + 1] = PackU16(cid)
		parts[#parts + 1] = PackU16(cdef)
		parts[#parts + 1] = PackU8(cteam)
		parts[#parts + 1] = PackS16(cx)
		parts[#parts + 1] = PackS16(cz)
		parts[#parts + 1] = PackU32(chp)
		parts[#parts + 1] = PackU32(cmax)
		parts[#parts + 1] = PackS16(cdvx)
		parts[#parts + 1] = PackS16(cdvz)
		parts[#parts + 1] = PackU8(cb)
		parts[#parts + 1] = PackU16(ct)
	end
	if #dead > 0 then
		parts[#parts + 1] = PackU16(dead)
	end
	if nR > 0 then
		parts[#parts + 1] = PackU8(rteam)
		for i = 1, 6 do
			parts[#parts + 1] = PackF32(rcols[i])
		end
	end
	return table.concat(parts)
end

-- ---------------------------------------------------------------------------
-- Visibility (resim only, recordVisibility): for every unit, at every sample,
-- what each ally team could see of it — in LOS, on radar, both or neither.
-- The re-simulation watches with full view, which is exactly what makes this
-- answerable: Spring.GetUnitLosState(unitID, allyTeam, true) reads the
-- engine's own per-ally-team LOS bits regardless of who is watching.
--
-- Each unit's state is 2 bits per side in the order of visAllies (bit 0 of a
-- pair = in LOS, bit 1 = on radar), up to 16 sides (a 16-way FFA is BAR's
-- largest; sides past 16 are not recorded). It is kept and written as TWO
-- 16-bit halves, sides 0-7 and 8-15, never as one 32-bit number: Spring's
-- Lua numbers are single-precision floats, exact only up to 2^24, so a
-- combined mask past 12 sides would silently lose its low bits. Arithmetic,
-- not bit ops: Spring's Lua 5.1 has none.
--
-- A V record carries only the units whose mask CHANGED since the previous
-- sample (or that are new to the record); a unit's state is otherwise its last
-- one. Keyframe samples restate every unit (flag bit 0), so a decoder that
-- starts at a keyframe — or a segment that does — needs nothing earlier.
-- Units that left the game simply stop appearing; frames say when.

local visAllies = nil   -- ally team ids, in mask order (built lazily)
local visPrev = {}      -- unitID -> { lo, hi = last mask halves, f = last sampled frame }

local function buildVisAllies()
	visAllies = {}
	local gaiaAlly = nil
	if spGetGaiaTeamID then
		local gaia = spGetGaiaTeamID()
		gaiaAlly = gaia and allyTeamOf[gaia]
	end
	local list = spGetAllyTeamList and spGetAllyTeamList() or {}
	for i = 1, #list do
		-- Gaia's "side" is nobody's point of view.
		if list[i] ~= gaiaAlly and #visAllies < 16 then
			visAllies[#visAllies + 1] = list[i]
		end
	end
end

local function losMask(unitID)
	local lo, hi, scale = 0, 0, 1
	for i = 1, #visAllies do
		local bits = spGetUnitLosState(unitID, visAllies[i], true)
		if type(bits) == "number" then
			if i <= 8 then
				lo = lo + (bits % 4) * scale
			else
				hi = hi + (bits % 4) * scale
			end
		end
		scale = (i == 8) and 1 or scale * 4
	end
	return lo, hi
end

-- ---------------------------------------------------------------------------
-- Sampling. The body is pcall-guarded from widget:GameFrame; after a few
-- consecutive failures the widget closes its file and removes itself rather
-- than risk degrading a live game.

local lastSampleTime = nil
local lastUnitCount = 0

local function sample(frame)
	local t0 = startClock()
	local all = recordAll()
	local units = spGetAllUnits()
	local total = #units

	local keyframe = (sampleIdx % keyframeEvery == 0)
	sampleIdx = sampleIdx + 1
	if keyframe then
		prev = {} -- decoder state resets at a keyframe; mirror it
	end

	-- Under full view nothing is LOS-gated, so the read-side fallback cache
	-- has no purpose (and a stale entry could linger from before a mid-game
	-- switch to full view — a death/resign): drop it wholesale.
	if all and next(lastKnown) ~= nil then
		lastKnown = {}
	end

	local n = 0
	local cid, cdef, cteam, cx, cz, chp, cmax, cdvx, cdvz, cb, ct =
		{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}
	local recorded = 0

	local doVis = recordVisibility and spGetUnitLosState ~= nil
	local nv, vid, vlo, vhi = 0, {}, {}, {}
	if doVis and visAllies == nil then
		buildVisAllies()
	end

	for i = 1, total do
		local unitID = units[i]
		local team = spGetUnitTeam(unitID)
		local isAlly = (team ~= nil and allyTeamOf[team] == myAllyTeam)
		if (all or isAlly or recordEnemies)
			and (buried[unitID] == nil or unburied(unitID, team)) then
			local isEnemy = recordEnemies and not all and not isAlly
			local g = isEnemy and lastKnown[unitID] or nil
			local x, y, z = spGetUnitPosition(unitID)
			local defID = spGetUnitDefID(unitID)
			local hp, maxHp, _, _, buildProgress = spGetUnitHealth(unitID)
			if hp ~= nil and hp <= 0 and not resim then
				-- Readable but dead: the engine still holds a killed unit for its
				-- death sequence. Bury it here rather than waiting for the
				-- UnitDestroyed callin — which may already have fired (the sample
				-- lands inside the death window) or may never fire at all (the
				-- widget was reloaded across it). The stale prev entry puts the
				-- id on this frame's dead list. See unburied above.
				--
				-- A re-simulation RECORDS such a unit instead: it sees the
				-- whole game, so a unit at 0 hp is a real thing on the field
				-- (a crashing aircraft still does damage where it lands), and
				-- the viewer draws it grey. The decoder's graveyard drops it
				-- once its destroyed event is in the stream.
				buried[unitID] = { x = x, z = z, def = defID, team = team }
				lastKnown[unitID] = nil
			else
				local vx, vy, vz = spGetUnitVelocity(unitID)
				-- Build/assist/repair target (nil for non-builders, idle
				-- builders, and units the widget cannot read).
				local tgt = spGetUnitIsBuilding ~= nil and spGetUnitIsBuilding(unitID) or nil
				recorded = recorded + 1
				-- Radar-only enemies read back nils (def/health unreadable, the
				-- position wobbled): carry the last-known identity/health from
				-- the cache so a typed unit does not degrade to an untyped blip.
				local edef = defID or (g and g.def) or 0
				local eteam = team or (g and g.team) or (isEnemy and unknownTeam or 0)
				local ehp, emaxHp, ebuild
				if hp == nil and g ~= nil then
					ehp, emaxHp, ebuild = g.hp, g.maxhp, g.b / 255
				else
					ehp, emaxHp, ebuild = hp or 0, maxHp or 0, buildProgress or 1
				end
				if not isEnemy and recordEnemies and lastKnown[unitID] ~= nil then
					lastKnown[unitID] = nil -- the engine reused the id for a non-enemy unit
				end
				-- All quantization inlined: function calls dominate this loop's
				-- cost on Lua 5.1 (measured ~2x). floor(v+0.5) is fine for the
				-- occasional slightly-negative off-map coordinate too.
				local qx = mathFloor((x or 0) + 0.5)
				if qx > 32767 then qx = 32767 elseif qx < -32768 then qx = -32768 end
				local qz = mathFloor((z or 0) + 0.5)
				if qz > 32767 then qz = 32767 elseif qz < -32768 then qz = -32768 end
				local qhp = mathFloor(ehp + 0.5)
				if qhp < 0 then qhp = 0 end
				local qmax = mathFloor(emaxHp + 0.5)
				if qmax < 0 then qmax = 0 end
				local qdvx = mathFloor((vx or 0) * sampleEvery + 0.5)
				if qdvx > 32767 then qdvx = 32767 elseif qdvx < -32768 then qdvx = -32768 end
				local qdvz = mathFloor((vz or 0) * sampleEvery + 0.5)
				if qdvz > 32767 then qdvz = 32767 elseif qdvz < -32768 then qdvz = -32768 end
				local qb = mathFloor(ebuild * 255 + 0.5)
				if qb > 255 then qb = 255 elseif qb < 0 then qb = 0 end
				local qdef = edef
				if qdef > 65535 or qdef < 0 then qdef = 0 end
				local qteam = eteam
				if qteam > 255 or qteam < 0 then qteam = unknownTeam end
				local qt = tgt or 0
				if qt > 65535 or qt < 0 then qt = 0 end
				if isEnemy then
					if g == nil then
						g = {}
						lastKnown[unitID] = g
					end
					-- x/z feed the UnitDestroyed tombstone fingerprint.
					g.x, g.z, g.hp, g.maxhp = qx, qz, qhp, qmax
					g.def, g.team, g.b = qdef, qteam, qb
				end
				local p = prev[unitID]
				if p ~= nil and not keyframe
					and p.dvx == qdvx and p.dvz == qdvz
					and p.x + qdvx == qx and p.z + qdvz == qz
					and p.hp == qhp and p.maxhp == qmax and p.b == qb
					and p.def == qdef and p.team == qteam and p.t == qt then
					-- Fully predicted: costs zero bytes. Advance to what the
					-- decoder will compute.
					p.x, p.z, p.f = qx, qz, frame
				else
					n = n + 1
					cid[n], cdef[n], cteam[n] = unitID, qdef, qteam
					cx[n], cz[n], chp[n], cmax[n] = qx, qz, qhp, qmax
					cdvx[n], cdvz[n], cb[n], ct[n] = qdvx, qdvz, qb, qt
					if p == nil then
						prev[unitID] = { x = qx, z = qz, dvx = qdvx, dvz = qdvz,
							hp = qhp, maxhp = qmax, def = qdef, team = qteam, b = qb, t = qt, f = frame }
					else
						p.x, p.z, p.dvx, p.dvz = qx, qz, qdvx, qdvz
						p.hp, p.maxhp, p.def, p.team, p.b, p.t, p.f = qhp, qmax, qdef, qteam, qb, qt, frame
					end
				end
				if doVis and unitID <= 65535 then
					local lo, hi = losMask(unitID)
					local v = visPrev[unitID]
					if v == nil then
						visPrev[unitID] = { lo = lo, hi = hi, f = frame }
						nv = nv + 1
						vid[nv], vlo[nv], vhi[nv] = unitID, lo, hi
					else
						if keyframe or v.lo ~= lo or v.hi ~= hi then
							nv = nv + 1
							vid[nv], vlo[nv], vhi[nv] = unitID, lo, hi
						end
						v.lo, v.hi, v.f = lo, hi, frame
					end
				end
			end
		end
	end

	-- No persistence for the unlisted: an enemy absent from GetAllUnits this
	-- sample (no LOS, no radar signature, no engine memory dot) is simply not
	-- recorded — its stale prev entry puts the id on this frame's dead list
	-- below, so it leaves the stream without a destroyed event (it may well be
	-- alive in fog; if re-spotted it is recorded afresh under the same id).
	lastUnitCount = recorded

	-- Dead list: every predictor entry not seen this sample. (After a keyframe
	-- reset there are no stale entries by construction.)
	local dead = {}
	if not keyframe then
		for id, p in pairs(prev) do
			if p.f ~= frame then
				dead[#dead + 1] = id
				prev[id] = nil
			end
		end
	end

	-- Economy: readable only for the player's own ally team (all teams when
	-- spectating full view) — GetTeamResources returns nil for the rest.
	-- The income return is already per game-second (the engine accumulates it
	-- over TEAM_SLOWUPDATE_RATE = 30 sim frames), so it is written as-is.
	local nR = 0
	local rteam = {}
	local rcols = { {}, {}, {}, {}, {}, {} } -- metal, energy, mStore, eStore, mInc, eInc
	for _, teamID in ipairs(spGetTeamList()) do
		local m, mStore, _, mInc = spGetTeamResources(teamID, "metal")
		if m ~= nil then
			local e, eStore, _, eInc = spGetTeamResources(teamID, "energy")
			nR = nR + 1
			rteam[nR] = clamp(teamID, 0, 255)
			rcols[1][nR], rcols[2][nR] = m or 0, e or 0
			rcols[3][nR], rcols[4][nR] = mStore or 0, eStore or 0
			rcols[5][nR], rcols[6][nR] = mInc or 0, eInc or 0
		end
	end

	writeRecord("F", packFrameRecord(frame, keyframe, n,
		cid, cdef, cteam, cx, cz, chp, cmax, cdvx, cdvz, cb, ct, dead, nR, rteam, rcols))

	if doVis then
		-- Forget units that left, so a recycled id is recorded afresh.
		-- (A sample where nothing changed writes no record at all.)
		for id, v in pairs(visPrev) do
			if v.f ~= frame then
				visPrev[id] = nil
			end
		end
	end
	if doVis and (nv > 0 or keyframe) then
		local ally = {}
		for k = 1, #visAllies do
			ally[k] = clamp(visAllies[k], 0, 255)
		end
		local parts = {
			PackU32({ frame }),
			PackU8({ keyframe and 1 or 0 }),
			PackU8({ #visAllies }),
		}
		if #visAllies > 0 then
			parts[#parts + 1] = PackU8(ally)
		end
		parts[#parts + 1] = PackU16({ nv })
		if nv > 0 then
			parts[#parts + 1] = PackU16(vid)
			parts[#parts + 1] = PackU16(vlo)
			parts[#parts + 1] = PackU16(vhi)
		end
		writeRecord("V", table.concat(parts))
	end

	flushOut() -- durable if the game/engine dies mid-match
	lastSampledFrame = frame
	lastSampleTime = elapsedStr(t0)
end

local function closeOut(reason)
	-- Samples were buffered but no id ever resolved and the grace period had
	-- not expired (e.g. the player quit early): save them under a fallback
	-- name rather than dropping them.
	if not gameId and pendingBin and #pendingBin > 0 then
		openOutputs(fallbackGameID())
	end
	if reason and bout then
		writeRecord("X", reason)
	end
	if bout then
		bout:flush()
		bout:close()
		bout = nil
	end
	pendingBin = nil
end

local sampleFailures = 0

local function removeSelf()
	closeOut("error")
	if widgetHandler and widgetHandler.RemoveWidget then
		widgetHandler:RemoveWidget(widget)
	end
end

-- ---------------------------------------------------------------------------
-- Game facts (G records, protocol >= 4): the things a game summary needs that
-- no sample can show — how and when the game ENDED and who won, which teams
-- died when, which players left, the weapon table the cause columns refer
-- to, and the engine's own running team statistics. One JSON object per
-- record, "k" naming the kind:
--
--   {"k":"end","f":<frame>,"winners":[<allyTeam>...]}
--   {"k":"teamdied","f":<frame>,"team":<teamID>}
--   {"k":"playerleft","f":<frame>,"player":<playerID>,"reason":<n>}
--   {"k":"wdefs","defs":[{"id":..,"name":..,...}...]}            (resim)
--   {"k":"teamstats","team":<teamID>,"fields":[...],"rows":[[...]...]}  (resim)
--
-- Small and rare, so JSON; the decoder keeps every kind it does not know
-- verbatim, so a fact can be added without touching it.

local function writeFact(fields)
	writeRecord("G", jsonObject(fields))
end

local function factFrame()
	local f = spGetGameFrame()
	if not f or f < 0 then
		return 0
	end
	return f
end

-- weaponDefsJSON is the weapon table the cause columns (a kill's weapon, a
-- damage window's weapon) index into. Weapon ids are per game build, like
-- unit-def ids, so the table has to travel with the capture.
local function weaponDefsJSON()
	local defs = {}
	for id, wd in pairs(WeaponDefs or {}) do
		local dmg = wd.damages and (wd.damages[0] or wd.damages[1]) or nil
		defs[#defs + 1] = jsonObject({
			{ "id", id },
			{ "name", wd.name },
			{ "description", (wd.description ~= nil and wd.description ~= "") and wd.description or nil },
			{ "type", wd.type },
			{ "range", wd.range },
			{ "reload", wd.reload },
			{ "damage", type(dmg) == "number" and dmg or nil },
			{ "paralyzer", wd.paralyzer or nil },
		})
	end
	return "[" .. table.concat(defs, ",") .. "]"
end

-- Team statistics fields, in row order. These are the engine's own running
-- totals (CTeam::statHistory, sampled every statsFrames by the sim itself) —
-- the numbers BAR's end-of-game graphs draw. A demo does not carry them; the
-- re-simulation recomputes them, and this is where they are read out.
local teamStatFields = {
	"frame", "metalUsed", "metalProduced", "metalExcess", "metalReceived", "metalSent",
	"energyUsed", "energyProduced", "energyExcess", "energyReceived", "energySent",
	"damageDealt", "damageReceived", "unitsProduced", "unitsDied", "unitsReceived",
	"unitsSent", "unitsCaptured", "unitsOutCaptured", "unitsKilled",
}

local function writeTeamStats()
	if not spGetTeamStatsHistory then
		return
	end
	for _, teamID in ipairs(spGetTeamList()) do
		local count = spGetTeamStatsHistory(teamID)
		if type(count) == "number" and count > 0 then
			local hist = spGetTeamStatsHistory(teamID, 0, count)
			if type(hist) == "table" then
				local rows = {}
				for i = 1, #hist do
					local h, row = hist[i], {}
					for k = 1, #teamStatFields do
						row[k] = h[teamStatFields[k]] or 0
					end
					rows[#rows + 1] = jsonArray(row)
				end
				writeFact({
					{ "k", "teamstats" },
					{ "team", teamID },
					{ "fields", jsonArray(teamStatFields), true },
					{ "rows", "[" .. table.concat(rows, ",") .. "]", true },
				})
			end
		end
	end
end

-- ---------------------------------------------------------------------------
-- Damage (resim only, recordDamage). Every UnitDamaged callin is folded into
-- the current one-second WINDOW (sampleEvery frames), keyed by who hit whom
-- with what: attacker team, attacker def, weapon, victim team, victim def.
-- No single hit is ever written — a big fight is thousands of hits a second.
-- At the next sample the window is written as one D record:
--
--   frame u32 (the sample the window opened at: it holds the damage dealt
--   from that sample up to the next one, sim frames frame..frame+sampleEvery-1)
--   n u16, then columns of n: aTeam u8, aDef u16, weapon u16, vTeam u8,
--   vDef u16, damage f32, paralyze f32, hits u16, overkill f32
--
-- 255 / 65535 mean unknown (no attacker — e.g. a crash or self-destruct —
-- or a weapon the engine did not name). damage excludes paralyzer damage,
-- which is its own column. overkill is the part of a killing blow past the
-- health the victim had left (read as the victim's health going below zero
-- after the hit), so damage - overkill is what actually came off health.
--
-- Per-unit LIFETIME totals ride along as S records, one row per unit life,
-- written when the unit dies (in the window record's sample) and, for the
-- survivors, at game end:
--
--   frame u32, n u16, then columns of n: id u16, def u16, team u8,
--   born u32, died u32 (0xFFFFFF = alive at the end), dealt f32,
--   taken f32, kills u16, minHp u8 (lowest health seen, % of max), xp f32
--
-- A life, not an id, because the engine recycles unit ids.

local dmgStart = 0      -- first frame of the open window
local dmgA = {}         -- aKey -> weapon -> vKey -> row (see onDamaged)
local dmgRows = 0
local lives = {}        -- unitID -> life totals of the unit holding the id now
-- The "died" of a unit alive when the game ended. Not 0xFFFFFFFF: a Spring
-- Lua number is a single-precision float, 0xFFFFFFFF rounds to 2^32, and
-- VFS.PackU32 wrapped that to 0 — every survivor read as dead at frame 0.
-- 0xFFFFFF is exact, and no game runs 155 hours.
local aliveAtEnd = 16777215
local diedLives = {}    -- lives ended since the last S record

local function lifeOf(unitID, defID, team)
	local l = lives[unitID]
	if l == nil then
		l = { def = defID or 0, team = team or unknownTeam, born = factFrame(),
			dealt = 0, taken = 0, kills = 0, minFrac = 1 }
		lives[unitID] = l
	end
	return l
end

-- How many hits arrived, and how many of them named an attacker and a
-- weapon: logged at game end, because whether the engine hands a widget the
-- attacker of a hit is exactly what a capture cannot show on its own (an
-- all-unknown damage section looks the same as a game of crashes).
local dmgSeen, dmgNamedAttacker, dmgNamedWeapon = 0, 0, 0

local function onDamaged(unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, attackerID, attackerDefID, attackerTeam)
	if type(damage) ~= "number" or damage <= 0 then
		return
	end
	dmgSeen = dmgSeen + 1
	if attackerTeam ~= nil then dmgNamedAttacker = dmgNamedAttacker + 1 end
	if weaponDefID ~= nil and weaponDefID >= 0 then dmgNamedWeapon = dmgNamedWeapon + 1 end
	local aTeam = (attackerTeam ~= nil and attackerTeam >= 0 and attackerTeam <= 254) and attackerTeam or 255
	local aDef = (attackerDefID ~= nil and attackerDefID >= 0 and attackerDefID < 65535) and attackerDefID or 65535
	local wpn = (weaponDefID ~= nil and weaponDefID >= 0 and weaponDefID < 65535) and weaponDefID or 65535
	local vTeam = (unitTeam ~= nil and unitTeam >= 0 and unitTeam <= 254) and unitTeam or 255
	local vDef = (unitDefID ~= nil and unitDefID >= 0 and unitDefID < 65535) and unitDefID or 65535
	-- Each key stays under 2^24, the largest integer a single-precision
	-- Lua number holds exactly (see losMask): attacker, then weapon, then
	-- victim. One combined key once rounded every unknown attacker to the
	-- same wrong (team 0, def 0, weapon 0) row.
	local ak = aTeam * 65536 + aDef
	local vk = vTeam * 65536 + vDef
	local byW = dmgA[ak]
	if byW == nil then
		byW = {}
		dmgA[ak] = byW
	end
	local byV = byW[wpn]
	if byV == nil then
		byV = {}
		byW[wpn] = byV
	end
	local row = byV[vk]
	if row == nil then
		row = { 0, 0, 0, 0 } -- damage, paralyze, hits, overkill
		byV[vk] = row
		dmgRows = dmgRows + 1
	end
	row[3] = row[3] + 1
	if paralyzer then
		row[2] = row[2] + damage
		return
	end
	row[1] = row[1] + damage
	local hp, maxHp = spGetUnitHealth(unitID)
	if hp ~= nil and hp < 0 then
		row[4] = row[4] + math.min(damage, -hp)
	end
	local victim = lifeOf(unitID, unitDefID, unitTeam)
	victim.taken = victim.taken + damage
	if hp ~= nil and maxHp ~= nil and maxHp > 0 then
		local frac = hp / maxHp
		if frac < victim.minFrac then
			victim.minFrac = frac < 0 and 0 or frac
		end
	end
	if attackerID ~= nil and attackerID ~= unitID then
		local a = lifeOf(attackerID, attackerDefID, attackerTeam)
		a.dealt = a.dealt + damage
	end
end

local function lifeRow(cols, unitID, l, died)
	local k = #cols.id + 1
	cols.id[k] = clamp(unitID, 0, 65535)
	cols.def[k] = clamp(l.def, 0, 65535)
	cols.team[k] = clamp(l.team, 0, 255)
	cols.born[k] = l.born
	cols.died[k] = died
	cols.dealt[k] = l.dealt
	cols.taken[k] = l.taken
	cols.kills[k] = clamp(l.kills, 0, 65535)
	cols.minHp[k] = mathFloor(l.minFrac * 100 + 0.5)
	cols.xp[k] = l.xp or 0
end

local function writeLives(frame, rows)
	if #rows == 0 then
		return
	end
	local cols = { id = {}, def = {}, team = {}, born = {}, died = {}, dealt = {},
		taken = {}, kills = {}, minHp = {}, xp = {} }
	for i = 1, #rows do
		local r = rows[i]
		lifeRow(cols, r[1], r[2], r[3])
	end
	writeRecord("S", table.concat({
		PackU32({ frame }), PackU16({ #rows }),
		PackU16(cols.id), PackU16(cols.def), PackU8(cols.team),
		PackU32(cols.born), PackU32(cols.died),
		PackF32(cols.dealt), PackF32(cols.taken),
		PackU16(cols.kills), PackU8(cols.minHp), PackF32(cols.xp),
	}))
end

-- flushDamage writes the open window (if anything happened in it) and the
-- lives that ended in it, then opens the next window at frame.
local function flushDamage(frame)
	if frame <= dmgStart and frame > 0 then
		return -- no sim frame since the window opened; keep it open
	end
	if frame == 0 then
		dmgStart = 0 -- the first sample: anything before it joins window 0
		return
	end
	if dmgRows > 0 then
		local at, ad, aw, vt, vd = {}, {}, {}, {}, {}
		local dd, dp, dh, dk = {}, {}, {}, {}
		local n = 0
		local full = false
		for ak, byW in pairs(dmgA) do
			local aTeam, aDef = mathFloor(ak / 65536), ak % 65536
			for wpn, byV in pairs(byW) do
				for vk, row in pairs(byV) do
					n = n + 1
					at[n], ad[n], aw[n] = aTeam, aDef, wpn
					vt[n], vd[n] = mathFloor(vk / 65536), vk % 65536
					dd[n], dp[n], dh[n], dk[n] = row[1], row[2], clamp(row[3], 0, 65535), row[4]
					if n >= 65535 then
						full = true
						break
					end
				end
				if full then break end
			end
			if full then break end
		end
		writeRecord("D", table.concat({
			PackU32({ dmgStart }), PackU16({ n }),
			PackU8(at), PackU16(ad), PackU16(aw), PackU8(vt), PackU16(vd),
			PackF32(dd), PackF32(dp), PackU16(dh), PackF32(dk),
		}))
	end
	dmgA, dmgRows = {}, 0
	if #diedLives > 0 then
		writeLives(frame, diedLives)
		diedLives = {}
	end
	dmgStart = frame
end

-- ---------------------------------------------------------------------------
-- Profiling (resim only). The engine keeps an internal time profiler (the
-- /debug overlay data): named scopes like "Sim", "Sim::Path", "Lua" with
-- accumulated wall time. Scopes nest ("Sim::Path" time is also inside "Sim"),
-- so totals overlap and do not sum to wall time — read them as relative
-- weights. Readings go into the stream as P records,
--
--   {"f":<frame>,"u":<units>,"final":true|nil,"r":[["<scope>",<ms>]...]}
--
-- one at game over with the largest 80 scopes (final), and in -profile mode
-- one per heartbeat with the largest 30 — the Go tool turns consecutive ones
-- into per-scope growth with unit count.

local spGetProfilerRecordNames = Spring.GetProfilerRecordNames
local spGetProfilerTimeRecord  = Spring.GetProfilerTimeRecord

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

-- profilerTotals is the safe wrapper: profiling is auxiliary, and an error
-- escaping a callin makes BAR's widget handler unload the whole widget. On
-- the first failure it reports the error and disables further attempts.
local profilerBroken = false
local function profilerTotals()
	if not resim or profilerBroken or not (spGetProfilerRecordNames and spGetProfilerTimeRecord) then
		return nil
	end
	local ok, recs = pcall(collectProfilerTotals)
	if not ok then
		profilerBroken = true
		Echo(logTag .. " engine time profiler failed (" .. tostring(recs) .. "); disabling prof output")
		return nil
	end
	return recs
end

local function writeProfile(recs, limit, frame, units, final)
	local parts = {}
	for i = 1, math.min(limit, #recs) do
		parts[i] = "[" .. jsonValue(recs[i].name) .. "," .. string.format("%.1f", recs[i].ms) .. "]"
	end
	writeRecord("P", jsonObject({
		{ "f", frame }, { "u", units }, { "final", final or nil },
		{ "r", "[" .. table.concat(parts, ",") .. "]", true },
	}))
end

-- ---------------------------------------------------------------------------
-- Re-simulation housekeeping: run as fast as possible, see the whole map,
-- turn off the widgets nobody is watching.

-- Target playback speed. setminspeed forces the sim up to this multiplier so
-- the replay fast-forwards instead of running realtime; the engine clamps to
-- its own ceiling and otherwise runs as fast as the CPU allows.
local playbackSpeed = 1000

local function forceMaxSpeed()
	Spring.SendCommands("setmaxspeed " .. playbackSpeed)
	Spring.SendCommands("setminspeed " .. playbackSpeed)
end

-- Draw-frame counter: widget:Update fires once per draw frame, so the
-- per-heartbeat delta is the engine's real draw rate — the check on whether
-- -throttle-draw is holding. Only defined in resim mode (see the callins).
local drawFrames = 0
local lastDrawFrames = 0

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
		Echo(logTag .. " widget handler API unavailable; leaving default widgets enabled")
		return
	end
	local me = widget:GetInfo().name
	local n = 0
	for name, ki in pairs(wh.knownWidgets) do
		if ki.active and name ~= me then
			wh:DisableWidget(name)
			n = n + 1
		end
	end
	Echo(string.format("%s disabling %d default widgets (unsynced overhead only)", logTag, n))
end

-- ---------------------------------------------------------------------------
-- Callins.

function widget:Initialize()
	myAllyTeam = (spGetMyAllyTeamID and spGetMyAllyTeamID()) or -1
	if not detectPack() then
		Echo(logTag .. " VFS.Pack* unavailable; cannot record, removing widget")
		pendingBin = nil
		if widgetHandler and widgetHandler.RemoveWidget then
			widgetHandler:RemoveWidget(widget)
		end
		return
	end
	if resim then
		-- Run as fast as possible and see the whole map (spectator full
		-- view), so GetAllUnits returns every unit regardless of LOS.
		forceMaxSpeed()
		Spring.SendCommands("spectatorfullview 1")
		if profileMode then
			-- "debug <drawDebug> <draw4Real>": arg 1 enables CTimeProfiler
			-- collection (unlocking the non-"special" scopes like
			-- Sim::Unit::*), arg 2 keeps the overlay off — nothing to draw.
			Spring.SendCommands("debug 1 0")
			Echo(logTag .. " profile mode: engine time profiler enabled (debug 1 0)")
		end
	end
	local ok, err = pcall(function() preambleStr = buildPreamble() end)
	if not ok then
		Echo(logTag .. " preamble failed (" .. tostring(err) .. "); removing widget")
		removeSelf()
		return
	end
	if resim then
		local wok, werr = pcall(function()
			writeFact({ { "k", "wdefs" }, { "defs", weaponDefsJSON(), true } })
		end)
		if not wok then
			Echo(logTag .. " weapon table failed (" .. tostring(werr) .. "); continuing without it")
		end
	end
	Echo(logTag .. " v" .. widgetVersion ..
		" (" .. widgetDate .. (stampedSha() and " " .. widgetSha:sub(1, 8) or " unstamped") .. ") loaded" ..
		(resim and string.format(" in re-simulation mode (damage %s, visibility %s, speed %d)",
			recordDamage and "on" or "off", recordVisibility and "on" or "off", playbackSpeed) or "") ..
		"; waiting for gameId")
end

function widget:GameID(id)
	local hex = normalizeGameID(id)
	if hex then
		openOutputs(hex)
	else
		Echo(logTag .. " unrecognized GameID value; using fallback file name")
		openOutputs(fallbackGameID())
	end
end

-- configGameID recovers the gameId when the GameID callin was missed: the
-- widget was disabled and re-enabled (or /luaui reloaded) mid-game, and the
-- handler restored the config saved at disable time. The config outlives the
-- game, so reuse is guarded: same map + game version, and the current frame
-- must be past the last frame the previous instance sampled (a later game on
-- the same map starts at frame 0 and is rejected). A same-map game that runs
-- longer than the saved one AND reloads late can still mis-match — accepted,
-- the window is narrow and the alternative is losing the id on every
-- re-enable.
local function configGameID(frame)
	local sc = savedConfig
	if sc and type(sc.gameId) == "string" and type(sc.frame) == "number"
		and frame > sc.frame
		and sc.map == (Game and Game.mapName)
		and sc.gameVersion == (Game and Game.gameVersion) then
		return sc.gameId
	end
	return nil
end

function widget:GetConfigData()
	if gameEnded then
		return {} -- a finished game must never be resumed into
	end
	return {
		gameId = gameId,
		frame = lastSampledFrame,
		map = Game and Game.mapName or nil,
		gameVersion = Game and Game.gameVersion or nil,
	}
end

function widget:SetConfigData(data)
	if type(data) == "table" then
		savedConfig = data
	end
end

-- resolveGameID tries every source for the 32-hex game id, most reliable
-- first. BAR's widget handler (barwidgets.lua) does NOT forward the engine's
-- GameID callin to widgets — only the gadget handler gets it — so the primary
-- source is the rules param BAR's game_id.lua gadget publishes at game start
-- ("Exposes GameID as a rules param for luaui reload"); Game.gameID is the
-- community's future-proofing alias for it. The widget:GameID callin below
-- still works under handlers that do forward it, and the config fallback
-- covers a re-enable when neither is available.
local function resolveGameID(frame)
	local id = normalizeGameID(Game and Game.gameID or nil)
	if id then
		return id
	end
	if spGetGameRulesParam then
		id = normalizeGameID(spGetGameRulesParam("GameID"))
		if id then
			return id
		end
	end
	return configGameID(frame)
end

-- Samples recorded into the pre-open buffers while the game id is still
-- unresolved; after this many, give up and open under a wall-clock name (the
-- rules param appears within the first frames on BAR — this only triggers on
-- games without the game_id gadget).
local fallbackAfterSamples = 10
local unresolvedSamples = 0

local function heartbeat(frame)
	local line = string.format("%s heartbeat frame=%d t=%.0fs units=%d",
		logTag, frame, spGetGameSeconds(), lastUnitCount)
	if resim then
		-- Re-assert speed in case demo playback reset it.
		forceMaxSpeed()
		line = line .. string.format(" draws=%d widgets=%s", drawFrames - lastDrawFrames, activeWidgetCount())
		lastDrawFrames = drawFrames
	end
	if lastSampleTime then
		line = line .. " sample_time=" .. lastSampleTime
	end
	Echo(line)
	-- Top profiler scopes so far (infolog only): shows whether the frame cost
	-- drifts (e.g. Sim growing with unit count) as the replay progresses.
	local recs = profilerTotals()
	if recs and recs[1] then
		local parts = {}
		for i = 1, math.min(8, #recs) do
			parts[i] = string.format("%s=%.0fms", recs[i].name, recs[i].ms)
		end
		Echo(logTag .. " prof " .. table.concat(parts, " "))
		if profileMode then
			writeProfile(recs, 30, frame, lastUnitCount, false)
		end
	end
end

function widget:GameFrame(frame)
	if disableWidgets and not widgetsDisabled then
		local ok, err = pcall(disableOtherWidgets)
		if not ok then
			Echo(logTag .. " disabling widgets failed (" .. tostring(err) .. "); continuing")
		end
	end
	-- The gameId is usually not known at Initialize (the GameID callin fires
	-- ~game start, the rules param appears just after). Sampling starts
	-- immediately into the pre-open buffers; the file opens the moment a
	-- source resolves, and only after a grace period under a fallback name.
	if not gameId then
		local id = resolveGameID(frame)
		if id then
			openOutputs(id)
		elseif unresolvedSamples >= fallbackAfterSamples then
			Echo(logTag .. " no game id after " .. unresolvedSamples .. " samples; using fallback file name")
			openOutputs(fallbackGameID())
		elseif frame % sampleEvery == 0 then
			unresolvedSamples = unresolvedSamples + 1
		end
	end
	if frame % sampleEvery == 0 then
		-- The damage window closes at the sample boundary, before the sample:
		-- everything since the last one happened before this frame's sim.
		if recordDamage then
			local ok, err = pcall(flushDamage, frame)
			if not ok then
				Echo(logTag .. " damage flush failed (" .. tostring(err) .. ")")
				dmgA, dmgRows, diedLives, dmgStart = {}, 0, {}, frame
			end
		end
		local ok, err = pcall(sample, frame)
		if ok then
			sampleFailures = 0
		else
			sampleFailures = sampleFailures + 1
			Echo(logTag .. " sample failed (" .. tostring(err) .. ")")
			if sampleFailures >= 3 then
				Echo(logTag .. " 3 consecutive failures; disabling")
				removeSelf()
				return
			end
		end
	end
	if frame % heartbeatEvery == 0 then
		pcall(heartbeat, frame)
	end
end

-- Lifecycle events. The engine only fires these callins for units this client
-- can see, so with recordEnemies on no extra filtering is needed.
--
-- Payload: "<frame> <kind> <id> <def> <team>", plus — protocol >= 4 — the
-- CAUSE columns "<aID> <aDef> <aTeam> <weapon>" (-1 = unknown) when there is
-- one: for "destroyed" the killer (unit, its def and team) and the weapon
-- that dealt the blow; for "given" (a unit changing hands — shared, captured,
-- or a resigned player's units handed to an ally) aTeam is the team it came
-- FROM and the event's team the one it went to.
local function event(kind, unitID, defID, team, aID, aDef, aTeam, weapon)
	if not (recordAll() or recordEnemies or (team ~= nil and allyTeamOf[team] == myAllyTeam)) then
		return
	end
	local frame = spGetGameFrame()
	local payload = string.format("%d %s %d %d %d", frame, kind, unitID, defID or -1, team or -1)
	if aID ~= nil or aDef ~= nil or aTeam ~= nil or weapon ~= nil then
		payload = payload .. string.format(" %d %d %d %d", aID or -1, aDef or -1, aTeam or -1, weapon or -1)
	end
	writeRecord("E", payload)
end

function widget:UnitCreated(unitID, unitDefID, unitTeam)
	buried[unitID] = nil -- a new unit definitely owns this recycled id now
	if recordDamage then
		lives[unitID] = nil
		pcall(lifeOf, unitID, unitDefID, unitTeam)
	end
	pcall(event, "created", unitID, unitDefID, unitTeam)
end

function widget:UnitFinished(unitID, unitDefID, unitTeam)
	pcall(event, "finished", unitID, unitDefID, unitTeam)
end

local function onDestroyed(unitID, unitDefID, unitTeam, attackerID, attackerDefID, attackerTeam)
	local l = lifeOf(unitID, unitDefID, unitTeam)
	l.team = unitTeam or l.team
	if spGetUnitExperience then
		l.xp = spGetUnitExperience(unitID)
	end
	diedLives[#diedLives + 1] = { unitID, l, factFrame() }
	lives[unitID] = nil
	if attackerID ~= nil and attackerID ~= unitID then
		local a = lifeOf(attackerID, attackerDefID, attackerTeam)
		a.kills = a.kills + 1
	end
end

-- The attacker arguments are what the engine hands an unsynced handle with
-- full read access — a full-view spectator, i.e. a re-simulation; a playing
-- client gets nils, and nils are recorded as "unknown".
function widget:UnitDestroyed(unitID, unitDefID, unitTeam, attackerID, attackerDefID, attackerTeam, weaponDefID)
	if not resim then
		-- A death in view tombstones the id — the engine may keep returning it
		-- from GetAllUnits (stale radar-memory dot / lingering corpse), which
		-- must not be recorded as a live unit. The next sample finds the prev
		-- entry unrefreshed and emits the id on the dead list. A
		-- re-simulation records exactly what the engine lists instead (see
		-- sample).
		local src = lastKnown[unitID] or prev[unitID]
		local tx, tz
		if src ~= nil then
			tx, tz = src.x, src.z
		else
			local x, _, z = spGetUnitPosition(unitID)
			tx, tz = x, z
		end
		buried[unitID] = { x = tx, z = tz, def = unitDefID, team = unitTeam }
		lastKnown[unitID] = nil
	end
	if recordDamage then
		pcall(onDestroyed, unitID, unitDefID, unitTeam, attackerID, attackerDefID, attackerTeam)
	end
	-- Only a REAL attacker is a cause: the engine passes nils for a death
	-- with none (self-destruct, a crash, a reclaim), and a weapon id alone
	-- does happen (a weapon with no surviving owner).
	if attackerID ~= nil or attackerDefID ~= nil or attackerTeam ~= nil or weaponDefID ~= nil then
		pcall(event, "destroyed", unitID, unitDefID, unitTeam, attackerID, attackerDefID, attackerTeam, weaponDefID)
	else
		pcall(event, "destroyed", unitID, unitDefID, unitTeam)
	end
end

-- A unit changing hands. UnitTaken fires for the same transfer from the
-- other side and is deliberately not recorded: one event per transfer.
function widget:UnitGiven(unitID, unitDefID, newTeam, oldTeam)
	if recordDamage then
		local l = lives[unitID]
		if l ~= nil then
			l.team = newTeam or l.team
		end
	end
	pcall(event, "given", unitID, unitDefID, newTeam, nil, nil, oldTeam or -1, nil)
end

if recordDamage then
	-- Defined only when recording: an unused UnitDamaged callin would still
	-- cost a Lua call per hit.
	function widget:UnitDamaged(unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, projectileID, attackerID, attackerDefID, attackerTeam)
		pcall(onDamaged, unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, attackerID, attackerDefID, attackerTeam)
	end
end

if resim then
	function widget:Update()
		drawFrames = drawFrames + 1
	end
end

function widget:TeamDied(teamID)
	pcall(writeFact, { { "k", "teamdied" }, { "f", factFrame() }, { "team", teamID } })
end

-- ---------------------------------------------------------------------------
-- Player comms: what people write and draw. Recorded as 'C' records, one per
-- message or drawing command; the payload
-- is JSON because chat text and marker labels are free-form (spaces, quotes,
-- UTF-8), like the DEF and GAME records.
--
--   {"f":<frame>,"k":"chat","p":<playerID>,"d":"all|ally|spec|private|lobby","t":"<text>"}
--   {"f":<frame>,"k":"point","p":<playerID>,"x":<x>,"z":<z>,"t":"<label>"}
--   {"f":<frame>,"k":"line","p":<playerID>,"x":<x>,"z":<z>,"x2":<x2>,"z2":<z2>}
--   {"f":<frame>,"k":"erase","p":<playerID>,"x":<x>,"z":<z>}
-- "n" carries the speaker's name only when "p" is -1 (unresolvable); otherwise
-- the roster in the preamble names them.
--
--
-- NOTE: this is the FALLBACK source. Whenever a demo file is available the
-- pipeline replaces these records with the demo's packet stream, which holds
-- every side's chat on every channel and stamps each comm with the frame it
-- truly landed on (internal/demofile/comms.go). What is recorded here is what
-- a capture with no demo behind it still gets — and its frame stamps are
-- approximate, because the engine flushes console lines from its unsynced
-- update rather than when the chat arrives.
-- DRAWINGS come from MapDrawCmd, which is structured — playerID and world
-- coordinates, no parsing. The engine fires it only for marks this client may
-- see (its own ally team's while playing, everyone's when spectating), so the
-- drawings in a capture are point-of-view-limited exactly like its units.
--
-- CHAT has no such callin: BAR's widget handler does not forward GotChatMsg
-- (actions.lua consumes it for chat actions), so the only source is
-- AddConsoleLine — the console's DISPLAY string. CGame::HandleChatMsg builds
-- it with a fixed grammar, which splitSpeaker reverses:
--   "<Name> body"                             a player
--   "[Name] body" / "[Name (replay)] body"    a spectator
--   "> <Name> body"                           relayed from the battleroom
-- with the channel as a prefix of the body ("Allies: ", "Spectators: ",
-- "Private: ", or " whispered <who>: " for a replay-visible whisper). A
-- bracketed line only counts as chat when the name belongs to a player this
-- game knows — the same disambiguation BAR's own chat widget applies, and what
-- keeps ordinary console output (this widget's own "[replay-uploader] ..."
-- heartbeats included) out of the record. "<Name> added point: <label>" lines
-- are ignored on purpose: that marker already arrived via MapDrawCmd, with
-- coordinates.

-- Cap on recorded comms. The engine already rate-limits drawing (at most one
-- segment per 50 ms per player, and the server drops a burst past 25), but the
-- viewer downloads the whole comm set before playback, so a long game full of
-- enthusiastic drawers must not be able to grow it without bound.
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
		Echo(logTag .. " comm limit reached (" .. maxComms .. "); no more chat/drawings recorded")
	end
	writeRecord("C", jsonObject(fields))
end

-- commFrame is the sim frame a comm is stamped with, clamped at 0: chat can
-- arrive during loading, when the engine reports a negative frame.
local function commFrame()
	local f = spGetGameFrame()
	if not f or f < 0 then
		return 0
	end
	return f
end

-- Channel prefixes the engine puts in front of a message body, in the form
-- HandleChatMsg writes them.
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
			-- A spectator watching a demo is labelled "[Name (replay)]".
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
-- (always the engine's constant 100, so it is not recorded).
--
-- Returning a truthy value would TAKE the event — the engine would never draw
-- the mark and no later widget would see it — so this returns nothing, always.
function widget:MapDrawCmd(playerID, cmdType, px, py, pz, a, b, c)
	pcall(recordDraw, playerID, cmdType, px, pz, a, b, c)
end

function widget:PlayerAdded(playerID)
	pcall(notePlayer, playerID)
end

function widget:PlayerChanged(playerID)
	pcall(notePlayer, playerID)
end

-- PlayerRemoved: a player left (reason: 0 = lost connection, 1 = left,
-- 2 = kicked — the engine's own codes, recorded as they come).
function widget:PlayerRemoved(playerID, reason)
	pcall(writeFact, { { "k", "playerleft" }, { "f", factFrame() }, { "player", playerID }, { "reason", reason } })
end

-- finishResim writes what only the end of the game can say: the last damage
-- window, every survivor's lifetime totals, the engine's team statistics and
-- the profiler's final totals. Each part is guarded on its own — a failure
-- in one must not cost the others, nor the capture.
local function finishResim(frame)
	if recordDamage then
		local okLives, errLives = pcall(function()
			flushDamage(frame)
			for _, unitID in ipairs(spGetAllUnits()) do
				lifeOf(unitID, spGetUnitDefID(unitID), spGetUnitTeam(unitID))
			end
			local rows = {}
			for unitID, l in pairs(lives) do
				if spGetUnitExperience then
					l.xp = spGetUnitExperience(unitID)
				end
				rows[#rows + 1] = { unitID, l, aliveAtEnd }
			end
			table.sort(rows, function(a, b) return a[1] < b[1] end)
			writeLives(frame, rows)
			Echo(logTag .. " damage: " .. dmgSeen .. " hits, " .. dmgNamedAttacker
				.. " naming an attacker, " .. dmgNamedWeapon .. " naming a weapon")
		end)
		if not okLives then
			Echo(logTag .. " final damage window / unit lives failed (" .. tostring(errLives) .. ")")
		end
	end
	local ok, err = pcall(writeTeamStats)
	if not ok then
		Echo(logTag .. " team statistics failed (" .. tostring(err) .. ")")
	end
	local recs = profilerTotals()
	if recs and recs[1] then
		pcall(writeProfile, recs, 80, frame, lastUnitCount, true)
	else
		Echo(logTag .. " engine time profiler not available; skipping the totals")
	end
end

-- GameOver hands over the winning ALLY teams (empty for a draw, or when the
-- game ended with nobody standing).
function widget:GameOver(winningAllyTeams)
	local frame = factFrame()
	pcall(function()
		local winners = {}
		if type(winningAllyTeams) == "table" then
			for i = 1, #winningAllyTeams do
				winners[i] = winningAllyTeams[i]
			end
		end
		writeFact({ { "k", "end" }, { "f", frame }, { "winners", jsonArray(winners), true } })
	end)
	if resim then
		finishResim(frame)
	end
	Echo(logTag .. " game over; capture complete" .. (gameId and (": " .. gameId) or ""))
	gameEnded = true
	closeOut("gameover")
	if resim then
		-- Clean, deterministic exit of the headless process.
		Spring.SendCommands("quitforce")
	end
end

-- Shutdown fires on engine teardown (or widget removal) even if GameOver did
-- not — e.g. the player quits mid-game; keep the partial capture.
function widget:Shutdown()
	closeOut("shutdown")
end
