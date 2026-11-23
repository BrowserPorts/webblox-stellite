local LocalizationService = game:GetService("LocalizationService")
local CoreGui = game:GetService("CoreGui")
local CorePackages = game:GetService("CorePackages")
local HttpService = game:GetService("HttpService")
local HttpRbxApiService = game:GetService("HttpRbxApiService")
local RobloxGui = CoreGui:WaitForChild("RobloxGui")
local Utility = require(RobloxGui.Modules.Settings.Utility)
local Localization = require(CorePackages.Workspace.Packages.InExperienceLocales).Localization
local UserGameSettings = UserSettings():GetService("UserGameSettings")

local ENDPOINT = "https://apis.roblox.com/webblox/settings"
local DEFAULT_QUALITY = 1

local PRESETS = {
	{ name = "Performance", fps = 60, resolution = 75, mesh = 0, msaa = "1", grass = false, ui = "standard", distance = 0, quality = 1 },
	{ name = "Balanced", fps = 60, resolution = 100, mesh = -1, msaa = "1", grass = true, ui = "sharp", distance = 0, quality = 1 },
	{ name = "Quality", fps = 60, resolution = 200, mesh = 3, msaa = "4", grass = true, ui = "sharp", distance = 2, quality = 10 },
}

local ROWS = {
	{
		key = "renderer",
		label = "Renderer",
		values = { "webgpu", "webgl" },
		names = { "WebGPU", "WebGL" },
		description = "WebGPU is faster. WebBlox switches to WebGL by itself if WebGPU fails. Takes effect the next time you join an experience.",
		rejoin = true,
		independent = true,
	},
	{
		key = "fullbright",
		label = "Fullbright",
		values = { false, true },
		names = { "Off", "On" },
		description = "Shows everything in its plain colors, with no shadows, fog or dark areas. Only changes what you see.",
		independent = true,
	},
	{
		key = "resolution",
		label = "3D Resolution",
		values = { 50, 60, 75, 85, 100, 200 },
		names = { "50%", "60%", "75%", "85%", "100%", "Full" },
		description = "Scales the 3D scene. Full uses every pixel of a high-DPI screen and costs much more GPU. Takes effect the next time you join an experience.",
		rejoin = true,
	},
	{
		key = "fps",
		label = "Frame Rate Cap",
		values = { 30, 60, 120, 144, 240, 0 },
		names = { "30 FPS", "60 FPS", "120 FPS", "144 FPS", "240 FPS", "Unlimited" },
	},
	{
		key = "mesh",
		label = "Mesh Detail",
		values = { -1, 0, 1, 2, 3 },
		names = { "Default", "Lowest", "Low", "Medium", "High" },
		rejoin = true,
	},
	{
		key = "msaa",
		label = "Anti-Aliasing",
		values = { "", "1", "2", "4" },
		names = { "Default", "Off", "2x", "4x" },
		rejoin = true,
	},
	{
		key = "grass",
		label = "Grass",
		values = { true, false },
		names = { "On", "Off" },
		rejoin = true,
	},
	{
		key = "distance",
		label = "View Distance",
		values = { 0, 1, 2 },
		names = { "Default", "Far", "Very Far" },
		rejoin = true,
	},
	{
		key = "ui",
		label = "Interface Resolution",
		values = { "sharp", "standard" },
		names = { "Sharp", "Standard" },
		description = "Standard draws menus and text at 1x on high-DPI screens, which is faster. Takes effect the next time you join an experience.",
		rejoin = true,
	},
}

local function request(update)
	local url = ENDPOINT
	if update then
		url = url .. "?set=" .. HttpService:UrlEncode(HttpService:JSONEncode(update))
	end
	local ok, body = pcall(function()
		return HttpRbxApiService:GetAsyncFullUrl(url)
	end)
	if not ok then
		warn("[WebBlox] graphics settings request failed: " .. tostring(body))
		return nil
	end
	local decoded, data = pcall(function()
		return HttpService:JSONDecode(body)
	end)
	return decoded and type(data) == "table" and data or nil
end

local function qualityLevel()
	return UserGameSettings.SavedQualityLevel.Value
end

local function indexOf(list, value)
	for i, v in ipairs(list) do
		if v == value then
			return i
		end
	end
	return nil
end

local function placeRows(anchor, frames, before)
	local container = anchor.Parent
	local base = anchor.LayoutOrder
	local shift = #frames
	for _, child in ipairs(container:GetChildren()) do
		if child:IsA("GuiObject") and not table.find(frames, child) then
			if child.LayoutOrder > base or (before and child.LayoutOrder == base) then
				child.LayoutOrder += shift
			end
		end
	end
	for i, frame in ipairs(frames) do
		frame.Parent = container
		frame.LayoutOrder = before and (base + i - 1) or (base + i)
	end
end

local function addGraphicsRows(page)
	local settings = request(nil)
	if not settings then
		return
	end

	local syncing = false
	local selectors = {}
	local presetMode

	local function matchingPreset()
		for i, preset in ipairs(PRESETS) do
			local same = preset.quality == qualityLevel()
			for _, row in ipairs(ROWS) do
				same = same and (row.independent or preset[row.key] == settings[row.key])
			end
			if same then
				return i
			end
		end
		return #PRESETS + 1
	end

	local function refreshPreset()
		if presetMode then
			syncing = true
			presetMode:SetSelectionIndex(matchingPreset())
			syncing = false
		end
	end

	local function setQuality(level)
		pcall(function()
			if level == 0 then
				UserGameSettings.SavedQualityLevel = Enum.SavedQualitySetting.Automatic
			else
				UserGameSettings.SavedQualityLevel = Enum.SavedQualitySetting["QualityLevel" .. level]
			end
		end)
		pcall(function()
			if page.GraphicsQualitySlider and level > 0 then
				page.GraphicsQualitySlider:SetValue(level)
			end
			if page.GraphicsQualityEnabler then
				page.GraphicsQualityEnabler:SetSelectionIndex(level == 0 and 1 or 2)
			end
		end)
	end

	local savedQuality = settings.quality
	if type(savedQuality) ~= "number" or savedQuality < 0 then
		savedQuality = qualityLevel() == 0 and DEFAULT_QUALITY or qualityLevel()
	end
	if savedQuality ~= qualityLevel() then
		setQuality(savedQuality)
	end
	if savedQuality ~= settings.quality then
		settings.quality = savedQuality
		task.spawn(request, { quality = savedQuality })
	end

	local presetNames = {}
	for _, preset in ipairs(PRESETS) do
		table.insert(presetNames, preset.name)
	end
	table.insert(presetNames, "Custom")

	local presetFrame, _, mode = Utility:AddNewRow(page, "Graphics Preset", "Selector", presetNames, matchingPreset())
	presetMode = mode
	presetMode.IndexChanged:connect(function(index)
		if syncing then
			return
		end
		local preset = PRESETS[index]
		if not preset then
			return
		end
		syncing = true
		local update = {}
		for _, row in ipairs(ROWS) do
			if not row.independent then
				update[row.key] = preset[row.key]
				settings[row.key] = preset[row.key]
				local selector = selectors[row.key]
				if selector then
					selector:SetSelectionIndex(indexOf(row.values, preset[row.key]) or 1)
				end
			end
		end
		setQuality(preset.quality)
		syncing = false
		task.spawn(request, update)
	end)

	local frames = {}
	for _, row in ipairs(ROWS) do
		local description = row.description or (row.rejoin and "Takes effect the next time you join an experience." or nil)
		local frame, _, selector = Utility:AddNewRow(
			page,
			row.label,
			"Selector",
			row.names,
			indexOf(row.values, settings[row.key]) or 1,
			nil,
			description
		)
		selectors[row.key] = selector
		table.insert(frames, frame)
		selector.IndexChanged:connect(function(index)
			if syncing then
				return
			end
			local value = row.values[index]
			if value == nil or value == settings[row.key] then
				return
			end
			settings[row.key] = value
			refreshPreset()
			task.spawn(request, { [row.key] = value })
		end)
	end

	UserGameSettings:GetPropertyChangedSignal("SavedQualityLevel"):Connect(function()
		refreshPreset()
		local level = qualityLevel()
		if level ~= settings.quality then
			settings.quality = level
			task.spawn(request, { quality = level })
		end
	end)

	if page.FramerateCapFrame then
		page.FramerateCapFrame.Visible = false
	end
	pcall(function()
		UserGameSettings.FramerateCap = 240
	end)

	local presetAnchor = page.GraphicsEnablerFrame or page.GraphicsQualityFrame
	if presetAnchor then
		placeRows(presetAnchor, { presetFrame }, true)
	end
	local rowsAnchor = page.GraphicsQualityFrame or page.GraphicsEnablerFrame or presetFrame
	placeRows(rowsAnchor, frames, false)
	refreshPreset()
end

local watched = setmetatable({}, { __mode = "k" })

local function watchPage(page)
	if type(page) ~= "table" or watched[page] then
		return
	end
	watched[page] = true
	task.spawn(function()
		for _ = 1, 150 do
			if page.GraphicsQualityFrame or page.GraphicsEnablerFrame then
				local ok, err = pcall(addGraphicsRows, page)
				if not ok then
					warn("[WebBlox] graphics settings failed: " .. tostring(err))
				end
				return
			end
			task.wait(0.2)
		end
	end)
end

local SCENE_ENDPOINT = "https://apis.roblox.com/webblox/scene"
local SCENE_CHUNK_CHARS = 3500
local SCENE_SKIPPED_SERVICES = { CoreGui = true, CorePackages = true, RobloxReplicatedStorage = true, RobloxPluginGuiService = true }

local function sceneRequest(query)
	local ok, body = pcall(function()
		return HttpRbxApiService:GetAsyncFullUrl(SCENE_ENDPOINT .. query)
	end)
	if not ok then
		return nil
	end
	local decoded, data = pcall(function()
		return HttpService:JSONDecode(body)
	end)
	return decoded and data or nil
end

local function readText(instance, property)
	local ok, value = pcall(function()
		return instance[property]
	end)
	if not ok or value == nil then
		return nil
	end
	if typeof(value) == "Content" then
		value = value.Uri
	end
	if type(value) ~= "string" or value == "" then
		return nil
	end
	return value
end

local function firstText(instance, ...)
	for _, property in { ... } do
		local value = readText(instance, property)
		if value then
			return value
		end
	end
	return nil
end

local function colorOf(part)
	local ok, color = pcall(function()
		return part.Color
	end)
	return ok and { color.R, color.G, color.B } or nil
end

local function describeAppearance(part)
	local appearance = part:FindFirstChildOfClass("SurfaceAppearance")
	if not appearance then
		return nil
	end
	return {
		c = firstText(appearance, "ColorMap", "ColorMapContent"),
		n = firstText(appearance, "NormalMap", "NormalMapContent"),
		m = firstText(appearance, "MetalnessMap", "MetalnessMapContent"),
		r = firstText(appearance, "RoughnessMap", "RoughnessMapContent"),
		p = firstText(appearance, "TexturePack", "TexturePackContent"),
	}
end

local function describeInstance(instance)
	if instance:IsA("MeshPart") then
		local mesh = firstText(instance, "MeshId", "MeshContent")
		if mesh then
			return {
				k = "mesh",
				m = mesh,
				t = firstText(instance, "TextureID", "TextureContent"),
				n = instance.Name,
				c = colorOf(instance),
				mat = instance.Material.Name,
				sa = describeAppearance(instance),
			}
		end
	elseif instance:IsA("SpecialMesh") then
		local mesh = readText(instance, "MeshId")
		if mesh then
			local parent = instance.Parent
			local isPart = parent and parent:IsA("BasePart")
			return {
				k = "mesh",
				m = mesh,
				t = readText(instance, "TextureId"),
				n = parent and parent.Name or instance.Name,
				c = isPart and colorOf(parent) or nil,
				sa = isPart and describeAppearance(parent) or nil,
			}
		end
	elseif instance:IsA("Sound") then
		local id = readText(instance, "SoundId")
		return id and { k = "sound", id = id, n = instance.Name } or nil
	elseif instance:IsA("Animation") then
		local id = readText(instance, "AnimationId")
		return id and { k = "animation", id = id, n = instance.Name, model = instance:FindFirstAncestorOfClass("Model") } or nil
	elseif instance:IsA("Decal") or instance:IsA("ParticleEmitter") or instance:IsA("Beam") or instance:IsA("Trail") then
		local id = readText(instance, "Texture")
		return id and { k = "image", id = id, n = instance.Name } or nil
	elseif instance:IsA("ImageLabel") or instance:IsA("ImageButton") then
		local id = readText(instance, "Image")
		return id and { k = "image", id = id, n = instance.Name } or nil
	end
	return nil
end

local function roundFrame(frame)
	local values = { frame:GetComponents() }
	for index, value in values do
		values[index] = math.round(value * 10000) / 10000
	end
	return values
end

local function vectorOf(vector)
	return { math.round(vector.X * 10000) / 10000, math.round(vector.Y * 10000) / 10000, math.round(vector.Z * 10000) / 10000 }
end

local function signature(text)
	local hash = 5381
	for index = 1, #text do
		hash = bit32.band(hash * 33 + string.byte(text, index), 0x7fffffff)
	end
	return string.format("%x", hash)
end

local function describeRig(model)
	local parts = {}
	local indexOf = {}
	local joints = {}
	local bones = {}
	for _, instance in model:GetDescendants() do
		if instance:IsA("BasePart") then
			table.insert(parts, instance)
			indexOf[instance] = #parts
		end
	end
	if #parts == 0 then
		return nil
	end
	local animated = false
	local text = { model.Name }
	local partItems = {}
	for index, part in parts do
		local mesh, texture, scale = nil, nil, nil
		if part:IsA("MeshPart") then
			mesh = firstText(part, "MeshId", "MeshContent")
			texture = firstText(part, "TextureID", "TextureContent")
		else
			local special = part:FindFirstChildOfClass("SpecialMesh")
			if special then
				mesh = readText(special, "MeshId")
				texture = readText(special, "TextureId")
				scale = vectorOf(special.Scale)
			end
		end
		table.insert(text, part.Name .. (mesh or ""))
		table.insert(partItems, {
			k = "rp",
			i = index,
			n = part.Name,
			m = mesh,
			t = texture,
			sc = scale,
			sa = describeAppearance(part),
			c = colorOf(part),
			s = vectorOf(part.Size),
			cf = roundFrame(part.CFrame),
			tr = part.Transparency,
		})
	end
	for _, instance in model:GetDescendants() do
		if instance:IsA("Motor6D") or instance:IsA("Weld") or instance:IsA("ManualWeld") or instance:IsA("WeldConstraint") then
			local a, b = indexOf[instance.Part0], indexOf[instance.Part1]
			if a and b then
				local motor = instance:IsA("Motor6D")
				animated = animated or motor
				table.insert(joints, {
					k = "rj",
					n = instance.Name,
					a = a,
					b = b,
					m = motor or nil,
					c0 = instance:IsA("JointInstance") and roundFrame(instance.C0) or nil,
					c1 = instance:IsA("JointInstance") and roundFrame(instance.C1) or nil,
				})
			end
		elseif instance:IsA("Bone") then
			animated = true
			table.insert(bones, { k = "rb", n = instance.Name })
		end
	end
	if not animated then
		return nil
	end
	local key = model.Name .. "#" .. signature(table.concat(text, "|"))
	local primary = model.PrimaryPart or model:FindFirstChild("HumanoidRootPart")
	local items = { { k = "rig", r = key, n = model.Name, root = primary and indexOf[primary] or nil } }
	for _, list in { partItems, joints, bones } do
		for _, item in list do
			item.r = key
			table.insert(items, item)
		end
	end
	return key, items
end

local AVATAR_CLASSES = { "BasePart", "SpecialMesh", "Clothing", "ShirtGraphic", "Decal", "SurfaceAppearance", "BaseWrap", "Animation", "Sound" }
local AVATAR_PROPERTIES = {
	"MeshId", "TextureID", "TextureId", "ShirtTemplate", "PantsTemplate", "Graphic", "Texture", "SoundId", "AnimationId",
	"CageMeshId", "ReferenceMeshId", "ColorMap", "NormalMap", "MetalnessMap", "RoughnessMap", "TexturePack", "HiddenSurfaceRemovalAsset",
}
local EXTRA_IMAGE_PROPERTIES = {
	Sky = { "SkyboxBk", "SkyboxDn", "SkyboxFt", "SkyboxLf", "SkyboxRt", "SkyboxUp", "SunTextureId", "MoonTextureId" },
	MaterialVariant = { "ColorMap", "NormalMap", "MetalnessMap", "RoughnessMap" },
	SurfaceAppearance = { "ColorMap", "NormalMap", "MetalnessMap", "RoughnessMap", "TexturePack" },
	Tool = { "TextureId" },
}

local function startSceneReport()
	local status = sceneRequest("")
	if not (status and status.enabled) then
		return
	end
	while game.PlaceId == 0 do
		task.wait(1)
	end
	local seen = {}
	local queue = {}
	local rigKeys = {}
	local avatarIds = {}
	local rigPending = {}
	local Players = game:GetService("Players")
	local function push(item)
		local key = HttpService:JSONEncode(item)
		if not seen[key] then
			seen[key] = true
			table.insert(queue, { key = key })
		end
	end
	local function isCharacter(model)
		if Players:GetPlayerFromCharacter(model) or Players:FindFirstChild(model.Name) then
			return true
		end
		local humanoid = model:FindFirstChildOfClass("Humanoid")
		return humanoid ~= nil and humanoid:FindFirstChildOfClass("HumanoidDescription") ~= nil
	end
	local function scanRig(model)
		if isCharacter(model) then
			return nil
		end
		local ok, key, items = pcall(describeRig, model)
		if not ok or not key then
			return nil
		end
		rigKeys[model] = key
		for _, item in items do
			push(item)
		end
		return key
	end
	local function queueRig(model)
		if not model or rigPending[model] then
			return
		end
		rigPending[model] = true
		task.delay(3, function()
			rigPending[model] = nil
			if model.Parent then
				scanRig(model)
			end
		end)
	end
	local function notePlayed(animator)
		local function report(track)
			local id = readText(track.Animation, "AnimationId")
			local model = animator:FindFirstAncestorOfClass("Model")
			if not id or not model then
				return
			end
			if isCharacter(model) then
				if not avatarIds[id] then
					push({ k = "animation", id = id, n = track.Name })
				end
				return
			end
			local key = rigKeys[model] or scanRig(model)
			if key then
				push({ k = "play", id = id, r = key })
			end
		end
		animator.AnimationPlayed:Connect(function(track)
			pcall(report, track)
		end)
		for _, track in animator:GetPlayingAnimationTracks() do
			pcall(report, track)
		end
	end
	local function underCharacter(instance)
		if instance:IsA("Accoutrement") or instance:FindFirstAncestorWhichIsA("Accoutrement") then
			return true
		end
		local model = instance:FindFirstAncestorOfClass("Model")
		while model do
			if isCharacter(model) then
				return true
			end
			model = model:FindFirstAncestorOfClass("Model")
		end
		return false
	end
	local function noteAvatar(instance)
		for _, class in AVATAR_CLASSES do
			if instance:IsA(class) then
				for _, property in AVATAR_PROPERTIES do
					local id = readText(instance, property)
					if id then
						avatarIds[id] = true
						push({ k = "avatar", id = id })
					end
				end
				return
			end
		end
	end
	local WATCHED_PROPERTIES = { Sound = "SoundId", Decal = "Texture", ImageLabel = "Image", ImageButton = "Image", Animation = "AnimationId" }
	local watched = setmetatable({}, { __mode = "k" })
	local function watchProperty(instance, handler)
		local property = WATCHED_PROPERTIES[instance.ClassName]
		if property and not watched[instance] then
			watched[instance] = true
			instance:GetPropertyChangedSignal(property):Connect(function()
				handler(instance)
			end)
		end
	end
	local note
	note = function(instance)
		watchProperty(instance, function(changed)
			task.defer(note, changed)
		end)
		if underCharacter(instance) then
			pcall(noteAvatar, instance)
			if instance:IsA("Animator") then
				pcall(notePlayed, instance)
			end
			return
		end
		local extra = EXTRA_IMAGE_PROPERTIES[instance.ClassName]
		if extra then
			for _, property in extra do
				local id = readText(instance, property)
				if id then
					push({ k = "image", id = id, n = instance.Name })
				end
			end
		end
		if instance:IsA("Motor6D") or instance:IsA("Bone") or instance:IsA("AnimationController") or instance:IsA("Humanoid") then
			queueRig(instance:FindFirstAncestorOfClass("Model"))
		elseif instance:IsA("Animator") then
			pcall(notePlayed, instance)
			queueRig(instance:FindFirstAncestorOfClass("Model"))
		end
		local ok, item = pcall(describeInstance, instance)
		if not ok or not item then
			return
		end
		local model = item.model
		item.model = nil
		if model and not isCharacter(model) then
			local key = rigKeys[model] or scanRig(model)
			if key then
				push({ k = "play", id = item.id, r = key })
			end
		end
		push(item)
	end
	task.spawn(function()
		while true do
			if #queue == 0 then
				task.wait(2)
			else
				local parts = {}
				local size = 0
				while #queue > 0 and size + #queue[1].key < SCENE_CHUNK_CHARS do
					local entry = table.remove(queue, 1)
					table.insert(parts, entry.key)
					size += #entry.key + 1
				end
				if #parts == 0 then
					table.remove(queue, 1)
				else
					local query = "?place=" .. tostring(game.PlaceId) .. "&items=" .. HttpService:UrlEncode("[" .. table.concat(parts, ",") .. "]")
					sceneRequest(query)
				end
				task.wait(0.25)
			end
		end
	end)
	game.DescendantAdded:Connect(function(instance)
		task.defer(note, instance)
	end)
	for _, service in game:GetChildren() do
		if not SCENE_SKIPPED_SERVICES[service.ClassName] then
			local ok, descendants = pcall(function()
				return service:GetDescendants()
			end)
			if ok then
				for index, instance in descendants do
					note(instance)
					if index % 500 == 0 then
						task.wait()
					end
				end
			end
			task.wait()
		end
	end
end

task.spawn(function()
	local ok, err = pcall(startSceneReport)
	if not ok then
		warn("[WebBlox] scene report failed: " .. tostring(err))
	end
end)

local addNewRow = Utility.AddNewRow
Utility.AddNewRow = function(self, page, ...)
	watchPage(page)
	return addNewRow(self, page, ...)
end

local OPTIONS = { "On", "Off" }

return function(page, layout, reportSettingChange)
	local localization = Localization.new(LocalizationService.RobloxLocaleId)
	local label = localization:Format("Translation.PlayerChoiceSettings.GameSettings.PlayerChoiceSettingLabel")
	local description = localization:Format("Translation.PlayerChoiceSettings.GameSettings.PlayerChoiceSettingDescription")
	local current = LocalizationService:GetIsLoadingInternalTranslations() and 1 or 2
	page.PlayerChoiceTranslationFrame, page.PlayerChoiceSettingLabel, page.PlayerChoiceSettingMode =
		Utility:AddNewRow(page, label, "Selector", OPTIONS, current, nil, description)
	page.PlayerChoiceTranslationFrame.LayoutOrder = layout.PlayerChoiceTranslationFrame
	page.PlayerChoiceSettingMode.IndexChanged:connect(function(index)
		local enabled = index == 1
		LocalizationService:IsLoadingInternalTranslationsSettingChanged(enabled)
		reportSettingChange("player_choice_translation", current == 1, enabled)
	end)
	return page.PlayerChoiceTranslationFrame, page.PlayerChoiceSettingLabel, page.PlayerChoiceSettingMode
end
