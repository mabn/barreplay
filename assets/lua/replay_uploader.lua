-- Replay uploader widget.
--
-- A player-installable variant of the BAR Replay Snapshotter (snapshot_widget.lua):
-- it runs during a LIVE game on a player's machine, samples the units the player
-- can legitimately see (their own ally team; everything when spectating with full
-- view), and writes the same BRSNAP tagged-line stream to
-- <write-dir>/<gameId>.brsnap. Eventually the file contents will be uploaded to a
-- remote ingest server and merged with other players' captures per gameId; for
-- now it only writes the local file.
--
-- Unlike the snapshotter this widget is NOT injected or configured by the Go
-- tool: there are no __TOKEN__ substitutions, every knob is a constant below, so
-- one copy of the file works for every game. The output file name is the game's
-- unique id: the engine delivers the 16-byte gameID via the widget:GameID callin
-- as a 32-char hex string — the same id stored in the .sdfz demo header and used
-- by api.bar-rts.com, so this capture self-correlates with the replay.
--
-- The widget is read-only (Get* calls and its own output file); it never issues
-- orders or mutates state. In a live game it must be a polite guest: no speed
-- commands, no spectatorfullview, no quitting, no touching other widgets, and
-- every callin body is pcall-guarded so an error can never unload it mid-game
-- (BAR's handler removes a widget whose callin raises) — after repeated sample
-- failures it closes the file and removes itself instead.
--
-- File format (see internal/capture/capture.go; unknown tags are ignored by the
-- parser, so the extra GAME/END lines are backward compatible):
--   BRSNAP GID <gameId>                        written first, when the id arrives
--   BRSNAP GAME <json>                         capture context: map, versions,
--                                              recording player (preamble)
--   BRSNAP DEF <json>                          full unit-def (JSON; preamble)
--   BRSNAP T <teamID> <allyTeam> <side> <color>   team info (side "_" = none)
--   BRSNAP P <playerID> <team> <spectator> <name...>   player info (preamble)
--   BRSNAP READY                               end of preamble
--   BRSNAP F <frame> <timeSec> <count>
--   BRSNAP U <id> <def> <team> <x> <y> <z> <hp> <maxHp> <vx> <vy> <vz> <build>
--   BRSNAP R <teamID> <metal> <energy> <mStore> <eStore> <mIncome> <eIncome>
--   BRSNAP EV <frame> <kind> <id> <def> <team>
--   BRSNAP END <reason>                        stream terminator (gameover|shutdown)

function widget:GetInfo()
	return {
		name    = "Replay uploader",
		desc    = "Records unit snapshots of your team to <gameId>.brsnap for post-game replay visualization.",
		author  = "barreplay",
		date    = "2026",
		license = "MIT",
		layer   = 0,
		enabled = true,
	}
end

-- Protocol version of the GAME line / live-capture stream.
local protocolVersion = 2

-- Sampling interval in sim frames (30 = 1 Hz at BAR's 30 fps sim). A constant:
-- every uploader in a game must sample at the same frames (frame % sampleEvery
-- == 0) so the server can merge streams by exact frame number.
local sampleEvery = 30

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
-- Output file. The gameId arrives via widget:GameID (at game start), which may
-- be after Initialize, so preamble lines written before the file can be opened
-- are buffered in `pending` and flushed the moment the file opens. Spring's
-- LuaIO sandbox rejects absolute paths, so the path is relative to the engine
-- write-dir: "<gameId>.brsnap" lands in the data directory.

local out = nil        -- open file handle, nil until the gameId is known
local pending = {}     -- lines buffered before the file is open
local gameId = nil     -- 32-hex-char game id (nil until widget:GameID fires)

local function writeChunk(s)
	if out then
		out:write(s, "\n")
	elseif pending then
		pending[#pending + 1] = s
	end
end

local function flushOut()
	if out then
		out:flush()
	end
end

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
		stamp = tostring(math.floor((os.clock() or 0) * 1000))
	end
	return "unknown_" .. stamp
end

-- openOutput opens <gameId>.brsnap in the write-dir and drains the preamble
-- buffered before the id was known.
local function openOutput(id)
	if out then
		return
	end
	gameId = id
	local path = id .. ".brsnap"
	out = io.open(path, "w")
	if not out then
		Echo("[replay-uploader] ERROR: could not open output file: " .. path)
		pending = nil -- stop buffering; nothing will ever consume it
		return
	end
	-- The GAME preamble line was serialized before the id was known (GameID
	-- fires after Initialize), so the id gets its own line, always first.
	out:write("BRSNAP GID ", id, "\n")
	if pending and #pending > 0 then
		out:write(table.concat(pending, "\n"), "\n")
	end
	pending = nil
	flushOut()
	Echo(string.format("[replay-uploader] recording to %s (sampling every %d frames)", path, sampleEvery))
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
		if v == math.floor(v) and math.abs(v) < 1e15 then
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

-- recordAll returns true when every unit GetAllUnits returns is fair game
-- (spectating with full view — also the case after death/resign, so a player
-- who stays to watch keeps contributing, with wider coverage).
local function recordAll()
	local spec, fullView = spGetSpectatingState()
	return spec and fullView
end

-- ---------------------------------------------------------------------------
-- Preamble: capture context + unit defs + teams + players.

local function emitPreamble()
	local parts = {}
	local spec = spGetSpectatingState()
	parts[#parts + 1] = "BRSNAP GAME " .. jsonObject({
		{ "protocol", protocolVersion },
		{ "mode", (Spring.IsReplay and Spring.IsReplay()) and "replay" or "live" },
		{ "map", Game and Game.mapName or nil },
		{ "gameVersion", Game and Game.gameVersion or nil },
		{ "engineVersion", Engine and (Engine.versionFull or Engine.version) or nil },
		{ "sampleEvery", sampleEvery },
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
				math.floor(r * 255 + 0.5), math.floor(g * 255 + 0.5), math.floor(b * 255 + 0.5))
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
	writeChunk(table.concat(parts, "\n"))
	flushOut()
end

-- ---------------------------------------------------------------------------
-- Sampling. The body is pcall-guarded from widget:GameFrame; after a few
-- consecutive failures the widget closes its file and removes itself rather
-- than risk degrading a live game.

local myAllyTeam = -1
local lastSampleTime = nil
local lastUnitCount = 0

local function sample(frame)
	local t0 = startClock()
	local all = recordAll()
	local units = spGetAllUnits()
	local n = #units
	lastUnitCount = n

	-- Collect U lines first (the count on the F line must match what follows,
	-- and the LOS filter drops an unknown number of units).
	local ulines = {}
	for i = 1, n do
		local unitID = units[i]
		local team = spGetUnitTeam(unitID)
		if all or (team ~= nil and allyTeamOf[team] == myAllyTeam) then
			local x, y, z = spGetUnitPosition(unitID)
			local defID = spGetUnitDefID(unitID)
			local hp, maxHp, _, _, buildProgress = spGetUnitHealth(unitID)
			local vx, vy, vz = spGetUnitVelocity(unitID)
			ulines[#ulines + 1] = string.format("BRSNAP U %d %d %d %.1f %.1f %.1f %.1f %.1f %.2f %.2f %.2f %.3f",
				unitID, defID or -1, team or -1, x or 0, y or 0, z or 0, hp or 0, maxHp or 0,
				vx or 0, vy or 0, vz or 0, buildProgress or 1)
		end
	end

	local lines = { string.format("BRSNAP F %d %.3f %d", frame, spGetGameSeconds(), #ulines) }
	for i = 1, #ulines do
		lines[#lines + 1] = ulines[i]
	end
	-- Economy: readable only for the player's own ally team (all teams when
	-- spectating full view) — GetTeamResources returns nil for the rest.
	for _, teamID in ipairs(spGetTeamList()) do
		local m, mStore, _, mInc = spGetTeamResources(teamID, "metal")
		if m ~= nil then
			local e, eStore, _, eInc = spGetTeamResources(teamID, "energy")
			lines[#lines + 1] = string.format("BRSNAP R %d %.1f %.1f %.1f %.1f %.2f %.2f",
				teamID, m or 0, e or 0, mStore or 0, eStore or 0,
				(mInc or 0) * gameSpeed, (eInc or 0) * gameSpeed)
		end
	end
	writeChunk(table.concat(lines, "\n"))
	flushOut() -- durable if the game/engine dies mid-match
	lastSampleTime = elapsedStr(t0)
end

local function closeOut(reason)
	if out then
		if reason then
			writeChunk("BRSNAP END " .. reason)
		end
		out:flush()
		out:close()
		out = nil
	end
	pending = nil
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
	local ok, err = pcall(emitPreamble)
	if not ok then
		Echo("[replay-uploader] preamble failed (" .. tostring(err) .. "); removing widget")
		removeSelf()
		return
	end
	Echo("[replay-uploader] loaded; waiting for gameId" .. (gameId and "" or " (GameID callin)"))
end

function widget:GameID(id)
	local hex = normalizeGameID(id)
	if hex then
		openOutput(hex)
	else
		Echo("[replay-uploader] unrecognized GameID value; using fallback file name")
		openOutput(fallbackGameID())
	end
end

function widget:GameFrame(frame)
	-- Loaded mid-game (e.g. /luaui reload): the GameID callin is gone; fall
	-- back to a wall-clock name rather than never writing anything.
	if not out and pending then
		openOutput(fallbackGameID())
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
	writeChunk(string.format("BRSNAP EV %d %s %d %d %d",
		spGetGameFrame(), kind, unitID, defID or -1, team or -1))
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
	Echo("[replay-uploader] game over; capture complete" .. (gameId and (": " .. gameId .. ".brsnap") or ""))
	closeOut("gameover")
end

-- Shutdown fires on engine teardown (or widget removal) even if GameOver did
-- not — e.g. the player quits mid-game; keep the partial capture.
function widget:Shutdown()
	closeOut("shutdown")
end
