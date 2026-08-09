-- Replay uploader widget.
--
-- A player-installable variant of the BAR Replay Snapshotter (snapshot_widget.lua):
-- it runs during a LIVE game on a player's machine, samples the units the player
-- can legitimately see (their own ally team fully; enemy units while in LOS or
-- radar — see recordEnemies below; everything when spectating with full
-- view), and records them to <write-dir>/<gameId>.brepstream — a compact binary
-- stream (columnar VFS.Pack* frames, keyframe + changed-units-only delta). The
-- legacy text stream (<gameId>.brsnap) is kept behind the writeText constant as
-- the debug/reference emitter; both can run in the same game, so one real game
-- validates the binary encoder against the battle-tested text one without
-- re-simulating anything. Eventually the binary chunks will be uploaded to a
-- remote ingest server and merged with other players' captures per gameId.
--
-- Unlike the snapshotter this widget is NOT injected or configured by the Go
-- tool: there are no __TOKEN__ substitutions, every knob is a constant below, so
-- one copy of the file works for every game. The output file name is the game's
-- unique id (32-hex, the same id stored in the .sdfz demo header and used by
-- api.bar-rts.com, so this capture self-correlates with the replay), obtained
-- from the "GameID" GameRulesParam that BAR's game_id.lua gadget publishes at
-- game start — BAR's widget handler does NOT forward the engine's GameID
-- callin to widgets, so the callin below is only a fallback for handlers that
-- do. Sampling starts into memory buffers immediately; files open the moment
-- the id resolves.
--
-- The widget is read-only (Get* calls and its own output files); it never issues
-- orders or mutates state. In a live game it must be a polite guest: no speed
-- commands, no spectatorfullview, no quitting, no touching other widgets, and
-- every callin body is pcall-guarded so an error can never unload it mid-game
-- (BAR's handler removes a widget whose callin raises) — after repeated sample
-- failures it closes its files and removes itself instead. The binary emitter
-- exists for the same reason: formatting ~2000 text lines cost ~7 ms inside a
-- single frame (measured), while filling number columns and packing them with a
-- few VFS.Pack* C calls costs well under 1 ms.
--
-- .brepstream layout (spec: docs/brepstream-format.md; decoder:
-- internal/capture/brep.go — the two must evolve in lockstep, versioned by the
-- header line):
--   line "BREPSTREAM 1"
--   text preamble, same grammar as .brsnap (BRSNAP GID/GAME/DEF/T/P lines),
--   terminated by "BRSNAP READY"
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
--     E  unit lifecycle event, text payload "<frame> <kind> <id> <def> <team>"
--     X  end of stream, text payload = reason (gameover|shutdown|error)
--
-- .brsnap text format (writeText; see internal/capture/capture.go): unchanged
-- from the snapshotter — GID/GAME/DEF/T/P/READY preamble then F/U/R/EV/END
-- lines. Unknown tags are ignored by the parser, so GID/GAME/END are backward
-- compatible.

-- Widget version (semver). Bump on any user-visible or wire-visible change;
-- it is reported in GetInfo, the load Echo, and the stream's GAME line, so
-- every capture records which encoder produced it (the copy on a player's
-- machine can be arbitrarily old — the server/decoder needs to know).
local widgetVersion = "1.4.0"

function widget:GetInfo()
	return {
		name    = "Replay uploader",
		desc    = "Records unit snapshots (your team + visible enemies) to <gameId>.brepstream for post-game replay visualization.",
		author  = "barreplay",
		version = widgetVersion,
		date    = "2026",
		license = "MIT",
		layer   = 0,
		enabled = true,
	}
end

-- Protocol version of the GAME line / capture stream semantics.
-- 3: resource income is written as the engine reports it (already per
--    game-second — GetTeamResources' income accumulates over
--    TEAM_SLOWUPDATE_RATE = 30 sim frames = 1 game-second). Protocol <= 2
--    widgets wrongly multiplied it by gameSpeed (30x too high); the decoder
--    repairs those streams by dividing it back out.
local protocolVersion = 3

-- Output format selection. writeBinary emits <gameId>.brepstream (the real
-- output); writeText additionally emits the legacy <gameId>.brsnap text stream
-- — the debug/reference format. Enable BOTH to validate the binary encoder
-- against the text one on a single real game (games are expensive to produce).
-- If the engine lacks VFS.Pack* the widget falls back to text automatically.
local writeBinary = true
local writeText = false

-- Enemy recording: units of other ally teams are recorded while visible (in
-- LOS or on radar — Spring.GetAllUnits already returns only what this client
-- can see, so the engine is the visibility filter). A previously seen enemy
-- that drops out of visibility is NOT marked dead: it stays in the stream as
-- an immobile "ghost" frozen at its last-known state (velocity zero) until it
-- is seen again, seen dying, or its last-known spot is OBSERVED EMPTY: when
-- the ghost's position comes back into LOS while the unit is absent from
-- GetAllUnits, the player is looking at bare ground where the ghost stands —
-- the engine's own ghost-building rule — so the ghost is dropped (see the
-- ghost pass; the checks are budgeted, ghostLosChecksPerSample). A death the
-- player could see buries the unit for good — whether it arrived as a
-- UnitDestroyed callin or simply as a health read of 0 — even though the
-- engine may keep returning its id from GetAllUnits afterwards, as a stale
-- frozen radar-memory dot or as the killed unit itself, still undeleted while
-- its death sequence runs (see buried and unburied below). A unit that dies
-- unseen in fog nobody revisits remains a ghost — the capture shows what
-- this player knew.
-- Radar-only contacts are recorded immediately: their position is the
-- engine's wobbled radar reading, and unreadable columns fall back to the
-- last-known value (def 0 = never identified). false restores the pre-1.1
-- own-ally-team-only behavior.
local recordEnemies = true

-- Sampling interval in sim frames (30 = 1 Hz at BAR's 30 fps sim). A constant:
-- every uploader in a game must sample at the same frames (frame % sampleEvery
-- == 0) so the server can merge streams by exact frame number.
local sampleEvery = 30

-- Samples per keyframe (64 ≈ one keyframe per minute at 1 Hz, matching the
-- .brp chunk size). A keyframe re-states every unit absolutely and resets the
-- delta predictor, bounding both crash loss and any decoder drift.
local keyframeEvery = 64

-- Heartbeat interval in sim frames (~10s of game time): a small infolog line
-- proving the widget is alive and how cheap each sample was.
local heartbeatEvery = 300

-- Ghost scout-check budget per sample. Visibility is per UNIT, not per
-- position: if a ghost's unit were alive anywhere in sensor range it would be
-- in GetAllUnits by its id — so the ghost's only remaining claim is "it is
-- still standing at (x, z), which I cannot see". The moment that spot is in
-- LOS while the id stays absent, the claim is disproven by observation and
-- the ghost is dropped. To keep the widget's frame cost bounded no matter how
-- many ghosts accumulate, at most this many ghosts pay the two C calls
-- (GetGroundHeight + IsPosInLos) per sample, round-robin over the sorted
-- ghost ids — at 64 checks and ~300 ghosts every ghost is re-visited about
-- every 5 samples, so a scouted ghost disappears within a few seconds.
local ghostLosChecksPerSample = 64

local Echo = Spring.Echo
local spGetAllUnits     = Spring.GetAllUnits
local spGetUnitPosition = Spring.GetUnitPosition
local spGetUnitDefID    = Spring.GetUnitDefID
local spGetUnitTeam     = Spring.GetUnitTeam
local spGetUnitHealth   = Spring.GetUnitHealth
local spGetUnitIsDead   = Spring.GetUnitIsDead -- may be absent on old engines
local spGetUnitVelocity = Spring.GetUnitVelocity
local spGetUnitIsBuilding = Spring.GetUnitIsBuilding
local spIsPosInLos      = Spring.IsPosInLos -- may be absent on old engines
local spGetGroundHeight = Spring.GetGroundHeight
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
-- Initialize; without it the widget falls back to the text emitter.

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
-- Output files. The gameId arrives via widget:GameID (at game start), which may
-- be after Initialize, so everything produced before the files can be opened is
-- buffered (text lines and binary records separately) and drained the moment
-- they open. Spring's LuaIO sandbox rejects absolute paths, so paths are
-- relative to the engine write-dir: "<gameId>.brsnap" / "<gameId>.brepstream"
-- land in the data directory.

local gameId = nil      -- 32-hex-char game id (nil until widget:GameID fires)
local tout = nil        -- text output handle (writeText)
local bout = nil        -- binary output handle (writeBinary)
local pendingText = {}  -- text lines buffered before open (nil once open/failed)
local pendingBin = {}   -- binary byte-strings buffered before open

-- Config persistence (widget:Get/SetConfigData): BAR's handler saves this on
-- disable/shutdown and hands it back when the widget is re-enabled. The GameID
-- callin fires only once at game start, so a re-enabled widget recovers the id
-- from here (guarded, since the config also survives across games).
local savedConfig = nil
local lastSampledFrame = 0
local gameEnded = false

-- writeChunk appends s plus a newline to the text stream (buffer or file).
local function writeChunk(s)
	if tout then
		tout:write(s, "\n")
	elseif pendingText then
		pendingText[#pendingText + 1] = s
	end
end

-- writeRecord appends one framed binary record to the binary stream.
local function writeRecord(tag, payload)
	if not (writeBinary and (bout or pendingBin)) then
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
	if tout then
		tout:flush()
	end
	if bout then
		bout:flush()
	end
end

-- preambleStr is built at Initialize and written into both streams when they
-- open (the binary stream keeps the same human-readable text head).
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

-- fallbackGameID names the files when the GameID callin never fired (e.g. the
-- widget was loaded/reloaded mid-game, after the callin). Wall-clock based, so
-- it cannot collide with a real 32-hex id.
local function fallbackGameID()
	local ok, stamp = pcall(os.date, "%Y%m%d_%H%M%S")
	if not ok or type(stamp) ~= "string" then
		stamp = tostring(mathFloor((os.clock() or 0) * 1000))
	end
	return "unknown_" .. stamp
end

-- openOutputs opens the enabled output files and drains the pre-gameId buffers.
--
-- Open mode depends on when in the game this happens. Near frame 0 (game
-- start, or a crashed player REJOINING — the rejoin re-simulates the whole
-- game from the beginning, so the widget re-records everything) any existing
-- <gameId> file is stale or superseded: TRUNCATE. Mid-game (the player
-- re-enabled the widget, or enabled it late) the existing file holds the only
-- copy of the earlier part of the game: APPEND a fresh self-contained segment
-- (header + preamble + records; the decoder treats a "BREPSTREAM 1" line
-- between records as a segment restart). Frames only move forward within a
-- process, so appended segments never overlap the ones before them.
local function openOutputs(id)
	if gameId then
		return
	end
	gameId = id
	local frame = (spGetGameFrame and spGetGameFrame()) or 0
	local append = frame > sampleEvery
	local head = "BRSNAP GID " .. id .. "\n" .. (preambleStr or "")
	if writeText then
		local path = id .. ".brsnap"
		tout = io.open(path, append and "a" or "w")
		if tout then
			tout:write(head)
			if pendingText and #pendingText > 0 then
				tout:write(table.concat(pendingText, "\n"), "\n")
			end
			Echo("[replay-uploader] recording text to " .. path .. (append and " (appending)" or ""))
		else
			Echo("[replay-uploader] ERROR: could not open " .. path)
		end
	end
	pendingText = nil
	if writeBinary then
		local path = id .. ".brepstream"
		bout = io.open(path, append and "ab" or "wb")
		if bout then
			bout:write("BREPSTREAM 1\n", head)
			for i = 1, #pendingBin do
				bout:write(pendingBin[i])
			end
			Echo(string.format("[replay-uploader] recording binary to %s%s (sampling every %d frames, keyframe every %d samples)",
				path, append and " (appending)" or "", sampleEvery, keyframeEvery))
		else
			Echo("[replay-uploader] ERROR: could not open " .. path)
		end
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

-- jsonObject encodes { {key, value}, ... } pairs in order, skipping nils.
local function jsonObject(fields)
	local parts = {}
	for _, kv in ipairs(fields) do
		if kv[2] ~= nil then
			parts[#parts + 1] = '"' .. kv[1] .. '":' .. jsonValue(kv[2])
		end
	end
	return "{" .. table.concat(parts, ",") .. "}"
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
	})
end

-- ---------------------------------------------------------------------------
-- Visibility. A playing client's Get* calls are LOS-gated: the own ally team
-- is fully readable; enemies flicker in and out of GetAllUnits with wobbled
-- radar positions and nil defIDs (until identified). With recordEnemies the
-- widget records enemies exactly as this client perceives them and freezes
-- them as ghosts when they vanish (see the flag comment above); with it off, a
-- player records ONLY units of their own ally team. A full-view spectator
-- (LOS-free) always records everything — and there absence from GetAllUnits
-- means the unit really died, so the ghost machinery is bypassed.
-- Team->allyteam is static, built once in the preamble.

local allyTeamOf = {} -- teamID -> allyTeam
local myAllyTeam = -1

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

-- Last-known QUANTIZED state of every enemy unit sampled (the ghost source,
-- recordEnemies only). Unlike prev this survives the keyframe prev = {} reset
-- — ghosts must be restated in every keyframe or the decoder drops them.
-- g.f = sim frame the unit was last seen live. Entries are removed on a
-- witnessed UnitDestroyed, when the id reappears as a non-enemy unit (the
-- engine reuses unit ids), and wholesale under full view (absence = death).
local ghosts = {}

-- Round-robin watermark for the ghost scout checks (see
-- ghostLosChecksPerSample): the last ghost id checked, so each sample resumes
-- where the previous one stopped. An id watermark (not an array index) stays
-- stable as ghosts come and go between samples.
local losCursor = -1

-- Wire team is u8 and 0 is a real team id, so an unknown team must not map to
-- 0 (it would paint the unit as the recording player's). Real ids are 0..254.
local unknownTeam = 255

-- Tombstones for witnessed deaths: buried[unitID] = {x, z, def, team}, the
-- dead unit's last-known fingerprint. Needed because the engine can KEEP
-- RETURNING a dead enemy's id from GetAllUnits — a frozen radar-memory dot
-- (or briefly the corpse) survives a death the player did not see in LOS —
-- which would resurrect the ghost right after UnitDestroyed removed it
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
-- a morph/Spring.DestroyUnit kills it outright at full health), so the very
-- next sample can still read it out of GetAllUnits — with health 0, or even
-- intact. Trusting that read cleared the tombstone and re-ghosted the corpse
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
-- Sampling. The body is pcall-guarded from widget:GameFrame; after a few
-- consecutive failures the widget closes its files and removes itself rather
-- than risk degrading a live game.

local lastSampleTime = nil
local lastUnitCount = 0

local function sample(frame)
	local t0 = startClock()
	local all = recordAll()
	local units = spGetAllUnits()
	local total = #units

	local keyframe = false
	if writeBinary then
		keyframe = (sampleIdx % keyframeEvery == 0)
		sampleIdx = sampleIdx + 1
		if keyframe then
			prev = {} -- decoder state resets at a keyframe; mirror it
		end
	end

	-- Under full view absence from GetAllUnits means the unit really died, so
	-- ghost persistence must not apply. Also covers a player who died/resigned
	-- into full view mid-game: their accumulated ghosts either reappear live
	-- below or age into the dead list.
	if all and next(ghosts) ~= nil then
		ghosts = {}
	end

	-- Text lines (writeText) and binary changed-columns (writeBinary) are
	-- filled in one pass so Spring.Get* runs once per unit either way.
	local ulines = writeText and {} or nil
	local n = 0
	local cid, cdef, cteam, cx, cz, chp, cmax, cdvx, cdvz, cb, ct =
		{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}
	local recorded = 0

	for i = 1, total do
		local unitID = units[i]
		local team = spGetUnitTeam(unitID)
		local isAlly = (team ~= nil and allyTeamOf[team] == myAllyTeam)
		if (all or isAlly or recordEnemies)
			and (buried[unitID] == nil or unburied(unitID, team)) then
			local isEnemy = recordEnemies and not all and not isAlly
			local g = isEnemy and ghosts[unitID] or nil
			local x, y, z = spGetUnitPosition(unitID)
			local defID = spGetUnitDefID(unitID)
			local hp, maxHp, _, _, buildProgress = spGetUnitHealth(unitID)
			if hp ~= nil and hp <= 0 then
				-- Readable but dead: the engine still holds a killed unit for its
				-- death sequence. Bury it here rather than waiting for the
				-- UnitDestroyed callin — which may already have fired (the sample
				-- lands inside the death window) or may never fire at all (the
				-- widget was reloaded across it). Recording it would freeze a
				-- 0 hp ghost into every later frame; the stale prev entry instead
				-- puts the id on this frame's dead list. See unburied above.
				buried[unitID] = { x = x, z = z, def = defID, team = team }
				ghosts[unitID] = nil
			else
				local vx, vy, vz = spGetUnitVelocity(unitID)
				-- Build/assist/repair target (nil for non-builders, idle
				-- builders, and units the widget cannot read).
				local tgt = spGetUnitIsBuilding ~= nil and spGetUnitIsBuilding(unitID) or nil
				recorded = recorded + 1
				-- Radar-only enemies read back nils (def/health unreadable, the
				-- position wobbled): carry the last-known identity/health from the
				-- ghost entry so a typed unit does not degrade to an untyped blip.
				-- Both emitters use these effective values — the fixture test
				-- cross-checks def/team between the two streams EXACTLY.
				local edef = defID or (g and g.def) or 0
				local eteam = team or (g and g.team) or (isEnemy and unknownTeam or 0)
				local ehp, emaxHp, ebuild
				if hp == nil and g ~= nil then
					ehp, emaxHp, ebuild = g.hp, g.maxhp, g.b / 255
				else
					ehp, emaxHp, ebuild = hp or 0, maxHp or 0, buildProgress or 1
				end
				if ulines then
					ulines[#ulines + 1] = string.format("BRSNAP U %d %d %d %.1f %.1f %.1f %.1f %.1f %.2f %.2f %.2f %.3f %d",
						unitID, edef, eteam, x or 0, y or 0, z or 0, ehp, emaxHp,
						vx or 0, vy or 0, vz or 0, ebuild, tgt or 0)
				end
				if not isEnemy and recordEnemies and ghosts[unitID] ~= nil then
					ghosts[unitID] = nil -- the engine reused a ghost's id for a non-enemy unit
				end
				-- Quantization also runs for enemies in the text-only fallback:
				-- the ghost table stores quantized values so ghost emission is
				-- identical in both formats.
				if writeBinary or isEnemy then
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
						-- g.c = frame of the last OBSERVED state change (new
						-- contact, movement, wobble, damage, identification).
						-- State can only change while the unit is visible, so
						-- a ghost's g.c is final — the scout check reads it to
						-- give freshly-changed units a sample of grace.
						if g == nil then
							g = { c = frame }
							ghosts[unitID] = g
						elseif g.x ~= qx or g.z ~= qz or g.hp ~= qhp
							or g.maxhp ~= qmax or g.def ~= qdef
							or g.team ~= qteam or g.b ~= qb then
							g.c = frame
						end
						g.x, g.z, g.hp, g.maxhp = qx, qz, qhp, qmax
						g.def, g.team, g.b, g.f = qdef, qteam, qb, frame
					end
					if writeBinary then
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
					end
				end
			end
		end
	end

	-- Ghost pass: enemies previously seen but absent from GetAllUnits this
	-- sample stay in the stream frozen at their last-known state with zero
	-- velocity. The sample a unit vanishes on emits one changed record (its
	-- prediction still carried the last live velocity); after that a ghost is
	-- fully predicted and costs zero bytes per delta frame, and every keyframe
	-- restates it absolutely (prev was reset, so p == nil). Sorted ids keep
	-- both emitters deterministic.
	if recordEnemies and not all then
		local gids = {}
		for id, g in pairs(ghosts) do
			if g.f ~= frame then
				gids[#gids + 1] = id
			end
		end
		table.sort(gids)
		-- Scout check (budgeted, see ghostLosChecksPerSample): a ghost whose
		-- spot is back in LOS while its id is absent from GetAllUnits is
		-- observably not there — drop it. The stale prev entry then puts the
		-- id on this frame's dead list, exactly like a witnessed death; no
		-- destroyed event is written (no death was seen — the unit may be
		-- alive elsewhere, and if re-spotted it is simply recorded afresh).
		-- A ghost whose unit changed state as recently as the previous
		-- sample (g.c) is skipped for free: it was in flux moments ago —
		-- typically it just walked out of view, with its last-known spot
		-- still inside LOS — so it gets one sample of grace before its spot
		-- can disprove it. The lap is bounded to one pass over gids; only
		-- actual IsPosInLos probes spend budget.
		if spIsPosInLos ~= nil and #gids > 0 then
			local budget = ghostLosChecksPerSample
			local start = 1
			for k = 1, #gids do
				if gids[k] > losCursor then
					start = k
					break
				end
			end
			for step = 0, #gids - 1 do
				if budget <= 0 then
					break
				end
				local id = gids[(start + step - 1) % #gids + 1]
				local g = ghosts[id]
				if frame - (g.c or 0) > sampleEvery then
					budget = budget - 1
					local gy = spGetGroundHeight ~= nil and spGetGroundHeight(g.x, g.z) or 0
					if spIsPosInLos(g.x, gy or 0, g.z) then
						ghosts[id] = nil
					end
				end
				losCursor = id
			end
		end
		for k = 1, #gids do
			local id = gids[k]
			local g = ghosts[id]
			if g ~= nil then
				recorded = recorded + 1
				if ulines then
					ulines[#ulines + 1] = string.format("BRSNAP U %d %d %d %.1f %.1f %.1f %.1f %.1f %.2f %.2f %.2f %.3f %d",
						id, g.def, g.team, g.x, 0, g.z, g.hp, g.maxhp, 0, 0, 0, g.b / 255, 0)
				end
				if writeBinary then
					local p = prev[id]
					if p ~= nil and not keyframe
						and p.dvx == 0 and p.dvz == 0
						and p.x == g.x and p.z == g.z
						and p.hp == g.hp and p.maxhp == g.maxhp and p.b == g.b
						and p.def == g.def and p.team == g.team and (p.t or 0) == 0 then
						p.f = frame -- fully predicted (dv = 0): zero bytes
					else
						n = n + 1
						cid[n], cdef[n], cteam[n] = id, g.def, g.team
						cx[n], cz[n], chp[n], cmax[n] = g.x, g.z, g.hp, g.maxhp
						cdvx[n], cdvz[n], cb[n], ct[n] = 0, 0, g.b, 0
						if p == nil then
							prev[id] = { x = g.x, z = g.z, dvx = 0, dvz = 0,
								hp = g.hp, maxhp = g.maxhp, def = g.def, team = g.team, b = g.b, t = 0, f = frame }
						else
							p.x, p.z, p.dvx, p.dvz = g.x, g.z, 0, 0
							p.hp, p.maxhp, p.def, p.team, p.b, p.t, p.f = g.hp, g.maxhp, g.def, g.team, g.b, 0, frame
						end
					end
				end
			end
		end
	end
	lastUnitCount = recorded

	-- Dead list: every predictor entry not seen this sample. (After a keyframe
	-- reset there are no stale entries by construction.)
	local dead = {}
	if writeBinary and not keyframe then
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
	local rlines = ulines
	for _, teamID in ipairs(spGetTeamList()) do
		local m, mStore, _, mInc = spGetTeamResources(teamID, "metal")
		if m ~= nil then
			local e, eStore, _, eInc = spGetTeamResources(teamID, "energy")
			nR = nR + 1
			rteam[nR] = clamp(teamID, 0, 255)
			rcols[1][nR], rcols[2][nR] = m or 0, e or 0
			rcols[3][nR], rcols[4][nR] = mStore or 0, eStore or 0
			rcols[5][nR], rcols[6][nR] = mInc or 0, eInc or 0
			if rlines then
				rlines[#rlines + 1] = string.format("BRSNAP R %d %.1f %.1f %.1f %.1f %.2f %.2f",
					teamID, m or 0, e or 0, mStore or 0, eStore or 0,
					mInc or 0, eInc or 0)
			end
		end
	end

	if ulines then
		writeChunk(string.format("BRSNAP F %d %.3f %d", frame, spGetGameSeconds(), recorded))
		writeChunk(table.concat(ulines, "\n"))
	end
	if writeBinary then
		writeRecord("F", packFrameRecord(frame, keyframe, n,
			cid, cdef, cteam, cx, cz, chp, cmax, cdvx, cdvz, cb, ct, dead, nR, rteam, rcols))
	end
	flushOut() -- durable if the game/engine dies mid-match
	lastSampledFrame = frame
	lastSampleTime = elapsedStr(t0)
end

local function closeOut(reason)
	-- Samples were buffered but no id ever resolved and the grace period had
	-- not expired (e.g. the player quit early): save them under a fallback
	-- name rather than dropping them.
	if not gameId and ((pendingBin and #pendingBin > 0) or (pendingText and #pendingText > 0)) then
		openOutputs(fallbackGameID())
	end
	if reason and (tout or bout) then
		if tout then
			writeChunk("BRSNAP END " .. reason)
		end
		writeRecord("X", reason)
	end
	if tout then
		tout:flush()
		tout:close()
		tout = nil
	end
	if bout then
		bout:flush()
		bout:close()
		bout = nil
	end
	pendingText, pendingBin = nil, nil
end

local sampleFailures = 0

local function removeSelf()
	closeOut("error")
	if widgetHandler and widgetHandler.RemoveWidget then
		widgetHandler:RemoveWidget(widget)
	end
end

-- ---------------------------------------------------------------------------
-- Callins.

function widget:Initialize()
	myAllyTeam = (spGetMyAllyTeamID and spGetMyAllyTeamID()) or -1
	if writeBinary and not detectPack() then
		Echo("[replay-uploader] VFS.Pack* unavailable; falling back to text output")
		writeBinary = false
		writeText = true
	end
	local ok, err = pcall(function() preambleStr = buildPreamble() end)
	if not ok then
		Echo("[replay-uploader] preamble failed (" .. tostring(err) .. "); removing widget")
		removeSelf()
		return
	end
	Echo("[replay-uploader] v" .. widgetVersion .. " loaded (" ..
		(writeBinary and writeText and "binary+text" or writeBinary and "binary" or "text") ..
		"); waiting for gameId (GameID callin)")
end

function widget:GameID(id)
	local hex = normalizeGameID(id)
	if hex then
		openOutputs(hex)
	else
		Echo("[replay-uploader] unrecognized GameID value; using fallback file name")
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

function widget:GameFrame(frame)
	-- The gameId is usually not known at Initialize (the GameID callin fires
	-- ~game start, the rules param appears just after). Sampling starts
	-- immediately into the pre-open buffers; the files open the moment a
	-- source resolves, and only after a grace period under a fallback name.
	if not gameId then
		local id = resolveGameID(frame)
		if id then
			openOutputs(id)
		elseif unresolvedSamples >= fallbackAfterSamples then
			Echo("[replay-uploader] no game id after " .. unresolvedSamples .. " samples; using fallback file name")
			openOutputs(fallbackGameID())
		elseif frame % sampleEvery == 0 then
			unresolvedSamples = unresolvedSamples + 1
		end
	end
	local beat = (frame % heartbeatEvery == 0)
	if frame % sampleEvery == 0 then
		local ok, err = pcall(sample, frame)
		if ok then
			sampleFailures = 0
		else
			sampleFailures = sampleFailures + 1
			Echo("[replay-uploader] sample failed (" .. tostring(err) .. ")")
			if sampleFailures >= 3 then
				Echo("[replay-uploader] 3 consecutive failures; disabling")
				removeSelf()
				return
			end
		end
	end
	if beat then
		local line = string.format("[replay-uploader] heartbeat frame=%d t=%.0fs units=%d",
			frame, spGetGameSeconds(), lastUnitCount)
		if lastSampleTime then
			line = line .. " sample_time=" .. lastSampleTime
		end
		Echo(line)
	end
end

-- Lifecycle events. The engine only fires these callins for units this client
-- can see, so with recordEnemies on no extra filtering is needed.
local function event(kind, unitID, defID, team)
	if not (recordAll() or recordEnemies or (team ~= nil and allyTeamOf[team] == myAllyTeam)) then
		return
	end
	local frame = spGetGameFrame()
	if tout or (writeText and pendingText) then
		writeChunk(string.format("BRSNAP EV %d %s %d %d %d",
			frame, kind, unitID, defID or -1, team or -1))
	end
	writeRecord("E", string.format("%d %s %d %d %d", frame, kind, unitID, defID or -1, team or -1))
end

function widget:UnitCreated(unitID, unitDefID, unitTeam)
	buried[unitID] = nil -- a new unit definitely owns this recycled id now
	pcall(event, "created", unitID, unitDefID, unitTeam)
end

function widget:UnitFinished(unitID, unitDefID, unitTeam)
	pcall(event, "finished", unitID, unitDefID, unitTeam)
end

function widget:UnitDestroyed(unitID, unitDefID, unitTeam)
	-- A death in view buries the ghost AND tombstones the id — the engine may
	-- keep returning it from GetAllUnits (stale radar-memory dot / lingering
	-- corpse), which must not resurrect the unit. The next sample finds the
	-- prev entry unrefreshed and emits the id on the dead list. A death out
	-- of view never fires this callin, so that ghost persists — by design.
	local src = ghosts[unitID] or prev[unitID]
	local tx, tz
	if src ~= nil then
		tx, tz = src.x, src.z
	else
		local x, _, z = spGetUnitPosition(unitID)
		tx, tz = x, z
	end
	buried[unitID] = { x = tx, z = tz, def = unitDefID, team = unitTeam }
	ghosts[unitID] = nil
	pcall(event, "destroyed", unitID, unitDefID, unitTeam)
end

function widget:GameOver()
	Echo("[replay-uploader] game over; capture complete" .. (gameId and (": " .. gameId) or ""))
	gameEnded = true
	closeOut("gameover")
end

-- Shutdown fires on engine teardown (or widget removal) even if GameOver did
-- not — e.g. the player quits mid-game; keep the partial capture.
function widget:Shutdown()
	closeOut("shutdown")
end
