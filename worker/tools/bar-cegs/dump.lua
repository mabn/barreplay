-- dump.lua <BAR checkout>: prints {weapons: {weaponName: cegName}, cegs: {cegName: def}}
-- as JSON, evaluated from the game's own Lua (effects/, units/, weapons/).
local root = arg[1]
dofile(root .. "/common/tablefunctions.lua")
math.round = math.round or function(x) return math.floor(x + 0.5) end

-- Spring stub: any field is a function returning an empty table.
local any = setmetatable({}, { __index = function() return function() return {} end end })
Spring = any
-- VFS.DirList over the checkout, for gamedata/resources.lua's AutoAdd.
local function dirList(dir)
	local out = {}
	local p = io.popen('find "' .. root .. "/" .. dir .. '" -maxdepth 1 -type f 2>/dev/null | sort')
	for l in p:lines() do out[#out + 1] = l:sub(#root + 2) end
	p:close()
	return out
end
VFS = setmetatable({ DirList = dirList, Include = function() return {} end }, { __index = any })
Game = setmetatable({ gameSpeed = 30, squareSize = 8 }, { __index = function() return 0 end })
lowerkeys = function(t)
	local o = {}
	for k, v in pairs(t) do o[type(k) == "string" and k:lower() or k] = type(v) == "table" and lowerkeys(v) or v end
	return o
end

local function files(dir)
	local out = {}
	local p = io.popen('find "' .. dir .. '" -name "*.lua" | sort')
	for l in p:lines() do out[#out + 1] = l end
	p:close()
	return out
end

local function load(path)
	local chunk, err = loadfile(path)
	if not chunk then io.stderr:write("skip " .. path .. ": " .. err .. "\n") return nil end
	local ok, res = pcall(chunk)
	if not ok then io.stderr:write("fail " .. path .. ": " .. tostring(res) .. "\n") return nil end
	return res
end

local cegs = {}
for _, f in ipairs(files(root .. "/effects")) do
	local t = load(f)
	if type(t) == "table" then
		for k, v in pairs(t) do
			if type(k) == "string" and type(v) == "table" then cegs[k:lower()] = v end
		end
	end
end

local weapons = {}
local function ceg(w)
	for k, v in pairs(w) do
		if type(k) == "string" and k:lower() == "explosiongenerator" and type(v) == "string" then
			return (v:lower():gsub("^custom:", ""))
		end
	end
end
for _, f in ipairs(files(root .. "/units")) do
	local t = load(f)
	if type(t) == "table" then
		for uname, ud in pairs(t) do
			if type(ud) == "table" then
				for k, wd in pairs(ud) do
					if type(k) == "string" and k:lower() == "weapondefs" and type(wd) == "table" then
						for wname, w in pairs(wd) do
							local c = type(w) == "table" and ceg(w)
							if c then weapons[(uname .. "_" .. wname):lower()] = c end
						end
					end
				end
			end
		end
	end
end
for _, f in ipairs(files(root .. "/weapons")) do
	local t = load(f)
	if type(t) == "table" then
		for wname, w in pairs(t) do
			local c = type(w) == "table" and ceg(w)
			if c then weapons[tostring(wname):lower()] = c end
		end
	end
end

-- JSON
local function str(s)
	return '"' .. s:gsub('[%c"\\]', function(c)
		if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" end
		return string.format("\\u%04x", c:byte())
	end) .. '"'
end
local function enc(v)
	local t = type(v)
	if t == "table" then
		local keys = {}
		for k in pairs(v) do keys[#keys + 1] = k end
		local isArr = #keys > 0 and #v == #keys
		if isArr then
			local p = {}
			for i = 1, #v do p[i] = enc(v[i]) end
			return "[" .. table.concat(p, ",") .. "]"
		end
		table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
		local p = {}
		for _, k in ipairs(keys) do
			if type(v[k]) ~= "function" then p[#p + 1] = str(tostring(k):lower()) .. ":" .. enc(v[k]) end
		end
		return "{" .. table.concat(p, ",") .. "}"
	elseif t == "string" then
		return str(v)
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return "0" end
		return (v == math.floor(v) and string.format("%d", v)) or string.format("%.6g", v)
	elseif t == "boolean" then
		return tostring(v)
	end
	return "null"
end
-- Texture name -> file, for the two atlases effects draw from.
local res = load(root .. "/gamedata/resources.lua") or { graphics = {} }
local textures = {}
for _, atlas in ipairs({ "projectiletextures", "groundfx" }) do
	for k, v in pairs(res.graphics[atlas] or {}) do
		if type(k) == "string" and type(v) == "string" then textures[k:lower()] = "bitmaps/" .. v end
	end
end
io.write(enc({ weapons = weapons, cegs = cegs, textures = textures }))
