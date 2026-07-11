-- Replay uploader widget.
--
-- A player-installable variant of the BAR Replay Snapshotter (snapshot_widget.lua):
-- it runs during a LIVE game on a player's machine, samples the units the player
-- can legitimately see (their own ally team; everything when spectating with full
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
-- unique id: the engine delivers the 16-byte gameID via the widget:GameID callin
-- as a 32-char hex string — the same id stored in the .sdfz demo header and used
-- by api.bar-rts.com, so this capture self-correlates with the replay.
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
--        keyframeEvery-th sample is a keyframe.
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
local widgetVersion = "1.0.0"

function widget:GetInfo()
	return {
		name    = "Replay uploader",
		desc    = "Records unit snapshots of your team to <gameId>.brepstream for post-game replay visualization.",
		author  = "barreplay",
		version = widgetVersion,
		date    = "2026",
		license = "MIT",
		layer   = 0,
		enabled = true,
	}
end

-- Protocol version of the GAME line / capture stream semantics.
local protocolVersion = 2

-- Output format selection. writeBinary emits <gameId>.brepstream (the real
-- output); writeText additionally emits the legacy <gameId>.brsnap text stream
-- — the debug/reference format. Enable BOTH to validate the binary encoder
-- against the text one on a single real game (games are expensive to produce).
-- If the engine lacks VFS.Pack* the widget falls back to text automatically.
local writeBinary = true
local writeText = false

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

local Echo = Spring.Echo
local spGetAllUnits     = Spring.GetAllUnits
local spGetUnitPosition = Spring.GetUnitPosition
local spGetUnitDefID    = Spring.GetUnitDefID
local spGetUnitTeam     = Spring.GetUnitTeam
local spGetUnitHealth   = Spring.GetUnitHealth
local spGetUnitVelocity = Spring.GetUnitVelocity
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

local mathFloor = math.floor

-- Sim frames per game-second (30 in BAR); turns per-frame resource income into
-- a per-second rate.
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
-- Visibility filter. A playing client's Get* calls are LOS-gated: own ally team
-- is fully readable, enemies flicker in and out with wobbled radar positions
-- and nil defIDs. Recording those would poison the merged capture, so a player
-- records ONLY units of their own ally team; a full-view spectator (LOS-free)
-- records everything. Team->allyteam is static, built once in the preamble.

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

-- Reusable column buffers for the changed-unit list. Pack* reads the array
-- part [1..n]; n is tracked explicitly and stale tails are never packed
-- because a fresh table is sliced per pack call... instead we pass exact-size
-- tables: buffers are rebuilt each sample (a handful of table allocations, not
-- thousands of strings).

local function packFrameRecord(frame, keyframe, n, cid, cdef, cteam, cx, cz, chp, cmax, cdvx, cdvz, cb, dead, nR, rteam, rcols)
	local parts = {
		PackU32({ frame }),
		PackU8({ keyframe and 1 or 0 }),
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

	-- Text lines (writeText) and binary changed-columns (writeBinary) are
	-- filled in one pass so Spring.Get* runs once per unit either way.
	local ulines = writeText and {} or nil
	local n = 0
	local cid, cdef, cteam, cx, cz, chp, cmax, cdvx, cdvz, cb =
		{}, {}, {}, {}, {}, {}, {}, {}, {}, {}
	local recorded = 0

	for i = 1, total do
		local unitID = units[i]
		local team = spGetUnitTeam(unitID)
		if all or (team ~= nil and allyTeamOf[team] == myAllyTeam) then
			recorded = recorded + 1
			local x, y, z = spGetUnitPosition(unitID)
			local defID = spGetUnitDefID(unitID)
			local hp, maxHp, _, _, buildProgress = spGetUnitHealth(unitID)
			local vx, vy, vz = spGetUnitVelocity(unitID)
			if ulines then
				ulines[#ulines + 1] = string.format("BRSNAP U %d %d %d %.1f %.1f %.1f %.1f %.1f %.2f %.2f %.2f %.3f",
					unitID, defID or -1, team or -1, x or 0, y or 0, z or 0, hp or 0, maxHp or 0,
					vx or 0, vy or 0, vz or 0, buildProgress or 1)
			end
			if writeBinary then
				-- All quantization inlined: function calls dominate this loop's
				-- cost on Lua 5.1 (measured ~2x). floor(v+0.5) is fine for the
				-- occasional slightly-negative off-map coordinate too.
				local qx = mathFloor((x or 0) + 0.5)
				if qx > 32767 then qx = 32767 elseif qx < -32768 then qx = -32768 end
				local qz = mathFloor((z or 0) + 0.5)
				if qz > 32767 then qz = 32767 elseif qz < -32768 then qz = -32768 end
				local qhp = mathFloor((hp or 0) + 0.5)
				if qhp < 0 then qhp = 0 end
				local qmax = mathFloor((maxHp or 0) + 0.5)
				if qmax < 0 then qmax = 0 end
				local qdvx = mathFloor((vx or 0) * sampleEvery + 0.5)
				if qdvx > 32767 then qdvx = 32767 elseif qdvx < -32768 then qdvx = -32768 end
				local qdvz = mathFloor((vz or 0) * sampleEvery + 0.5)
				if qdvz > 32767 then qdvz = 32767 elseif qdvz < -32768 then qdvz = -32768 end
				local qb = mathFloor((buildProgress or 1) * 255 + 0.5)
				if qb > 255 then qb = 255 elseif qb < 0 then qb = 0 end
				local qdef = defID or 0
				if qdef > 65535 or qdef < 0 then qdef = 0 end
				local qteam = team or 0
				if qteam > 255 or qteam < 0 then qteam = 0 end
				local p = prev[unitID]
				if p ~= nil and not keyframe
					and p.dvx == qdvx and p.dvz == qdvz
					and p.x + qdvx == qx and p.z + qdvz == qz
					and p.hp == qhp and p.maxhp == qmax and p.b == qb
					and p.def == qdef and p.team == qteam then
					-- Fully predicted: costs zero bytes. Advance to what the
					-- decoder will compute.
					p.x, p.z, p.f = qx, qz, frame
				else
					n = n + 1
					cid[n], cdef[n], cteam[n] = unitID, qdef, qteam
					cx[n], cz[n], chp[n], cmax[n] = qx, qz, qhp, qmax
					cdvx[n], cdvz[n], cb[n] = qdvx, qdvz, qb
					if p == nil then
						prev[unitID] = { x = qx, z = qz, dvx = qdvx, dvz = qdvz,
							hp = qhp, maxhp = qmax, def = qdef, team = qteam, b = qb, f = frame }
					else
						p.x, p.z, p.dvx, p.dvz = qx, qz, qdvx, qdvz
						p.hp, p.maxhp, p.def, p.team, p.b, p.f = qhp, qmax, qdef, qteam, qb, frame
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
			rcols[5][nR], rcols[6][nR] = (mInc or 0) * gameSpeed, (eInc or 0) * gameSpeed
			if rlines then
				rlines[#rlines + 1] = string.format("BRSNAP R %d %.1f %.1f %.1f %.1f %.2f %.2f",
					teamID, m or 0, e or 0, mStore or 0, eStore or 0,
					(mInc or 0) * gameSpeed, (eInc or 0) * gameSpeed)
			end
		end
	end

	if ulines then
		writeChunk(string.format("BRSNAP F %d %.3f %d", frame, spGetGameSeconds(), recorded))
		writeChunk(table.concat(ulines, "\n"))
	end
	if writeBinary then
		writeRecord("F", packFrameRecord(frame, keyframe, n,
			cid, cdef, cteam, cx, cz, chp, cmax, cdvx, cdvz, cb, dead, nR, rteam, rcols))
	end
	flushOut() -- durable if the game/engine dies mid-match
	lastSampledFrame = frame
	lastSampleTime = elapsedStr(t0)
end

local function closeOut(reason)
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

function widget:GameFrame(frame)
	-- Loaded mid-game (disable/enable cycle or /luaui reload): the GameID
	-- callin is gone. Recover the id saved at disable time when it is
	-- provably this game's; else fall back to a wall-clock name rather than
	-- never writing anything.
	if not gameId then
		openOutputs(configGameID(frame) or fallbackGameID())
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

local function event(kind, unitID, defID, team)
	if not (recordAll() or (team ~= nil and allyTeamOf[team] == myAllyTeam)) then
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
	pcall(event, "created", unitID, unitDefID, unitTeam)
end

function widget:UnitFinished(unitID, unitDefID, unitTeam)
	pcall(event, "finished", unitID, unitDefID, unitTeam)
end

function widget:UnitDestroyed(unitID, unitDefID, unitTeam)
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
