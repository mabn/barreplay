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
--     R  closed projectile and beam tracks, packed (resim only, protocol >= 5;
--        see the projectiles section)
--     W  strong explosions that end no track, packed (resim only, protocol >= 5;
--        not B, which would read as the start of a segment header)
--     P  engine time-profiler readings, JSON (resim only; see profiling)
--     X  end of stream, text payload = reason (gameover|shutdown|error)

-- Widget version (semver) and the date that version was cut. Bump BOTH on any
-- user-visible or wire-visible change; they are reported in GetInfo, the load
-- Echo, and the stream's GAME line, so every capture records which encoder
-- produced it (the copy on a player's machine can be arbitrarily old — the
-- server/decoder needs to know, and the catalog stores it per replay).
local widgetVersion = "1.10.1"
local widgetDate = "2026-10-12"

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
-- Long-range projectiles, heavy beams and strong explosions (R and W
-- records, the stock fact; -projectiles).
local recordProjectiles = resim and ("__PROJECTILES__" == "1")
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
--    isCommander/maxWeaponRange/deathWeapon/selfdWeapon extras, and the
--    G/H/U/V/P record types may
--    appear. Purely additive: a protocol-3 decoder skips all of it.
-- 5: the R (projectile and beam tracks) and B (strong explosions) record
--    types, the "stock" fact, and explosion/flight keys on the wdefs entries
--    of watched weapons. Re-simulation only; purely additive again.
-- 6: the Q record type (shield charge) and the shieldRadius/shieldPower DEF
--    keys. Both modes; purely additive.
local protocolVersion = 6

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
local spGetProjectileTeamID  = Spring.GetProjectileTeamID
local spGetProjectileOwnerID = Spring.GetProjectileOwnerID
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

-- shieldParams is a unit's shield as BAR's own shield drawing knows it
-- (customParams shield_radius / shield_power): reach in elmos and full
-- charge, or nil when it has none. Read from the def rather than hardcoded
-- anywhere because tweakdefs change them.
local function shieldParams(ud)
	local r = customParam(ud, "shield_radius", "number")
	local p = customParam(ud, "shield_power", "number")
	if r and p and r > 0 and p > 0 then
		return r, p
	end
	return nil
end

-- explosionWeapon is the weapon-def id of a unit's death or self-destruct
-- explosion (UnitDefs carry the weapon's NAME), or nil.
local function explosionWeapon(name)
	local wd = name and name ~= "" and WeaponDefNames and WeaponDefNames[name]
	return wd and wd.id or nil
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
		-- The explosions the unit makes when it dies and when it
		-- self-destructs: what lets a reader tell which dead unit a blast
		-- with no attacker came from.
		{ "deathWeapon", explosionWeapon(ud.deathExplosion) },
		{ "selfdWeapon", explosionWeapon(ud.selfDExplosion) },
		-- Protocol 6: the shield's reach and full charge (Q records hold
		-- what it has left).
		{ "shieldRadius", (shieldParams(ud)) },
		{ "shieldPower", select(2, shieldParams(ud)) },
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
	local spec, fullView = spGetSpectatingState()
	local specFullView = nil -- a player has no such setting
	if spec then
		specFullView = fullView and true or false
	end
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
		-- A spectator is not always watching everything: with full view off
		-- they see what the ally team they picked sees, like a player of it.
		-- Only the start is stated here; the "view" facts follow changes.
		{ "fullView", specFullView },
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

-- ---------------------------------------------------------------------------
-- Shield charge (Q records; protocol 6, both modes). A shield generator's
-- position is already in the frames and its size in its DEF; what only the
-- engine knows is how much charge it has left, which Spring.GetUnitShieldState
-- answers (power, and whether the shield is switched on). LOS-gated like
-- everything else: a playing client reads its own side's shields and gets nil
-- for the rest, which are then simply not recorded. A row is written only
-- when the reading MOVED — by at least SHIELD_STEP of the full charge, or
-- reaching empty or full, or switching — so a quiet base costs nothing and a
-- reader holds each row until the unit's next one.
local shields = (function()
	local spGetUnitShieldState = Spring.GetUnitShieldState
	local SHIELD_STEP = 0.005
	local full = nil -- defID -> full power (false = no shield), built on first use
	local last = {}  -- unitID -> { p, on, f }

	local function fullOf(defID)
		if full == nil then
			full = {}
		end
		local v = full[defID]
		if v == nil then
			local ud = UnitDefs and UnitDefs[defID]
			local _, p = nil, nil
			if ud then
				_, p = shieldParams(ud)
			end
			v = p or false
			full[defID] = v
		end
		return v
	end

	-- read is called from sample's unit loop for every recorded unit with a
	-- known def; it returns the row to write (or nil).
	local function read(unitID, defID, frame)
		if spGetUnitShieldState == nil or unitID > 65535 then
			return nil
		end
		local fp = fullOf(defID)
		if not fp then
			return nil
		end
		local s, power = spGetUnitShieldState(unitID)
		if power == nil then
			return nil
		end
		local on = (s == true) or (type(s) == "number" and s ~= 0)
		local q = mathFloor(power + 0.5)
		if q < 0 then q = 0 elseif q > 2147483647 then q = 2147483647 end
		local l = last[unitID]
		if l == nil then
			last[unitID] = { p = q, on = on, f = frame }
			return q, on
		end
		l.f = frame
		local d = q - l.p
		if d < 0 then d = -d end
		if on ~= l.on or d >= fp * SHIELD_STEP
			or (q ~= l.p and (q == 0 or q >= fp)) then
			l.p, l.on = q, on
			return q, on
		end
		return nil
	end

	local function write(frame, ids, powers, flags)
		-- Forget units not seen this sample, so a recycled id starts afresh.
		for id, l in pairs(last) do
			if l.f ~= frame then
				last[id] = nil
			end
		end
		local n = #ids
		if n == 0 then
			return
		end
		writeRecord("Q", table.concat({
			PackU32({ frame }), PackU32({ n }), PackU16(ids), PackU32(powers), PackU8(flags),
		}))
	end

	return { read = read, write = write }
end)()

-- noteView keeps myAllyTeam current and, in the uploader, writes a "view"
-- fact whenever whose point of view the capture records changes:
--
--   {"k":"view","f":<frame>,"spec":<bool>,"full":<bool>,"ally":<allyTeam>}
--
-- The GAME line states only the start, and the start is not the whole story.
-- A spectator can turn full view off and watch through one ally team's eyes,
-- or switch from one team to another, and a player who dies or resigns
-- becomes a full-view spectator. myAllyTeam has to follow, too: it decides
-- which units are read as enemies (the radar-identity cache), so a spectator
-- who switched teams would otherwise treat the side they now watch as the
-- enemy and the side they left as their own.
local lastView = nil

local function noteView(frame, spec, fullView)
	local ally = (spGetMyAllyTeamID and spGetMyAllyTeamID()) or -1
	myAllyTeam = ally
	if resim then
		return -- one point of view, the whole game, declared at Initialize
	end
	local full = (spec and fullView) and true or false
	spec = spec and true or false
	local v = lastView
	if v ~= nil and v.spec == spec and v.full == full and v.ally == ally then
		return
	end
	lastView = { spec = spec, full = full, ally = ally }
	writeRecord("G", jsonObject({
		{ "k", "view" }, { "f", frame }, { "spec", spec }, { "full", full }, { "ally", ally },
	}))
end

local function sample(frame)
	local t0 = startClock()
	local spec, fullView = spGetSpectatingState()
	local all = spec and fullView
	noteView(frame, spec, fullView)
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
	local sid, spow, sflag = {}, {}, {}
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
				if defID ~= nil then
					local sp, son = shields.read(unitID, defID, frame)
					if sp ~= nil then
						local k = #sid + 1
						sid[k], spow[k], sflag[k] = unitID, sp, son and 1 or 0
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
	shields.write(frame, sid, spow, sflag)

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

-- watchedWeaponFields returns the protocol-5 keys of a weapon the capture
-- watches (nil for the rest). Defined with the projectiles section below.
local watchedWeaponFields

-- weaponDefsJSON is the weapon table the cause columns (a kill's weapon, a
-- damage window's weapon) index into. Weapon ids are per game build, like
-- unit-def ids, so the table has to travel with the capture.
local function weaponDefsJSON()
	local defs = {}
	for id, wd in pairs(WeaponDefs or {}) do
		local dmg = wd.damages and (wd.damages[0] or wd.damages[1]) or nil
		local fields = {
			{ "id", id },
			{ "name", wd.name },
			{ "description", (wd.description ~= nil and wd.description ~= "") and wd.description or nil },
			{ "type", wd.type },
			{ "range", wd.range },
			{ "reload", wd.reload },
			{ "damage", type(dmg) == "number" and dmg or nil },
			{ "paralyzer", wd.paralyzer or nil },
			{ "aoe", (wd.damageAreaOfEffect or 0) > 0 and wd.damageAreaOfEffect or nil },
		}
		local extra = watchedWeaponFields and watchedWeaponFields(id, wd)
		for i = 1, #(extra or {}) do
			fields[#fields + 1] = extra[i]
		end
		defs[#defs + 1] = jsonObject(fields)
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
-- Damage (resim only, recordDamage). Every UnitDamaged callin is written
-- down as the engine delivered it — the widget draws NO conclusions from it.
-- Who gets the credit for a death explosion, how much of a blow was
-- overkill, which blasts were big: all of that is worked out when the file
-- is read (internal/combat), where it can be changed without re-simulating
-- the game, which is the one expensive thing. Hits are buffered and written
-- once per sample as an H record, columns over the hits since the previous
-- sample:
--
--   frame u32 (the window's first frame), n u32, then columns of n:
--   df u16 (frame - window), victim u16, vDef u16, vTeam u8, x u16, z u16,
--   attacker u16, aDef u16, aTeam u8, weapon u16, projOwner u16,
--   projTeam u8, flags u8 (bit 0 paralyzer, bit 1 projectile),
--   damage f32, hpAfter f32
--
-- 65535 / 255 mean unknown. attacker* is what the engine named (nothing,
-- for a death explosion; sometimes the exploding unit itself). x/z is the
-- victim's position, hpAfter its health right after the hit (below zero by
-- the overkill). projOwner/projTeam are read off the projectile only when
-- the engine named no attacker: it resolves the attacker from the shooter,
-- which is gone once the shooter has died, so a shell still in flight then
-- lands anonymously while the projectile still knows who fired it.
--
-- Where each unit's life ended rides alongside as U records, one row per
-- death and, at game end, per survivor:
--
--   frame u32, n u32, then columns of n: df u16, unit u16, hit u32 (how
--   many hits had been recorded before it — orders it exactly among
--   them), x u16, z u16, xp f32, flags u8 (bit 0 alive at the end)
--
-- The death's killer is on its destroyed event, also as the engine gave it.

local hitStart = 0  -- first frame of the open window
local hitTotal = 0  -- hits recorded so far: the U rows' order index

local function newHitBuf()
	return { n = 0, df = {}, v = {}, vd = {}, vt = {}, x = {}, z = {}, a = {}, ad = {}, at = {},
		w = {}, po = {}, pt = {}, fl = {}, d = {}, hp = {} }
end

local function newEndBuf()
	return { n = 0, df = {}, u = {}, h = {}, x = {}, z = {}, xp = {}, fl = {} }
end

local hits = newHitBuf()
local ends = newEndBuf()

-- How many hits arrived, and how many of them named an attacker and a
-- weapon: logged at game end, because whether the engine hands a widget the
-- attacker of a hit is exactly what a capture cannot show on its own (an
-- all-unknown damage log looks the same as a game of crashes).
local dmgSeen, dmgNamedAttacker, dmgNamedWeapon = 0, 0, 0
-- Hits whose shooter came from the projectile, and hits the engine itself
-- caused (a negative weaponDefID: lava, crushing, a collision, a Lua kill).
local dmgFromProjectile, dmgEngineCause = 0, 0

-- The engine's own damage sources arrive as weaponDefID = -k (Recoil's
-- CSolidObject::DamageType: 1 debris, 2 ground collision, 3 object
-- collision, 4 fire, 5 water/lava, 6 killed by Lua, 7 crushed). They are
-- written just below the unknown sentinel, 65535 - k, so the cause survives
-- instead of folding into "unknown".
local maxEngineCause = 7
local function weaponCode(weaponDefID)
	if weaponDefID == nil then
		return 65535
	end
	if weaponDefID >= 0 and weaponDefID < 65535 - maxEngineCause then
		return weaponDefID
	end
	if weaponDefID < 0 and weaponDefID >= -maxEngineCause then
		return 65535 + weaponDefID
	end
	return 65535
end

local function id16(v)
	if v ~= nil and v >= 0 and v < 65535 then
		return v
	end
	return 65535
end

local function team8(v)
	if v ~= nil and v >= 0 and v < 255 then
		return v
	end
	return 255
end

local function pos16(v)
	if v == nil then
		return 0
	end
	return clamp(mathFloor(v + 0.5), 0, 65535)
end

local flushDamage -- defined below; a full buffer flushes early

local function recordHit(unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, projectileID, attackerID, attackerDefID, attackerTeam)
	if type(damage) ~= "number" or damage <= 0 then
		return
	end
	dmgSeen = dmgSeen + 1
	if attackerTeam ~= nil then dmgNamedAttacker = dmgNamedAttacker + 1 end
	if weaponDefID ~= nil and weaponDefID >= 0 then dmgNamedWeapon = dmgNamedWeapon + 1 end
	if weaponDefID ~= nil and weaponDefID < 0 then dmgEngineCause = dmgEngineCause + 1 end
	local isProj = projectileID ~= nil and projectileID >= 0
	local po, pt = 65535, 255
	if attackerTeam == nil and isProj and spGetProjectileTeamID then
		local t = spGetProjectileTeamID(projectileID)
		if t ~= nil then
			pt = team8(t)
			po = id16(spGetProjectileOwnerID and spGetProjectileOwnerID(projectileID))
			dmgFromProjectile = dmgFromProjectile + 1
		end
	end
	local hp = spGetUnitHealth(unitID)
	local x, _, z = spGetUnitPosition(unitID)
	local b = hits
	local n = b.n + 1
	b.n = n
	b.df[n] = clamp(spGetGameFrame() - hitStart, 0, 65535)
	b.v[n] = id16(unitID)
	b.vd[n] = id16(unitDefID)
	b.vt[n] = team8(unitTeam)
	b.x[n] = pos16(x)
	b.z[n] = pos16(z)
	b.a[n] = id16(attackerID)
	b.ad[n] = id16(attackerDefID)
	b.at[n] = team8(attackerTeam)
	b.w[n] = weaponCode(weaponDefID)
	b.po[n] = po
	b.pt[n] = pt
	b.fl[n] = (paralyzer and 1 or 0) + (isProj and 2 or 0)
	b.d[n] = damage
	b.hp[n] = hp or 0
	hitTotal = hitTotal + 1
	if n >= 60000 then
		flushDamage(spGetGameFrame(), true)
	end
end

-- recordEnd writes where unitID's life ended (alive: still standing when
-- the game ended).
local function recordEnd(unitID, alive)
	local x, _, z = spGetUnitPosition(unitID)
	local b = ends
	local n = b.n + 1
	b.n = n
	b.df[n] = clamp(factFrame() - hitStart, 0, 65535)
	b.u[n] = id16(unitID)
	b.h[n] = hitTotal
	b.x[n] = pos16(x)
	b.z[n] = pos16(z)
	b.xp[n] = (spGetUnitExperience and spGetUnitExperience(unitID)) or 0
	b.fl[n] = alive and 1 or 0
end

-- flushDamage writes the open window's hits and unit ends (if any), then
-- opens the next window at frame. force writes even with no sim frame
-- since the window opened (a full buffer, the game ending).
flushDamage = function(frame, force)
	if not force then
		if frame <= hitStart and frame > 0 then
			return -- no sim frame since the window opened; keep it open
		end
		if frame == 0 then
			hitStart = 0 -- the first sample: anything before it joins window 0
			return
		end
	end
	local b = hits
	if b.n > 0 then
		writeRecord("H", table.concat({
			PackU32({ hitStart }), PackU32({ b.n }),
			PackU16(b.df), PackU16(b.v), PackU16(b.vd), PackU8(b.vt),
			PackU16(b.x), PackU16(b.z),
			PackU16(b.a), PackU16(b.ad), PackU8(b.at), PackU16(b.w),
			PackU16(b.po), PackU8(b.pt), PackU8(b.fl),
			PackF32(b.d), PackF32(b.hp),
		}))
		hits = newHitBuf()
	end
	local e = ends
	if e.n > 0 then
		writeRecord("U", table.concat({
			PackU32({ hitStart }), PackU32({ e.n }),
			PackU16(e.df), PackU16(e.u), PackU32(e.h),
			PackU16(e.x), PackU16(e.z), PackF32(e.xp), PackU8(e.fl),
		}))
		ends = newEndBuf()
	end
	if frame > hitStart then
		hitStart = frame
	end
end

-- ---------------------------------------------------------------------------
-- Projectiles, beams and strong explosions (resim only, recordProjectiles;
-- protocol 5). Design and the engine behaviour it relies on:
-- docs/projectiles-and-explosions.md; byte formats: docs/brepstream-format.md.
--
-- What is watched is decided once from WeaponDefs, never from unit names —
-- mods add units and change their numbers. A weapon is TRACKED when it falls
-- in one of the classes below (classifyWeapon); a unit's death or
-- self-destruct weapon is a BLAST weapon when it is strong (damage and radius
-- over the thresholds); a tracked weapon's cluster sub-munition is watched
-- too. The widget writes what the engine reported and nothing it concluded:
-- who a blast hit is in the H records.
--
-- R rows (one per closed track; a track is one projectile, or one firing of
-- a beam): written when the track closes, buffered and flushed once per
-- sample like H. Columns: birth u32, end u32, id u32, weapon u16, owner u16,
-- team u8, class u8, endKind u8, flags u8, x0/y0/z0 s16, vx/vy/vz f32,
-- gravity f32, targetType u8, target u32, tx/ty/tz s16, x1/y1/z1 s16,
-- points u16; then every row's path points as columns df u16, x/y/z s16.
-- W rows (an explosion of a watched weapon that ends no track): frame u32,
-- n u32, then columns df u16, weapon u16, x/y/z s16, unit u16, team u8,
-- kind u8 (1 a unit's own explosion, 2 a projectile no track was open for).

-- The section lives in one closure so its state does not count against the
-- main chunk's 200-local limit (Lua 5.1); it hands back its entry points.
local projectiles = (function()
	local spGetProjectilesInSphere = Spring.GetProjectilesInSphere
	local spGetProjectileDefID = Spring.GetProjectileDefID
	local spGetProjectilePosition = Spring.GetProjectilePosition
	local spGetProjectileVelocity = Spring.GetProjectileVelocity
	local spGetProjectileGravity = Spring.GetProjectileGravity
	local spGetProjectileTarget = Spring.GetProjectileTarget
	local spGetProjectileIsIntercepted = Spring.GetProjectileIsIntercepted
	local spGetUnitWeaponState = Spring.GetUnitWeaponState
	local spGetUnitWeaponVectors = Spring.GetUnitWeaponVectors
	local spGetUnitWeaponTarget = Spring.GetUnitWeaponTarget
	local spGetFeaturePosition = Spring.GetFeaturePosition

	-- Class codes (the R record's class column; docs/brepstream-format.md).
	local CLS_NUKE, CLS_ANTINUKE, CLS_EMP, CLS_TACTICAL = 1, 2, 3, 4
	local CLS_JUNO, CLS_ARTILLERY, CLS_ROCKET, CLS_BEAM = 5, 6, 7, 8
	local classNames = { "nuke", "antinuke", "emp", "tactical", "juno", "artillery", "rocket", "beam" }
	-- Strategic classes: few per game, and their path IS the story (a starburst
	-- missile climbs, turns and dives), so their position is sampled in flight.
	-- Everything else flies an arc the launch velocity and gravity describe.
	local strategicClass = { [CLS_NUKE] = true, [CLS_ANTINUKE] = true, [CLS_EMP] = true,
		[CLS_TACTICAL] = true, [CLS_JUNO] = true }

	-- Selection thresholds. damage = damages[0] (the whole shot; a beam spreads
	-- it over its frames), range and radius in elmos. Measured against a modded
	-- game's runtime weapon table (docs/projectiles-and-explosions.md §3, §4.6).
	local nukeMinRange = 10000
	local beamMinDamage, beamMinRange = 2000, 600
	local empMinDamage = 5000
	local tacticalMinRange = 1500
	local artilleryMinRange = 1500
	local rocketMinRange = 1000
	local blastMinDamage, blastMinRadius = 400, 64

	local strategicPathEvery = 10 -- frames between a strategic track's path samples
	local beamPathEvery = 5       -- a beam keeps a hit point at most this often...
	local beamPathJump2 = 64 * 64 -- ...unless it jumped this far (squared elmos)
	local maxPathPoints = 400
	local trackSweepEvery = 15    -- frames between checks for tracks gone silently

	-- Engine target-type bytes (GetProjectileTarget), and the R record's codes
	-- for GetUnitWeaponTarget's numeric types (0 none, 1 unit, 2 ground, 3 an
	-- interceptor's projectile).
	local TGT_UNIT, TGT_GROUND, TGT_FEATURE, TGT_PROJ = 117, 103, 102, 112 -- 'u' 'g' 'f' 'p'
	local weaponTargetByte = { [1] = TGT_UNIT, [2] = TGT_GROUND, [3] = TGT_PROJ }

	local none24 = 16777215 -- 0xFFFFFF: the u32 "none" (every packed value stays below 2^24)

	local trackClassOf = {} -- weaponDefID -> class code
	local blastWeapon = {}  -- weaponDefID -> true: a strong unit explosion
	local subWeapon = {}    -- weaponDefID -> true: a tracked weapon's cluster sub-munition
	local watchRole = {}    -- weaponDefID -> "track" | "blast" | "sub" (the wdefs fact)
	local slotsOfDef = {}   -- unitDefID -> { {slot, wd, cls, window, radius}, ... }
	local nTracked, nLauncherDefs, nWatched = 0, 0, 0

	-- wcp reads one of BAR's weapon customParams (strings in the def table);
	-- "0", "false" and empty count as absent.
	local function wcp(wd, key)
		local cp = wd.customParams
		local v = cp and cp[key]
		if v == nil or v == "" or v == "0" or v == "false" or v == false then
			return nil
		end
		return v
	end

	-- weaponDamage is the shot's default damage, read exactly as the wdefs fact
	-- reads it.
	local function weaponDamage(wd)
		local d = wd.damages and (wd.damages[0] or wd.damages[1]) or nil
		return type(d) == "number" and d or 0
	end

	-- classifyWeapon returns the track class of a weapon def, or nil. The order
	-- matters: an anti-nuke and a Juno are stockpiled long-range starbursts too,
	-- the Paralyzer is stockpiled, an EMP beam is a beam, and a stockpiled
	-- long-range AA missile (the Mercury) deals 1 to the ground.
	local function classifyWeapon(wd)
		if wcp(wd, "bogus") then
			return nil -- silo dummies, energy chargers
		end
		local dmg, range = weaponDamage(wd), wd.range or 0
		if (wd.interceptor or 0) ~= 0 then
			return CLS_ANTINUKE
		end
		if wcp(wd, "junotype") then
			return CLS_JUNO
		end
		if wcp(wd, "nuclear") then
			return range >= nukeMinRange and CLS_NUKE or CLS_TACTICAL
		end
		if wd.type == "BeamLaser" or wd.type == "LightningCannon" then
			if dmg >= beamMinDamage and range >= beamMinRange then
				return CLS_BEAM
			end
			return nil
		end
		if wd.paralyzer and dmg >= empMinDamage then
			return CLS_EMP
		end
		if dmg <= 1 then
			return nil -- AA and utility weapons (a stockpiled long-range AA missile too)
		end
		if wd.stockpile and range >= tacticalMinRange then
			return CLS_TACTICAL
		end
		if wd.type == "Cannon" and range >= artilleryMinRange then
			return CLS_ARTILLERY
		end
		if (wd.type == "StarburstLauncher" or wd.type == "MissileLauncher") and range >= rocketMinRange then
			return CLS_ROCKET
		end
		return nil
	end

	local function strongBlast(wd)
		return wd ~= nil and weaponDamage(wd) >= blastMinDamage
			and (wd.damageAreaOfEffect or 0) >= blastMinRadius
	end

	-- buildWatch fills the tables above from the def tables. Runs once.
	local function buildWatch()
		for id, wd in pairs(WeaponDefs or {}) do
			local c = classifyWeapon(wd)
			if c then
				trackClassOf[id] = c
				watchRole[id] = "track"
				nTracked = nTracked + 1
			end
		end
		for udid, ud in pairs(UnitDefs) do
			for _, name in ipairs({ ud.deathExplosion or "", ud.selfDExplosion or "" }) do
				local wd = name ~= "" and WeaponDefNames and WeaponDefNames[name]
				if wd and strongBlast(wd) and not trackClassOf[wd.id] then
					blastWeapon[wd.id] = true
					watchRole[wd.id] = "blast"
				end
			end
			local slots = nil
			for i, w in ipairs(ud.weapons or {}) do
				local wid = w.weaponDef
				local c = wid and trackClassOf[wid]
				if c then
					local wd = WeaponDefs[wid]
					-- Frames the shot keeps producing projectiles (a salvo, a
					-- beam's duration), and how far from the muzzle a new one
					-- can be by the time GameFramePost looks for it.
					-- The first shot leaves windup seconds after the weapon
					-- fires (the Mini Starfall waits 2.5 s, then fires 63).
					local windup = mathFloor((wd.windup or 0) * gameSpeed + 0.5)
					local salvo = math.ceil(((wd.salvoSize or 1) - 1) * (wd.salvoDelay or 0) * gameSpeed)
					local window = windup + salvo
					if c == CLS_BEAM then
						window = math.max(window, windup + mathFloor((wd.beamtime or 0) * gameSpeed))
					end
					slots = slots or {}
					slots[#slots + 1] = { slot = i, wd = wid, cls = c, window = window + 2,
						radius = math.max(96, 4 * (wd.projectilespeed or 0)) }
					local sub = wcp(wd, "cluster_def")
					if sub then
						local sw = WeaponDefNames and (WeaponDefNames[ud.name .. "_" .. sub] or WeaponDefNames[sub])
						if sw and not trackClassOf[sw.id] then
							subWeapon[sw.id] = true
							watchRole[sw.id] = watchRole[sw.id] or "sub"
						end
					end
				end
			end
			if slots then
				slotsOfDef[udid] = slots
				nLauncherDefs = nLauncherDefs + 1
			end
		end
		for _ in pairs(watchRole) do
			nWatched = nWatched + 1
		end
	end

	-- watchedWeaponJSON is the protocol-5 extension of a watched weapon's wdefs
	-- entry: what an explosion of it does and how it flies (units as the Lua
	-- def table gives them: speed and gravity per frame, salvoDelay and
	-- beamtime in seconds, stockpileTime and flightTime in frames).
	local function armorDamages(wd)
		local d0 = weaponDamage(wd)
		local types = Game and Game.armorTypes
		if type(types) ~= "table" or not wd.damages then
			return nil
		end
		local idx = {}
		for k, v in pairs(types) do
			if type(k) == "number" and type(v) == "string" then
				idx[#idx + 1] = k
			end
		end
		table.sort(idx)
		local parts = {}
		for _, i in ipairs(idx) do
			local v = wd.damages[i]
			if type(v) == "number" and v ~= d0 then
				parts[#parts + 1] = '"' .. jsonEscape(types[i]) .. '":' .. jsonValue(v)
			end
		end
		if #parts == 0 then
			return nil
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end

	local watchedCustomParams = { "nuclear", "junotype", "cluster_def", "cluster_number",
		"area_onhit_damage", "area_onhit_range", "area_onhit_time", "overrange_distance", "stockpilelimit" }

	watchedWeaponFields = function(id, wd)
		if watchRole[id] == nil then
			return nil
		end
		local cp = {}
		for _, key in ipairs(watchedCustomParams) do
			local v = wcp(wd, key)
			if v ~= nil then
				cp[#cp + 1] = { key, tonumber(v) or tostring(v) }
			end
		end
		local dmg = wd.damages or {}
		return {
			{ "role", watchRole[id] },
			{ "class", trackClassOf[id] and classNames[trackClassOf[id]] or nil },
			{ "edge", wd.edgeEffectiveness },
			{ "expSpeed", wd.explosionSpeed },
			{ "crater", (wd.craterAreaOfEffect or 0) > 0 and wd.craterAreaOfEffect or nil },
			{ "impulse", dmg.impulseFactor },
			{ "damages", armorDamages(wd), true },
			{ "paralyzeTime", wd.paralyzer and dmg.paralyzeDamageTime or nil },
			{ "stockpile", wd.stockpile or nil },
			{ "stockpileTime", wd.stockpile and wd.stockpileTime or nil },
			{ "interceptor", (wd.interceptor or 0) ~= 0 and wd.interceptor or nil },
			{ "targetable", (wd.targetable or 0) ~= 0 and wd.targetable or nil },
			{ "coverage", (wd.coverageRange or 0) > 0 and wd.coverageRange or nil },
			{ "salvo", (wd.salvoSize or 1) > 1 and wd.salvoSize or nil },
			{ "salvoDelay", (wd.salvoSize or 1) > 1 and wd.salvoDelay or nil },
			{ "projectiles", (wd.projectiles or 1) > 1 and wd.projectiles or nil },
			{ "speed", (wd.projectilespeed or 0) > 0 and wd.projectilespeed or nil },
			{ "gravity", (wd.myGravity or 0) ~= 0 and wd.myGravity or nil },
			{ "highTrajectory", (wd.highTrajectory or 0) ~= 0 and wd.highTrajectory or nil },
			{ "flightTime", (wd.flightTime or 0) > 0 and wd.flightTime or nil },
			{ "beamtime", (wd.type == "BeamLaser") and wd.beamtime or nil },
			{ "sweepFire", wd.sweepFire or nil },
			{ "cp", #cp > 0 and jsonObject(cp) or nil, true },
		}
	end

	-- --- buffers ---------------------------------------------------------------

	local function newTrackBuf()
		return { n = 0, birth = {}, fin = {}, id = {}, w = {}, o = {}, t = {}, c = {}, k = {}, fl = {},
			x0 = {}, y0 = {}, z0 = {}, vx = {}, vy = {}, vz = {}, g = {}, tt = {}, tg = {},
			tx = {}, ty = {}, tz = {}, x1 = {}, y1 = {}, z1 = {}, np = {},
			pn = 0, pf = {}, px = {}, py = {}, pz = {} }
	end

	local function newBlastBuf()
		return { n = 0, df = {}, w = {}, x = {}, y = {}, z = {}, u = {}, t = {}, k = {} }
	end

	local trackBuf = newTrackBuf()
	local blastBuf = newBlastBuf()
	local projStart = 0 -- first frame of the open W window
	local tracksClosed, blastsSeen, launchesFound = 0, 0, 0
	local frameMs = 0 -- time spent in projectileFrame (hi-res timer only)

	-- s16 clamps a coordinate into the record's signed 16-bit column.
	local function s16(v)
		if v == nil then
			return 0
		end
		return clamp(mathFloor(v + 0.5), -32768, 32767)
	end

	local function u24(v)
		if v ~= nil and v >= 0 and v < none24 then
			return v
		end
		return none24
	end

	-- --- open tracks -----------------------------------------------------------

	local launchers = {} -- unitID -> { team, slots = { {info, rf, untilF}, ... } }
	local tracks = {}    -- projectileID -> open track
	local strategic = {} -- projectileID -> open strategic track (sampled in flight)
	local beamsOf = {}   -- unitID -> { [weaponDefID] = open beam }
	local beamList = {}  -- open beams, for expiry
	local boomAt = {}    -- projectileID -> frame an interceptor targeting it exploded
	local closedRow = {} -- projectileID -> { buf, n, f }: a track that closed this frame or the last
	local dyingTeam = {} -- unitID -> team, set by UnitDestroyed for the blast that follows

	local function setFlag(flags, bit) -- bit is a power of two; Lua 5.1 has no bit ops
		if (flags % (bit * 2)) >= bit then
			return flags
		end
		return flags + bit
	end

	local function addLauncher(unitID, defID, team)
		local slots = slotsOfDef[defID]
		if not slots or not spGetUnitWeaponState then
			return
		end
		local L = { team = team, slots = {} }
		for i, info in ipairs(slots) do
			L.slots[i] = { info = info, rf = spGetUnitWeaponState(unitID, info.slot, "reloadFrame"), untilF = -1 }
		end
		launchers[unitID] = L
	end

	-- targetOf returns the target type byte, id and position of a projectile.
	local function targetOf(pid)
		if not spGetProjectileTarget then
			return 0, nil
		end
		local tt, tgt = spGetProjectileTarget(pid)
		if tt == TGT_GROUND and type(tgt) == "table" then
			return tt, nil, tgt[1], tgt[2], tgt[3]
		elseif tt == TGT_UNIT and type(tgt) == "number" then
			local x, y, z = spGetUnitPosition(tgt)
			return tt, tgt, x, y, z
		elseif tt == TGT_FEATURE and type(tgt) == "number" and spGetFeaturePosition then
			local x, y, z = spGetFeaturePosition(tgt)
			return tt, tgt, x, y, z
		elseif tt == TGT_PROJ and type(tgt) == "number" then
			local x, y, z = spGetProjectilePosition(tgt)
			return tt, tgt, x, y, z
		end
		return 0, nil
	end

	local function openTrack(pid, owner, team, info, frame)
		local x, y, z = spGetProjectilePosition(pid)
		if x == nil then
			return
		end
		local vx, vy, vz = 0, 0, 0
		if spGetProjectileVelocity then
			vx, vy, vz = spGetProjectileVelocity(pid)
		end
		local tt, tg, tx, ty, tz = targetOf(pid)
		local t = { id = pid, wd = info.wd, cls = info.cls, owner = owner, team = team, birth = frame,
			x0 = x, y0 = y, z0 = z, lx = x, ly = y, lz = z,
			vx = vx or 0, vy = vy or 0, vz = vz or 0,
			g = spGetProjectileGravity and spGetProjectileGravity(pid) or 0,
			tt = tt, tg = tg, tx = tx, ty = ty, tz = tz, flags = 0,
			pf = {}, px = {}, py = {}, pz = {}, next = frame + strategicPathEvery }
		tracks[pid] = t
		if strategicClass[info.cls] then
			strategic[pid] = t
		end
		-- An interceptor names the projectile it is after: that one is engaged.
		if tt == TGT_PROJ and tg ~= nil and tracks[tg] ~= nil then
			local victim = tracks[tg]
			victim.flags = setFlag(victim.flags, 1)
		end
		launchesFound = launchesFound + 1
	end

	local function pushRow(r)
		local b = trackBuf
		local n = b.n + 1
		b.n = n
		b.birth[n], b.fin[n] = r.birth, math.max(r.fin, r.birth)
		b.id[n], b.w[n], b.o[n], b.t[n] = u24(r.id), id16(r.wd), id16(r.owner), team8(r.team)
		b.c[n], b.k[n], b.fl[n] = r.cls, r.kind, r.flags
		b.x0[n], b.y0[n], b.z0[n] = s16(r.x0), s16(r.y0), s16(r.z0)
		b.vx[n], b.vy[n], b.vz[n], b.g[n] = r.vx or 0, r.vy or 0, r.vz or 0, r.g or 0
		b.tt[n], b.tg[n] = r.tt or 0, u24(r.tg)
		b.tx[n], b.ty[n], b.tz[n] = s16(r.tx), s16(r.ty), s16(r.tz)
		b.x1[n], b.y1[n], b.z1[n] = s16(r.x1), s16(r.y1), s16(r.z1)
		local np = #r.pf
		b.np[n] = np
		for i = 1, np do
			local m = b.pn + 1
			b.pn = m
			b.pf[m] = clamp(r.pf[i], 0, 65535)
			b.px[m], b.py[m], b.pz[m] = s16(r.px[i]), s16(r.py[i]), s16(r.pz[i])
		end
		tracksClosed = tracksClosed + 1
		return n
	end

	local function addPathPoint(t, f, x, y, z)
		local n = #t.pf
		if n >= maxPathPoints then
			t.flags = setFlag(t.flags, 4)
			return
		end
		t.pf[n + 1], t.px[n + 1], t.py[n + 1], t.pz[n + 1] = f - t.birth, x, y, z
	end

	-- closeTrack ends a projectile track: kind 1 exploded (at x, y, z), 2
	-- vanished, 0 still flying when the game ended.
	local function closeTrack(t, frame, kind, x, y, z)
		tracks[t.id] = nil
		strategic[t.id] = nil
		if x == nil then
			x, y, z = t.lx, t.ly, t.lz
		end
		-- Interception, whichever of the two explosions the engine reported
		-- first: an interceptor whose target was this track exploded within a
		-- frame of it.
		local boom = boomAt[t.id]
		if boom ~= nil and frame - boom <= 1 and kind == 1 then
			t.flags = setFlag(t.flags, 2)
		end
		boomAt[t.id] = nil
		local n = pushRow({ birth = t.birth, fin = frame, id = t.id, wd = t.wd, owner = t.owner, team = t.team,
			cls = t.cls, kind = kind, flags = t.flags, x0 = t.x0, y0 = t.y0, z0 = t.z0,
			vx = t.vx, vy = t.vy, vz = t.vz, g = t.g, tt = t.tt, tg = t.tg, tx = t.tx, ty = t.ty, tz = t.tz,
			x1 = x, y1 = y, z1 = z, pf = t.pf, px = t.px, py = t.py, pz = t.pz })
		closedRow[t.id] = { buf = trackBuf, n = n, f = frame }
		if t.cls == CLS_ANTINUKE and t.tt == TGT_PROJ and t.tg ~= nil and kind == 1 then
			local victim = closedRow[t.tg]
			if victim ~= nil and victim.buf == trackBuf and frame - victim.f <= 1
				and victim.buf.k[victim.n] == 1 then
				victim.buf.fl[victim.n] = setFlag(victim.buf.fl[victim.n], 2)
			else
				boomAt[t.tg] = frame
			end
		end
	end

	-- openBeam starts (or returns, when it already started this frame) the beam
	-- record of one firing. A beam's first frame usually reaches the explosion
	-- callin before GameFramePost sees the weapon's reload change — the engine
	-- fires and traces in the same unit update — so either can open it.
	local function openBeam(owner, wdID, frame)
		local byWd = beamsOf[owner]
		local b = byWd and byWd[wdID]
		if b ~= nil and b.birth == frame then
			return b
		end
		if b ~= nil then
			b.untilF = frame - 1 -- superseded: expires at the next sweep
		end
		local info = nil
		local defID = spGetUnitDefID(owner)
		for _, s in ipairs((defID and slotsOfDef[defID]) or {}) do
			if s.wd == wdID then
				info = s
				break
			end
		end
		local x, y, z
		if info and spGetUnitWeaponVectors then
			x, y, z = spGetUnitWeaponVectors(owner, info.slot)
		end
		if x == nil then
			x, y, z = spGetUnitPosition(owner)
		end
		local tt, tg, tx, ty, tz = 0, nil, nil, nil, nil
		if info and spGetUnitWeaponTarget then
			local wt, _, target = spGetUnitWeaponTarget(owner, info.slot)
			tt = weaponTargetByte[wt or 0] or 0
			if type(target) == "table" then
				tx, ty, tz = target[1], target[2], target[3]
			elseif type(target) == "number" then
				tg = target
				if tt == TGT_UNIT then
					tx, ty, tz = spGetUnitPosition(target)
				end
			end
		end
		local window = info and info.window or (gameSpeed + 2)
		b = { owner = owner, wd = wdID, team = spGetUnitTeam(owner), birth = frame, untilF = frame + window,
			x0 = x, y0 = y, z0 = z, tt = tt, tg = tg, tx = tx, ty = ty, tz = tz, hits = 0, flags = 0,
			pf = {}, px = {}, py = {}, pz = {} }
		beamsOf[owner] = beamsOf[owner] or {}
		beamsOf[owner][wdID] = b
		beamList[#beamList + 1] = b
		return b
	end

	local function beamHit(b, frame, x, y, z, pid)
		if b.id == nil and pid ~= nil then
			b.id = pid
		end
		b.hits = b.hits + 1
		local n = #b.pf
		local keep = n == 0
		if not keep then
			local dx, dz = x - b.px[n], z - b.pz[n]
			keep = (frame - b.birth) - b.pf[n] >= beamPathEvery or dx * dx + dz * dz > beamPathJump2
		end
		if keep then
			addPathPoint(b, frame, x, y, z)
			b.lastKept = true
		else
			b.lastKept = false
		end
		b.lf, b.lx, b.ly, b.lz = frame, x, y, z
	end

	local function closeBeam(b)
		local byWd = beamsOf[b.owner]
		if byWd and byWd[b.wd] == b then
			byWd[b.wd] = nil
		end
		if b.hits > 0 and not b.lastKept then
			addPathPoint(b, b.lf, b.lx, b.ly, b.lz) -- the last hit is always kept
		end
		pushRow({ birth = b.birth, fin = b.lf or b.birth, id = b.id, wd = b.wd, owner = b.owner, team = b.team,
			cls = CLS_BEAM, kind = b.hits > 0 and 1 or 2, flags = b.flags, x0 = b.x0, y0 = b.y0, z0 = b.z0,
			vx = 0, vy = 0, vz = 0, g = 0, tt = b.tt, tg = b.tg, tx = b.tx, ty = b.ty, tz = b.tz,
			x1 = b.lx or b.x0, y1 = b.ly or b.y0, z1 = b.lz or b.z0,
			pf = b.pf, px = b.px, py = b.py, pz = b.pz })
	end

	local function addBlast(frame, wdID, x, y, z, unit, team, kind)
		local b = blastBuf
		local n = b.n + 1
		b.n = n
		b.df[n] = clamp(frame - projStart, 0, 65535)
		b.w[n] = id16(wdID)
		b.x[n], b.y[n], b.z[n] = s16(x), s16(y), s16(z)
		b.u[n], b.t[n], b.k[n] = id16(unit), team8(team), kind
		blastsSeen = blastsSeen + 1
	end

	-- onExplosion is the engine's Explosion callin for every watched weapon.
	-- A projectile id arrives as a number; "none" is the engine's -1u, which
	-- reaches Lua as 4294967295.
	local function onExplosion(wdID, px, py, pz, ownerID, projID)
		local frame = factFrame()
		local pid = nil
		if type(projID) == "number" and projID >= 0 and projID < 2147483648 then
			pid = projID
		end
		if pid ~= nil then
			local t = tracks[pid]
			if t ~= nil and t.wd == wdID then
				closeTrack(t, frame, 1, px, py, pz)
				return
			end
		end
		if trackClassOf[wdID] == CLS_BEAM and ownerID ~= nil then
			local b = beamsOf[ownerID] and beamsOf[ownerID][wdID]
			if b == nil or frame > b.untilF then
				b = openBeam(ownerID, wdID, frame) -- a new firing; an expired one closes next frame
			end
			beamHit(b, frame, px, py, pz, pid)
			return
		end
		if blastWeapon[wdID] and pid == nil then
			local team = dyingTeam[ownerID or -1]
			if team == nil and ownerID ~= nil then
				team = spGetUnitTeam(ownerID)
			end
			addBlast(frame, wdID, px, py, pz, ownerID, team, 1)
			return
		end
		if trackClassOf[wdID] or subWeapon[wdID] or blastWeapon[wdID] then
			addBlast(frame, wdID, px, py, pz, ownerID, ownerID and spGetUnitTeam(ownerID) or nil, 2)
		end
	end

	-- findLaunches picks the new projectiles of one firing out of the sphere
	-- around the weapon's muzzle: owned by the launcher, of the slot's weapon,
	-- and not already being tracked.
	local function findLaunches(unitID, team, info, frame)
		local x, y, z
		if spGetUnitWeaponVectors then
			x, y, z = spGetUnitWeaponVectors(unitID, info.slot)
		end
		if x == nil then
			x, y, z = spGetUnitPosition(unitID)
			if x == nil then
				return
			end
		end
		local ids = spGetProjectilesInSphere(x, y, z, info.radius, false, true)
		for i = 1, #(ids or {}) do
			local pid = ids[i]
			local t = tracks[pid]
			if not (t ~= nil and t.owner == unitID and t.wd == info.wd)
				and spGetProjectileOwnerID(pid) == unitID and spGetProjectileDefID(pid) == info.wd then
				if t ~= nil then
					closeTrack(t, frame, 2) -- the id was recycled under an open track
				end
				openTrack(pid, unitID, team, info, frame)
			end
		end
	end

	-- projectileFrame runs in GameFramePost: after the frame's unit and
	-- projectile updates, so a weapon that fired this frame has its new
	-- projectiles in the world and its reload frame moved.
	local function projectileFrame(frame)
		local t0 = hiResTimer and spGetTimer() or nil
		for unitID, L in pairs(launchers) do
			for _, s in ipairs(L.slots) do
				-- A weapon cannot fire before its reload frame: until then
				-- there is nothing to read (the cost here is per slot per
				-- frame, so this is most of it).
				local rf = (s.rf == nil or frame >= s.rf)
					and spGetUnitWeaponState(unitID, s.info.slot, "reloadFrame") or s.rf
				if rf ~= nil and rf ~= s.rf then
					s.rf = rf
					if rf > frame then -- a shot moves it into the future
						if s.info.cls == CLS_BEAM then
							openBeam(unitID, s.info.wd, frame)
						else
							s.untilF = frame + s.info.window
						end
					end
				end
				if s.untilF >= frame then
					findLaunches(unitID, L.team, s.info, frame)
				end
			end
		end
		if frame % strategicPathEvery == 0 then
			for pid, t in pairs(strategic) do
				if frame >= t.next then
					local x, y, z = spGetProjectilePosition(pid)
					if x ~= nil then
						addPathPoint(t, frame, x, y, z)
						t.lx, t.ly, t.lz = x, y, z
						t.next = frame + strategicPathEvery
					end
					if spGetProjectileIsIntercepted and spGetProjectileIsIntercepted(pid) then
						t.flags = setFlag(t.flags, 1)
					end
				end
			end
		end
		if frame % trackSweepEvery == 0 then
			local gone = {}
			for pid, t in pairs(tracks) do
				local x, y, z = spGetProjectilePosition(pid)
				if x == nil or spGetProjectileDefID(pid) ~= t.wd then
					gone[#gone + 1] = t
				else
					t.lx, t.ly, t.lz = x, y, z
				end
			end
			for i = 1, #gone do
				closeTrack(gone[i], frame, 2)
			end
		end
		if #beamList > 0 then
			local keep = {}
			for _, b in ipairs(beamList) do
				if frame > b.untilF then
					closeBeam(b)
				else
					keep[#keep + 1] = b
				end
			end
			beamList = keep
		end
		-- Interception bookkeeping only spans a frame.
		for pid, r in pairs(closedRow) do
			if frame - r.f > 1 then
				closedRow[pid] = nil
			end
		end
		for pid, f in pairs(boomAt) do
			if frame - f > 1 then
				boomAt[pid] = nil
			end
		end
		-- A unit's explosion follows its UnitDestroyed within the same frame.
		if next(dyingTeam) ~= nil then
			dyingTeam = {}
		end
		if t0 then
			frameMs = frameMs + spDiffTimers(spGetTimer(), t0, true)
		end
	end

	-- flushProjectiles writes the closed tracks and the blasts since the last
	-- sample (if any), then opens the next blast window at frame.
	local function flushProjectiles(frame)
		local b = trackBuf
		if b.n > 0 then
			local parts = {
				PackU32({ b.n }),
				PackU32(b.birth), PackU32(b.fin), PackU32(b.id),
				PackU16(b.w), PackU16(b.o), PackU8(b.t),
				PackU8(b.c), PackU8(b.k), PackU8(b.fl),
				PackS16(b.x0), PackS16(b.y0), PackS16(b.z0),
				PackF32(b.vx), PackF32(b.vy), PackF32(b.vz), PackF32(b.g),
				PackU8(b.tt), PackU32(b.tg),
				PackS16(b.tx), PackS16(b.ty), PackS16(b.tz),
				PackS16(b.x1), PackS16(b.y1), PackS16(b.z1),
				PackU16(b.np),
			}
			if b.pn > 0 then
				parts[#parts + 1] = PackU16(b.pf)
				parts[#parts + 1] = PackS16(b.px)
				parts[#parts + 1] = PackS16(b.py)
				parts[#parts + 1] = PackS16(b.pz)
			end
			writeRecord("R", table.concat(parts))
			trackBuf = newTrackBuf()
		end
		local e = blastBuf
		if e.n > 0 then
			writeRecord("W", table.concat({
				PackU32({ projStart }), PackU32({ e.n }),
				PackU16(e.df), PackU16(e.w),
				PackS16(e.x), PackS16(e.y), PackS16(e.z),
				PackU16(e.u), PackU8(e.t), PackU8(e.k),
			}))
			blastBuf = newBlastBuf()
		end
		if frame > projStart then
			projStart = frame
		end
	end

	-- closeAllTracks ends every open track and beam at game over.
	local function closeAllTracks(frame)
		local open = {}
		for _, t in pairs(tracks) do
			open[#open + 1] = t
		end
		table.sort(open, function(a, b) return a.id < b.id end)
		for _, t in ipairs(open) do
			closeTrack(t, frame, 0)
		end
		for _, b in ipairs(beamList) do
			closeBeam(b)
		end
		beamList = {}
	end

	-- Installing the Explosion callin. LuaUI may keep its own explosion watch
	-- list (Script.SetWatchExplosion; rts/Lua/LuaUI.cpp), but BAR's widget
	-- handler does not forward Explosion. UpdateCallIn assigns the top-level
	-- callin for any name outside its "flex" list as a closure over the
	-- handler's method of that name, once the handler has a list for it — the
	-- same handler access the damage hook uses. The callin returns nothing: a
	-- true return would suppress the engine's own graphics for the explosion.
	local explosionHooked = false
	local unhookExplosion = nil

	local function hookExplosion()
		local wh = widget.widgetHandler
		if not (wh and type(wh.UpdateCallIn) == "function" and Script and Script.SetWatchExplosion) then
			Echo(logTag .. " explosion callin unavailable; no projectile ends or blasts will be recorded")
			return
		end
		wh.ExplosionList = wh.ExplosionList or {}
		wh.Explosion = function(self, wdID, px, py, pz, ownerID, projID)
			pcall(onExplosion, wdID, px, py, pz, ownerID, projID)
		end
		wh:UpdateCallIn("Explosion")
		local n = 0
		for id in pairs(watchRole) do
			Script.SetWatchExplosion(id, true)
			n = n + 1
		end
		explosionHooked = true
		unhookExplosion = function()
			for id in pairs(watchRole) do
				pcall(Script.SetWatchExplosion, id, false)
			end
			-- Not nil: the handler's closure keeps calling this method.
			wh.Explosion = function() end
			explosionHooked = false
		end
		Echo(string.format("%s watching %d weapons for explosions (%d tracked, launchers on %d unit types)",
			logTag, n, nTracked, nLauncherDefs))
	end

	-- unitGone drops a dead unit's launcher and remembers its team for the
	-- explosion the engine makes right after UnitDestroyed.
	local function unitGone(unitID, team)
		launchers[unitID] = nil
		dyingTeam[unitID] = team
	end

	local function unitGiven(unitID, team)
		local L = launchers[unitID]
		if L then
			L.team = team
		end
	end

	-- stockChanged writes the stock fact for a tracked stockpiled weapon: a
	-- round finished (n > old) or fired (n < old).
	local function stockChanged(unitID, unitDefID, team, weaponNum, oldCount, newCount)
		for _, info in ipairs(slotsOfDef[unitDefID] or {}) do
			if info.slot == weaponNum then
				writeFact({ { "k", "stock" }, { "f", factFrame() }, { "unit", unitID }, { "def", unitDefID },
					{ "team", team }, { "w", weaponNum }, { "old", oldCount }, { "n", newCount } })
				return
			end
		end
	end

	local function summary()
		local slots = 0
		for _, L in pairs(launchers) do
			slots = slots + #L.slots
		end
		return string.format("%d launches tracked, %d tracks and beam firings closed, %d blasts; "
			.. "%.0f ms in GameFramePost, %d launcher slots at the end",
			launchesFound, tracksClosed, blastsSeen, frameMs, slots)
	end

	return {
		buildWatch = buildWatch,
		hookExplosion = hookExplosion,
		unhook = function()
			if unhookExplosion then
				unhookExplosion()
			end
		end,
		addLauncher = addLauncher,
		unitGone = unitGone,
		unitGiven = unitGiven,
		stockChanged = stockChanged,
		frame = projectileFrame,
		flush = flushProjectiles,
		closeAll = closeAllTracks,
		summary = summary,
	}
end)()

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

-- BAR's widget handler forwards UnitDamaged with only its first five
-- arguments (luaui/barwidgets.lua: widgetHandler:UnitDamaged(unitID,
-- unitDefID, unitTeam, damage, paralyzer)), so a widget is never told the
-- weapon or the attacker of a hit, although the engine passes both. The
-- handler's top-level callin is a closure over widgetHandler.UnitDamaged that
-- forwards everything the engine gave it, rebuilt by UpdateCallIn — so the
-- re-sim sampler (which has handler access) wraps that method, takes the full
-- arguments for itself, and then calls the original for every other widget.
-- Without handler access the widget's own callin still records the hits,
-- with every attacker unknown.
local damageHooked = false
local unhookDamage = nil

local function hookDamage()
	local wh = widget.widgetHandler
	if not (wh and type(wh.UnitDamaged) == "function" and type(wh.UpdateCallIn) == "function") then
		Echo(logTag .. " widget handler API unavailable; damage will name no attacker")
		return
	end
	local orig = wh.UnitDamaged
	wh.UnitDamaged = function(self, unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, projectileID, attackerID, attackerDefID, attackerTeam)
		pcall(recordHit, unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, projectileID, attackerID, attackerDefID, attackerTeam)
		return orig(self, unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, projectileID, attackerID, attackerDefID, attackerTeam)
	end
	damageHooked = true
	wh:UpdateCallIn("UnitDamaged")
	unhookDamage = function()
		wh.UnitDamaged = orig
		damageHooked = false
		pcall(wh.UpdateCallIn, wh, "UnitDamaged")
	end
end

if recordDamage then
	-- Defined only when recording: an unused UnitDamaged callin would still
	-- cost a Lua call per hit. It also keeps the handler's callin list
	-- non-empty, which is what makes UpdateCallIn install the hook above.
	function widget:UnitDamaged(unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, projectileID, attackerID, attackerDefID, attackerTeam)
		if damageHooked then
			return -- recorded by the hook, with the arguments BAR drops
		end
		pcall(recordHit, unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, projectileID, attackerID, attackerDefID, attackerTeam)
	end
end

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
	if resim and recordDamage then
		local hok, herr = pcall(hookDamage)
		if not hok then
			Echo(logTag .. " damage hook failed (" .. tostring(herr) .. "); damage will name no attacker")
		end
	end
	if recordProjectiles then
		-- Before the weapon table: the watched weapons' entries carry the
		-- protocol-5 keys, which need the watch list.
		local pok, perr = pcall(function()
			projectiles.buildWatch()
			projectiles.hookExplosion()
			for _, unitID in ipairs(spGetAllUnits()) do
				local _, _, _, _, build = spGetUnitHealth(unitID)
				if (build or 0) >= 1 then
					projectiles.addLauncher(unitID, spGetUnitDefID(unitID), spGetUnitTeam(unitID))
				end
			end
		end)
		if not pok then
			Echo(logTag .. " projectile recording failed to start (" .. tostring(perr) .. ")")
		end
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
		(resim and string.format(" in re-simulation mode (damage %s, visibility %s, projectiles %s, speed %d)",
			recordDamage and "on" or "off", recordVisibility and "on" or "off",
			recordProjectiles and "on" or "off", playbackSpeed) or "") ..
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
				hits, ends, hitStart = newHitBuf(), newEndBuf(), frame
			end
		end
		if recordProjectiles then
			local ok, err = pcall(projectiles.flush, frame)
			if not ok then
				Echo(logTag .. " projectile flush failed (" .. tostring(err) .. ")")
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
	pcall(event, "created", unitID, unitDefID, unitTeam)
end

function widget:UnitFinished(unitID, unitDefID, unitTeam)
	pcall(event, "finished", unitID, unitDefID, unitTeam)
	if recordProjectiles then
		pcall(projectiles.addLauncher, unitID, unitDefID, unitTeam)
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
		pcall(recordEnd, unitID, false)
	end
	if recordProjectiles then
		pcall(projectiles.unitGone, unitID, unitTeam)
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
	pcall(event, "given", unitID, unitDefID, newTeam, nil, nil, oldTeam or -1, nil)
	if recordProjectiles then
		pcall(projectiles.unitGiven, unitID, newTeam)
	end
end

if recordProjectiles then
	-- GameFramePost runs after the frame's unit and projectile updates: a
	-- weapon that fired this frame has moved its reload frame and its new
	-- projectiles are in the world. Defined only when recording, since it is
	-- a Lua call every sim frame.
	local projectileErrors = 0
	function widget:GameFramePost(frame)
		local ok, err = pcall(projectiles.frame, frame)
		if not ok then
			projectileErrors = projectileErrors + 1
			if projectileErrors <= 3 then
				Echo(logTag .. " projectile tracking failed at frame " .. frame .. " (" .. tostring(err) .. ")")
			end
		end
	end

	-- A stockpile count changed: a round built, or one fired.
	function widget:StockpileChanged(unitID, unitDefID, unitTeam, weaponNum, oldCount, newCount)
		pcall(projectiles.stockChanged, unitID, unitDefID, unitTeam, weaponNum, oldCount, newCount)
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
-- window, where every survivor stood, the engine's team statistics and
-- the profiler's final totals. Each part is guarded on its own — a failure
-- in one must not cost the others, nor the capture.
local function finishResim(frame)
	if recordDamage then
		local okLives, errLives = pcall(function()
			for _, unitID in ipairs(spGetAllUnits()) do
				recordEnd(unitID, true)
			end
			flushDamage(frame, true)
			Echo(logTag .. " damage: " .. dmgSeen .. " hits, " .. dmgNamedAttacker
				.. " naming an attacker, " .. dmgFromProjectile .. " more naming the projectile's shooter, "
				.. dmgNamedWeapon .. " naming a weapon, " .. dmgEngineCause .. " caused by the engine")
		end)
		if not okLives then
			Echo(logTag .. " final damage window / unit ends failed (" .. tostring(errLives) .. ")")
		end
	end
	if recordProjectiles then
		local okProj, errProj = pcall(function()
			projectiles.closeAll(frame)
			projectiles.flush(frame)
			Echo(logTag .. " projectiles: " .. projectiles.summary())
		end)
		if not okProj then
			Echo(logTag .. " closing the projectile tracks failed (" .. tostring(errProj) .. ")")
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
	if unhookDamage then
		unhookDamage()
	end
	pcall(projectiles.unhook)
	closeOut("shutdown")
end
