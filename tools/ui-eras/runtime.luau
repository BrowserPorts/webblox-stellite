local ERA = "__ERA_NAME__"
local DEFAULT_FLAG = __ERA_DEFAULT_FLAG__
local FLAGS = __ERA_FLAGS__
local SOURCES = __ERA_SOURCES__
local ENTRY = "__ERA_ENTRY__"

local CoreGui = game:GetService("CoreGui")
local RobloxGui = CoreGui:WaitForChild("RobloxGui")
local rootEnv = getfenv()
local realRequire = require
local realSettings = settings()

local modulePaths = {}
local moduleStates = {}
local definedFlags = {}

local function flagValue(name, fallback)
	local value = FLAGS[name]
	if value ~= nil then
		return value
	end
	if fallback ~= nil then
		return fallback
	end
	return DEFAULT_FLAG
end

local settingsProxy = setmetatable({
	GetFFlag = function(_, name)
		return flagValue(name)
	end,
	GetFVariable = function()
		return ""
	end,
}, {
	__index = function(_, key)
		local value = realSettings[key]
		if type(value) == "function" then
			return function(_, ...)
				return value(realSettings, ...)
			end
		end
		return value
	end,
})

local function report(path, message)
	warn(string.format("[ui-era %s] %s: %s", ERA, path, tostring(message)))
end

local runModule

local function eraRequire(target)
	local path = modulePaths[target]
	if not path then
		return realRequire(target)
	end
	local state = moduleStates[path]
	if not state then
		state = {}
		moduleStates[path] = state
		local ok, value = xpcall(runModule, function(message)
			return debug.traceback(tostring(message), 2)
		end, path, target)
		if ok then
			state.value = value
		else
			state.failed = value
			report(path, value)
		end
		state.done = true
	end
	while not state.done do
		task.wait()
	end
	if state.failed then
		error(string.format("%s failed to load", path), 2)
	end
	return state.value
end

local function addCoreScript(path, parent)
	local source = SOURCES[path]
	if not source then
		report(path, "script not in this era")
		return
	end
	local holder = Instance.new("ModuleScript")
	holder.Name = string.match(path, "[^/]+$")
	holder.Parent = parent
	modulePaths[holder] = path
	task.spawn(function()
		local ok, message = xpcall(runModule, function(message)
			return debug.traceback(tostring(message), 2)
		end, path, holder)
		if not ok then
			report(path, message)
		end
	end)
end

local packagesRoot

local function environmentFor(instance)
	return setmetatable({
		script = instance,
		require = eraRequire,
		settings = function()
			return settingsProxy
		end,
		__eraAddCore = addCoreScript,
		__eraCorePackages = packagesRoot,
		__eraFastFlag = function(name)
			if definedFlags[name] ~= nil then
				return definedFlags[name]
			end
			return flagValue(name)
		end,
		__eraDefineFlag = function(name, fallback)
			local value = flagValue(name, fallback)
			definedFlags[name] = value
			return value
		end,
		__eraVerb = function(button, verb)
			if verb == "Exit" then
				button.MouseButton1Click:Connect(function()
					game:Shutdown()
				end)
			end
		end,
		Game = game,
		Workspace = workspace,
		Spawn = spawn,
		Delay = delay,
		Wait = wait,
	}, { __index = rootEnv })
end

runModule = function(path, instance)
	local source = SOURCES[path]
	setfenv(source, environmentFor(instance))
	return source()
end

local function buildTree(prefix, rootName, renameModules)
	local root = RobloxGui:FindFirstChild(rootName)
	if root then
		root:Destroy()
	end
	root = Instance.new("Folder")
	root.Name = rootName
	local paths = {}
	for path in pairs(SOURCES) do
		if string.sub(path, 1, #prefix + 1) == prefix .. "/" then
			table.insert(paths, path)
		end
	end
	table.sort(paths)
	local nodes = {}
	for _, path in ipairs(paths) do
		local parent = root
		local walked = prefix
		for _, part in ipairs(string.split(string.sub(path, #prefix + 2), "/")) do
			walked = walked .. "/" .. part
			local node = nodes[walked]
			if not node then
				node = Instance.new(SOURCES[walked] and "ModuleScript" or "Folder")
				node.Name = (renameModules and part == "Modules") and "EraModules" or part
				node.Parent = parent
				nodes[walked] = node
				if SOURCES[walked] then
					modulePaths[node] = walked
				end
			end
			parent = node
		end
	end
	root.Parent = RobloxGui
	return root
end

buildTree("Modules", "EraModules", true)
packagesRoot = buildTree("Packages", "EraPackages", false)
addCoreScript(ENTRY, RobloxGui)
