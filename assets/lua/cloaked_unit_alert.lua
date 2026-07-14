-- Cloaked Unit Alert widget.
--
-- BAR's intrusion-countermeasure buildings (Armada "Tracer"/armsd, Cortex
-- "Nemesis"/corsd, Legion "Ichnaea"/legsd) are pure SEISMIC sensors: their
-- unit def carries `seismicdistance = 2000` and nothing else. A cloaked or
-- radar-stealthy unit that MOVES inside that radius emits a seismic ping,
-- which the engine renders only as small red wobbling dots on the ground —
-- easy to miss, and the sensor cannot target the unit. This widget turns
-- those pings into a real alert:
--
--   * a UI sound on each new contact (rate-limited, see soundCooldown),
--   * a pulsing red ground ring that follows the contact while it keeps
--     pinging and fades out ringDuration seconds after the last ping,
--   * a sonar-style expanding ring on every individual ping,
--   * a blinking blip on the minimap,
--   * a brief "Cloaked unit detected" line on screen.
--
-- The Lua API this rides on is the unsynced callin
--   widget:UnitSeismicPing(x, y, z, strength, allyTeam, unitID, unitDefID)
-- which the engine fires exactly when it spawns one of those red dots for
-- your ally team (the ping is already filtered to what your seismic sensors
-- legitimately detect — no extra information is revealed). Depending on
-- engine build and visibility, everything after `strength` may be nil for
-- a normal player (full data needs fullread access), so only x/z/strength
-- are relied on. Two inherent limits of the game mechanic, not the widget:
-- a STATIONARY cloaked unit never pings, and pings carry no unit identity.
--
-- Install: copy this file into <BAR data dir>/data/LuaUI/Widgets/ and enable
-- "Cloaked Unit Alert" in the F11 widget selector (enabled = true below
-- makes new installs default to on). All knobs are the constants right
-- below GetInfo. The widget is read-only (Get*/draw/sound only), never
-- issues orders or touches synced state, and every callin body is
-- pcall-guarded so an error cannot get it unloaded mid-game; after repeated
-- failures it removes itself politely.

local widgetVersion = "1.0.1"

function widget:GetInfo()
	return {
		name    = "Cloaked Unit Alert",
		desc    = "Sound + pulsing ground rings + minimap blips when your seismic sensors (Tracer/Nemesis/Ichnaea) ping a moving cloaked or stealthy unit.",
		author  = "barreplay",
		version = widgetVersion,
		date    = "2026",
		license = "MIT",
		layer   = 0,
		enabled = true,
	}
end

--------------------------------------------------------------------------------
-- Knobs
--------------------------------------------------------------------------------

local soundVolume  = 0.8
local soundCooldown = 5     -- s: minimum gap between alert sounds
local mergeDist    = 250    -- elmos: pings closer than this refresh one contact instead of spawning a new one
local ringDuration = 10     -- s: contact ring lingers this long after its last ping
local baseRadius   = 60     -- elmos: contact ring size...
local pulseRadius  = 25     -- ...plus this much pulse amplitude
local pulsePeriod  = 1.2    -- s: pulse cycle
local expandTime   = 1.5    -- s: sonar-style expanding ring after each ping
local expandRadius = 400    -- elmos: its final size
local blipRadius   = 120    -- elmos: minimap blip half-size
local textDuration = 4      -- s: on-screen "Cloaked unit detected" duration
local echoAlerts   = false  -- also print a console line per new contact
local alertWhenSpectating = false -- spectators see every ally team's pings; keep them quiet by default
-- First existing file wins (all three ship with BAR).
local soundCandidates = {
	"sounds/ui/warning2.wav",
	"sounds/ui/mappoint2.wav",
	"sounds/ui/beep6.wav",
}

--------------------------------------------------------------------------------
-- State
--------------------------------------------------------------------------------

local spGetMyAllyTeamID  = Spring.GetMyAllyTeamID
local spGetSpectating    = Spring.GetSpectatingState
local spGetGroundHeight  = Spring.GetGroundHeight
local spPlaySoundFile    = Spring.PlaySoundFile
local spEcho             = Spring.Echo
local floor, sin, max    = math.floor, math.sin, math.max
local TWO_PI             = 2 * math.pi

local contacts    = {} -- array of { x, y, z, last = <now of latest ping> }
local now         = 0  -- real seconds since widget load (accumulated in Update; keeps pulsing while paused)
local lastSound   = -math.huge
local lastAlert   = -math.huge
local soundFile   = nil
local vsx, vsy    = 800, 600
local errorCount  = 0
local ALERT_TEXT  = "\255\255\80\80Cloaked unit detected"

-- BAR's handler unloads a widget whose callin raises; guard every body so a
-- surprise (nil args on an odd engine build, GL quirk) degrades gracefully.
-- Callins are invoked as METHOD calls (w:Update(dt)), so the wrapper must
-- drop the leading self before forwarding the real arguments.
local function guard(fn)
	return function(_, ...)
		local ok, err = pcall(fn, ...)
		if ok then return end
		errorCount = errorCount + 1
		spEcho("[CloakAlert] error (" .. errorCount .. "/5): " .. tostring(err))
		if errorCount >= 5 and widgetHandler and widgetHandler.RemoveWidget then
			spEcho("[CloakAlert] too many errors, removing self")
			widgetHandler:RemoveWidget(widget)
		end
	end
end

--------------------------------------------------------------------------------
-- Callins
--------------------------------------------------------------------------------

widget.Initialize = guard(function()
	vsx, vsy = Spring.GetViewGeometry()
	for _, f in ipairs(soundCandidates) do
		if VFS.FileExists(f) then
			soundFile = f
			break
		end
	end
	spEcho("[CloakAlert] v" .. widgetVersion .. " loaded, sound: " .. (soundFile or "none found"))
end)

-- arg shapes vary across handler versions (w,h vs a geometry table); the
-- engine query is always right, so just re-ask it
widget.ViewResize = guard(function()
	vsx, vsy = Spring.GetViewGeometry()
end)

widget.Update = guard(function(dt)
	now = now + (dt or 0)
	-- prune expired contacts (swap-remove; order is irrelevant)
	for i = #contacts, 1, -1 do
		if now - contacts[i].last > ringDuration then
			contacts[i] = contacts[#contacts]
			contacts[#contacts] = nil
		end
	end
end)

-- allyTeam/unitID/unitDefID may all be nil for a normal player; the engine
-- already delivers only pings your ally team's sensors picked up, so the
-- allyTeam check below is just a belt-and-braces skip of own-side pings
-- when the id happens to be visible (fullview spectating, cheats).
widget.UnitSeismicPing = guard(function(x, y, z, strength, allyTeam, unitID, unitDefID)
	if not (x and z) then return end
	local spectating = spGetSpectating()
	if spectating and not alertWhenSpectating then return end
	if allyTeam and allyTeam == spGetMyAllyTeamID() then return end

	-- merge into a nearby live contact so one walking spy is one ring, not thirty
	local contact
	for i = 1, #contacts do
		local c = contacts[i]
		local dx, dz = x - c.x, z - c.z
		if dx * dx + dz * dz <= mergeDist * mergeDist then
			contact = c
			break
		end
	end

	local fresh = (contact == nil)
	if fresh then
		contact = {}
		contacts[#contacts + 1] = contact
	end
	-- the ring follows the moving contact: latest ping wins
	contact.x, contact.z = x, z
	contact.y = spGetGroundHeight(x, z) or y or 0
	contact.last = now

	if fresh then
		lastAlert = now
		if soundFile and (now - lastSound >= soundCooldown) and not spectating then
			spPlaySoundFile(soundFile, soundVolume, 'ui')
			lastSound = now
		end
		if echoAlerts then
			spEcho(("[CloakAlert] cloaked/stealthy unit detected at %d, %d"):format(floor(x), floor(z)))
		end
	end
end)

widget.DrawWorld = guard(function()
	if #contacts == 0 then return end
	gl.DepthTest(false)
	gl.LineWidth(2.5)
	local pulse = 0.5 + 0.5 * sin(now * TWO_PI / pulsePeriod)
	for i = 1, #contacts do
		local c = contacts[i]
		local age = now - c.last
		local fade = 1 - age / ringDuration
		-- pulsing contact ring
		gl.Color(1, 0.15, 0.15, 0.85 * fade)
		gl.DrawGroundCircle(c.x, c.y, c.z, baseRadius + pulseRadius * pulse, 32)
		-- sonar-style expanding ring right after each ping
		if age < expandTime then
			local t = age / expandTime
			gl.Color(1, 0.3, 0.2, 0.6 * (1 - t))
			gl.DrawGroundCircle(c.x, c.y, c.z, baseRadius + (expandRadius - baseRadius) * t, 40)
		end
	end
	gl.LineWidth(1)
	gl.Color(1, 1, 1, 1)
end)

widget.DrawInMiniMap = guard(function(minimapX, minimapY)
	if #contacts == 0 then return end
	gl.PushMatrix()
	gl.Translate(0, minimapY, 0)
	gl.Scale(minimapX / Game.mapSizeX, -minimapY / Game.mapSizeZ, 1)
	local blink = 0.45 + 0.55 * max(0, sin(now * TWO_PI / pulsePeriod))
	for i = 1, #contacts do
		local c = contacts[i]
		local fade = 1 - (now - c.last) / ringDuration
		gl.Color(1, 0.15, 0.15, blink * fade)
		gl.Rect(c.x - blipRadius, c.z - blipRadius, c.x + blipRadius, c.z + blipRadius)
	end
	gl.PopMatrix()
	gl.Color(1, 1, 1, 1)
end)

widget.DrawScreen = guard(function()
	local age = now - lastAlert
	if age >= textDuration then return end
	local fade = 1 - age / textDuration
	gl.Color(1, 1, 1, fade)
	gl.Text(ALERT_TEXT, vsx * 0.5, vsy * 0.72, 24, "cdo")
	gl.Color(1, 1, 1, 1)
end)
