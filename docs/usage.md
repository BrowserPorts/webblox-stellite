# Usage

## Launcher

The launcher in `public/launcher` is a plain web page. It opens instantly, and Play goes straight to
the game without loading the engine first. Leave in the in-game menu brings you back to it.

It calls the same Roblox APIs as the real launcher and covers Home, Charts, Search, game pages,
Avatar with a 3D preview, Marketplace, Trades, Chat, Friends, Profiles, Communities, Notifications,
Messages, Settings, Robux and Account.

Trades lists inbound, outbound, completed and inactive trades, and lets you accept, decline, counter
or cancel them. Trade on someone's profile, or a person picked from the search field on the Trades
page, opens a trade builder with both inventories. The search only lists people who can trade with
you. When Roblox asks for 2-step verification, the launcher asks for the code and finishes the
request itself.

The Marketplace filters by category, subcategory, price, sales type, creator and availability, and
tags limiteds as Limited or Limited U. Limited item pages show a price history chart.

Settings > RoValra turns on features based on [RoValra](https://github.com/NotValra/RoValra), written
for WebBlox: Rolimons values on trades, trade lists, item pages and profiles, win/loss stats, the value
after the Robux fee, rare, projected and hyped flags, a notice for new trades, server locations and a
best-ping sort on the Servers tab, all-time Robux totals, and an Unblock everyone button. Each one has
its own switch. Item values and server locations come from the RoValra API at
[rovalra.com](https://www.rovalra.com), fetched through the server. Item values are cached for five
minutes.

Signing in, buying Robux and the less common account settings still open Roblox's own pages or
launcher. You can also open Roblox's launcher from the profile menu or Settings. `/?launcher=roblox`
runs it for as long as you stay on that page, and games you leave from there return to it.

## Graphics settings

Esc > Settings has WebBlox's rows next to Roblox's own graphics options. Graphics Preset sets all of
them at once. The launcher's Settings > Graphics has the same rows, saved to the same place.

| Preset | Quality | 3D resolution | Interface | View distance | Frame cap | Mesh detail | Anti-aliasing | Grass |
|---|---|---|---|---|---|---|---|---|
| Performance | Level 1 | 75% | Standard | Default | 60 | Lowest | Off | Off |
| Balanced | Level 1 | 100% | Sharp | Default | 60 | Default | Off | On |
| Quality | Level 10 | Full | Sharp | Very Far | 60 | High | 4x | On |

- 3D Resolution scales only the 3D scene. The engine draws menus and text separately, so they stay
  sharp. On a high-DPI screen the engine draws the 3D scene at half the screen's pixel density. Full
  keeps the pixel ratio just under 2, so it renders at the screen's real resolution at about four
  times the GPU cost.
- View Distance raises the engine's render distance, from 300 studs at Default to 1300 at Very Far.
- Interface Resolution set to Standard draws menus and text at 1x on high-DPI screens, which saves
  GPU time.
- Anti-aliasing (MSAA) is the most expensive option. Turning it off cuts GPU time per frame by about
  a quarter.

WebBlox sets the engine's texture budget from the device's memory instead of the 64 MB WebGL reports.

The Renderer row picks WebGPU or WebGL. Presets don't change it. WebGPU is the default and falls back to
WebGL by itself when the browser can't run it or the GPU device is lost, so you only need this row to
compare the two. It applies on the next join.

The Fullbright row shows everything in its plain colors, with no shadows, fog, dark areas or color grading. The
sky and clouds keep their normal look. Presets don't change it, and it stays on between joins. It takes effect
within a second. Only you see the change, and the game's Lighting settings keep their values, so game scripts
read what they normally read.

The frame cap changes immediately. Up to the display's refresh rate the engine renders in step with the
display. Above it, the engine renders on a timer and the display shows the newest frame, which lowers input
latency but can't show more frames than the panel draws. The other settings apply on the next join. The browser
saves all of them. New setups start on Balanced, and a setup still on Automatic moves to Level 1 once.

## URL options

| Option | Effect |
|---|---|
| `placeId=<id>` | Join this place instead of opening the home screen. |
| `fps=<n>` | Frame cap. `fps=0` removes it, which leaves the engine's own 240 fps limit. |
| `renderer=webgpu`, `renderer=webgl` | Pick the renderer for this load, overriding the Renderer setting. |
| `renderScale=<n>` | Whole-canvas resolution multiplier, overriding Interface Resolution. |
| `flag=Name=Value` | Override one engine flag for this load. Repeatable. |
| `flagset=live` | Give the engine Roblox's live flags instead of the pin. `flagset=parity` or `flagset=bisect` loads a test set from `npm run flags`. The launcher keeps this when you start a game. |
| `hud=1` | Frame-time overlay. `perfReport()` in the console prints the same numbers. |
| `msaa=1`, `alpha=1`, `desync=1` | Restore WebGL context defaults that WebBlox turns off. |
| `adaptive=1`, `scale=<n>` | Adaptive resolution, or a fixed ratio. Off by default. |
| `warm=0` | Turn off shader warm-up. |
| `mode=wisp` | Use [Wisp mode](#wisp-mode) for this load. |
| `wisp=<wss url>` | In Wisp mode, use only this relay instead of the built-in list. |

## Server options

Set these as environment variables when you start the server.

| Variable | Effect |
|---|---|
| `PORT` | Listen port. Default `3000`. |
| `PREFETCH=0` | Don't prefetch assets listed in batch lookups. |
| `PROXY_LOG=1` | Log every proxied request. The server always logs failed requests. |
| `ASSET_LOG=1` | Log asset ids Roblox refuses. `GET /__assets` lists them. |
| `SAVE_ASSETS=1` | Save every game's asset files to `game-cache/`, sorted by game. See [Saving the files](#saving-the-files). |
| `SAVE_ASSETS_DIR` | Save those files to a different folder. |
| `UPSTREAM_H2=0` | Talk to Roblox over HTTP/1.1 instead of HTTP/2. |
| `GL_TRACE=1` | Accept GL trace uploads. See [Tracing](internals.md#webgpu-renderer). |
| `WEBBLOX_NO_FLAG_WATCH=1` | Skip the hourly check that compares Roblox's live flags with the pin. |

## Cache by game

When you join a place, the server tags your browser with that place until the page reloads or you
join somewhere else. It records each asset it then looks up or sends you under that place, with the
asset id, type, format and size. Records live in `.cache/places/` and survive restarts. Wisp mode
doesn't go through the server, so the server doesn't record its joins.

| Search | Shows |
|---|---|
| `npm run cache` | Every recorded place, most recent first. |
| `npm run cache -- tower` | Places whose id, universe id or name contains `tower`, or that loaded asset `tower`. |
| `npm run cache -- --place 85445143621846` | That place's assets, largest first. Add `--type Mesh` or a search word to narrow it. |
| `GET /__cache?q=…&place=…&type=…&limit=…` | The same searches as JSON. `inMemory` marks assets the server still holds. |

### Saving the files

Start the server with `SAVE_ASSETS=1` to also write each game asset to
`game-cache/<Game name> (<place id>)/<type>/<asset id>.<ext>`.

It saves everything the game loads except other players' avatars:

- A script in the engine's settings module reports what's on player characters and avatar copies in
  the world. The server skips or deletes those files unless the game also uses them elsewhere. The
  script only runs while saving is on.
- The server keeps images, meshes, models and animations the script doesn't see in the world only if
  their creator also made something it did see. This keeps out clothes and accessories that load
  outside the world.
- Sounds and fonts skip this check.
- At startup, the server removes avatar files and downloads missed assets again.

The extension comes from the file's contents (png, ktx2, ogg, mesh, rbxm and so on). The folder comes
from the type Roblox reports, or from the contents when Roblox's type is missing or doesn't match
them. A file moves if its type becomes known after the server saved it.

Assets the browser already has in its cache never pass through the server, so the server downloads
those itself about 15 seconds after the game asks for them. An asset shared by several games is
hard-linked, not stored twice.

If you delete files from `game-cache/`, the viewer stops listing them, and the server saves them again
the next time a game you join asks for them.

Most viewers show `.ktx2` textures as noise, because they're GPU-compressed (BC1 or BC3) and then
Zstandard-compressed. `npm run ktx2png` writes a viewable `<name>.ktx2.png` beside each one in
`game-cache/`, or in a folder you name after `--`.

[fun/viewer](../fun/viewer) is a local website for browsing these files, with 3D meshes, sounds and
animations. Run `npm run viewer`, then open `http://localhost:3200/`.

## Wisp mode

Wisp mode runs without the Node server and opens the launcher at `/launcher/`.

- On this computer, open `http://localhost:3000/?mode=wisp`, or use Settings > Advanced in the
  launcher.
- On a static host serving `public/`, open the root URL. A static host always uses Wisp. It has to be
  https or localhost, because Wisp needs a service worker.

The page asks for your `.ROBLOSECURITY` value the first time and stores it in the browser's
`localStorage`. On each load it checks that Roblox still accepts the saved session, and asks for a new
one if not. A pasted value that Roblox rejects is not saved. Wisp keeps its own session, separate from
the server mode's sign-in.

Roblox requests go through a public relay listed in `public/cobalt/wisps.js`, or the one you give with
`?wisp=`. Cobalt's epoxy transport does TLS inside the browser, so the relay sees which hosts you
connect to and how much data moves, not your requests or cookie. You still trust the relay with that
metadata and with staying up. Node mode keeps everything on your machine.

The service worker loads web views (Settings pages, challenges) at `/__frame__/`. The in-game UI picker
is hidden in Wisp mode, because old UI builds come from the Node server.
