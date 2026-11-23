module.exports = {
  entry: 'StarterScript',
  flags: {
    UseInGameTopBar: true,
    UseLuaCameraAndControl: true,
    EnableSetCoreTopbarEnabled: true,
    SetCoreMoveChat: true,
    SetCoreDisableChatBar: true,
    SetCoreDisableNotifications: true,
    SetCoreSendNotifications: true,
    LuaChatFiltering: true,
    LuaBasedBubbleChat: false,
    PlayerDropDownEnabled: true,
    MobileToggleChatVisibleIcon: true,
    NewInGameDevConsole: true,
    ConsoleCodeExecutionEnabled: false,
    AllowHideHudShortcut: true,
    EnableLuaFollowers: true,
    UserServerFollowers: true,
    UseNewSubdomainsInCoreScripts: true,
    DataFarmUsesHttps: true,
    CheckMarketplaceAvailable: true,
    RestrictSales: false,
    GoodbyeChoiceActiveProperty: true,
    FilteringEnabledDialogFix: true,
    UseCanManageApiToDetermineConsoleAccess: true,
    XboxPlayMyPlace: false,
    UseUserListMenu: true,
  },
  patches: [
    {
      file: 'Modules/Settings/SettingsHub.lua',
      from: 'this.RecordPage = require(RobloxGui.Modules.Settings.Pages.Record)',
      to: 'this.RecordPage = nil',
    },
    {
      file: 'Modules/Settings/SettingsHub.lua',
      from: 'this.RecordPage:SetHub(this)',
      to: '',
    },
    {
      file: 'Modules/Chat.lua',
      from: 'pcall(function() PlayersService:Chat(cText) end)',
      to: 'pcall(function() game:GetService("TextChatService").TextChannels.RBXGeneral:SendAsync(cText) end)',
    },
    {
      file: 'Modules/Chat.lua',
      from: 'this.PlayerChattedConn = PlayersService.PlayerChatted:connect(function(...)',
      to: `this.TextChatConn = Util.DisconnectEvent(this.TextChatConn)
			this.TextChatConn = game:GetService("TextChatService").MessageReceived:connect(function(message)
				local sender = message.TextSource and PlayersService:GetPlayerByUserId(message.TextSource.UserId)
				if sender then
					this:OnPlayerChatted(Enum.PlayerChatType.All, sender, message.Text, nil)
				end
			end)
			this.PlayerChattedConn = PlayersService.PlayerChatted:connect(function(...)`,
    },
  ],
};
