# TODO

## Where this copy stands

This is Stellite's copy. It runs from any folder (Stellite serves it under `/webblox/` in a frame), ships no
public Wisp relay and takes its relay from the host with `?wisp=`. The list below was written before several
changes to the code, so read it with these corrections:

- The session never touches a file. In node mode it is kept as `rbx_*` cookies in the browser, in Wisp mode in
  `localStorage['cobalt-cookies']`. There is no `.roblosecurity` file, no local relay, no `whip.js` and no UDMUX
  token map any more. Game traffic is WebTransport from the browser straight to `*.qdmux.roblox.com`.
- **#18** Sign out exists in the launcher. The smoke and flag boot checks now ask the page whether it is signed
  in and take a signed-in profile with `WEBBLOX_PROFILE`. Still to test with real accounts: expiry, and two
  accounts in sequence.
- **#15** Done in Wisp mode: one line and a count per refused asset (`webbloxRefusedAssets()`), an empty picture
  for `UnapprovedImage`, the retry policy written at `wisp()` in `public/js/upstream.js`, and a log line each time
  a batch answer with errors is kept for 60 s. The node server still only audits with `ASSET_LOG=1`.
- **#20** The join logs the edge address and the host built from it (`[gamejoin] game host`).
- **#14** Done: the CJK font is left out unless the browser's languages include Chinese, Japanese or Korean (the
  engine starts the same without it), the worker fetches the wasm while the page sets up its relay and session, and
  `webbloxCacheStats()` gives the cache hit rate per host. The per-host lifetimes have not been reviewed against a
  real session's numbers.
- **#13** The adaptive governor keeps a ratio per engine stage for the page load. It cannot tell a lobby from a
  fight inside one game, since both are the same stage.
- **#16** In Wisp mode the page remembers what each place asked for and fetches it together when the next join
  starts. `FFlagWasmPrefetchAllAssets` is not in this engine build. Not yet measured in a session.
- **#5** The page works its scale out again when the pixel ratio changes. The render worker keeps the star width it
  started with. Still to confirm on real 125 %, 150 % and 200 % displays.
- **#17** Done: `npm run import-content` reads the Windows packages from Roblox's CDN, so no installed player is
  needed. Against Windows 0.748 it finds every file the engine names already in the bundle.
- **App storage.** What is known so far: the file is `/appData/LocalStorage/appStorage.json` in the engine's own
  in-memory filesystem, and wasm function 154943 builds its name and is only reached through a table. The engine
  exports `rbx_fs_add_file` and `rbx_fs_preload_asset`, and a file seeded through `window.__prefetchedAssets` does
  land in memory, but the engine did not read it back on the sign-in screen, so AppStorage either loads later or
  through another file layer. Nothing reads a file out, so saving still needs a wasm patch or a new export. The
  next step needs a signed-in session: change a theme, then find the written file in memory.

Open in this copy and not in the list below:

- **Session storage in Wisp mode.** Any script on the same origin can read `localStorage['cobalt-cookies']`. The
  bundled Cobalt client reads that key itself, so moving it means rebuilding or wrapping that bundle.
- **Game traffic on networks that block Roblox.** Joins fail there. Planned: fall back to a WebTransport relay in
  wisp-rust, then to a QUIC stack in the page over a Wisp UDP stream.

State as of the last session: a full join to RIVALS works (lobby, avatars, chat, scoreboard),
asset requests return 200, and the text double-draw at scaled displays is fixed. The visual
issues below are the remaining gap against native.

---

## Open — engine build `version-db62701aba0b4bcd`

### Persist the launcher's app storage
Theme choices and other launcher settings reset on every reload. AppStorageService writes
`appStorage.json` to the engine's in-memory filesystem; the only persistent storage the web build
has is the `rbx_opfs_*` key-value store, and the HTTP cache (`10_`/`11_` keys) is its only user.
Fixing it means finding AppStorage's C++ load and save routines and routing them to
`rbx_opfs_get`/`rbx_opfs_set` from spliced wasm, the way `patchSystemTheme` adds functions.

### 20. Watch the qdmux hostname rule
Native joins get a `gameFqdn` built in `server/join.js`, with the edge taken as the UDMUX address
plus one. If a datacenter breaks that rule, joins there fail with "Opening handshake failed" in
the console; log the web join's real `gameFqdn` for that place to see the new pattern.

## Open — rendering

### 2. Some VFX render with the wrong colour
**Status:** reported, not reproduced deterministically.

Particle textures are present in the bundle and no longer fail to decode (that was fixed by
the content import). Candidates, cheapest first:
- emissive/colour-sequence handling in the wasm renderer,
- texture `Color3` tint applied twice,
- sRGB vs linear sampling for the specific texture format.

Reproduce by finding a scene with a known native appearance (the lobby fire/portal) and
comparing pixel values, not by eye alone.

### 3. Premium/rank name-tag badges render as black pills
**Status:** re-check. Observed before the gradient fix; not seen in the lobby since. If the pills
were gradient-filled frames, `FFlagUIGpuGradient12 = False` fixed them too.

Small dark rectangles sit where badges should be, on name tags and scoreboard rows. Consistent
with a blocked thumbnail placeholder **or** a texture uploaded as all-black. Verify by
checking whether any `thumbnails`/`assetdelivery` call backs those elements at all; if not,
they are drawn from an image asset and `ASSET_LOG=1` will name it.

---

## Open — tooling

### 5. Confirm the DPI fix on real hardware
The `renderScale` fix is verified at emulated 2×. Confirm on an actual 125 %, 150 % and 200 %
display, and check that switching monitors mid-session does not leave a stale ratio.

### 21. Play-test the desktop parity flags
`tools/flagguard/parity.json` adopts 42 flags that Mac and PC have and web lacks: physics
replication, four terrain voxel fixes, avatar, UI and input fixes, and parser depth limits. The
`parity` set boots headless and every one of those flags reaches engine memory. It still needs a
few games at `http://localhost:3000/?flagset=parity`. If it holds up, `npm run flags -- adopt`
makes the flags permanent. If something breaks, `npm run flags -- bisect start --good pinned --bad parity`
finds the flag.

---

## Open — caching and benchmarking

### 6. Prune `.cache/enc`
**Done.** Startup sweep keeps the newest entries under a 192 MB budget (128 MB today, so it
only acts once engine updates have piled up variants).

### 7. Re-measure after the content import
The published numbers predate the 2,730-file content import. Re-run the cold/warm measurement
(transfer, engine-ready time, wasm cache hit) and update the table in the README.

`tools/bench.js` now covers the server side of this (asset latency, wasm transfer, proxy
overhead). Engine-ready time still needs a real session.

---

## Open — FPS performance

### 11. Establish a frame-time baseline before changing anything
**Status:** still not measured — but the instruments now ship with the harness, so this is one
run away rather than a build task.

`perf.js` adds `?hud=1` (fps, p95 frame time, refresh rate, engine render ms vs budget, live
ratio, hitches) and `window.perfReport()` (the same plus GPU renderer, context attributes,
canvas size, `crossOriginIsolated`). Display refresh and the effective cap are detected, so a
run on a 144 Hz machine is directly comparable to one on 60. It also installs the resolution governor, so the A/B for #12 is
`?adaptive=0` vs default at a fixed camera. Run this on hardware that can actually start the
engine: the environment used for the server work has a Chromium without `exnref`.

The client already exposes the instruments:
- `window.Module.get_render_time_ms()` — engine render time,
- `window.startMicroProfile()` / `stopMicroProfile()` / `dumpMicroProfile(seconds, frames)` —
  engine microprofile HTML with per-pass timings,
- Chrome tracing (CDP `Tracing`, or `chrome://tracing`) for main-thread, worker and GPU time.

Capture, for each scene (lobby standing, lobby with effects, mid-duel, map screen):
1. FPS and 1 % low over 60 s, window visible, effective `renderScale` = 1;
2. `get_render_time_ms()` samples, not just averages;
3. GPU renderer string (`WEBGL_debug_renderer_info`), canvas size, device pixel ratio;
4. the native client at the same place, camera and player count, as the reference point.

Store the table in the README once it exists, with the machine spec next to it.

### 12. Find the dominant frame cost
Each hypothesis gated on a measurement from #11, ordered by expected payoff:
- **Fill rate / overdraw.** RIVALS' lobby is transparency-heavy. Compare 1280×720 against
  1920×1080: frame time scaling with pixels means fill-bound, flat means CPU/draw-call bound.
- **Resolution.** Compare `renderScale` 1 / 0.75 / 0.5. If fill-bound, this is the cheapest
  lever available without touching the engine.
- **Shadows and lighting.** Toggle lighting quality flags; shadow map size is a common cost in
  wasm graphics ports.
- **Draw calls / batching.** The microprofile render pass shows whether instancing collapses
  when many parts share a mesh.
- **Wasm SIMD / threads.** Confirm the build uses SIMD and whether pthreads are active
  (`navigator.hardwareConcurrency`, worker count in the console). A single-threaded render or
  physics loop is a hard ceiling no JS change can lift.
- **Frame pacing vs raw FPS.** Check whether stutter is periodic (GC, texture decode, relay
  bursts) rather than constant; that changes the fix entirely.

### 13. Adaptive quality and an FPS cap
**Frame cap done.** Dynamic `renderScale` exists but is opt-in, and the quality preset is
still open.

- **Frame cap, default 60.** The engine renders once per display refresh. The machine used
  for this work reports a **180 Hz** panel, so it was drawing three frames for every one the
  native client draws at its default cap.
  Measured: 60.0 fps at 16.68 ms capped, 180 fps at 5.56 ms with `?fps=0`, 89.9 fps for
  `?fps=100`.
- **Divisor picker had a floor bug.** "Largest divisor under the target" returns 45 on a
  90 Hz panel — slower than the native client. A divisor is now only used within 10 % below
  to 20 % above the target; otherwise the exact target is used and the cadence repeats.
- **Dynamic `renderScale` is off by default (`?adaptive=1`).** It was judged against a budget
  that was wrong until the display probe finished, so it walked the ratio down every 1.2 s and
  then climbed back for ~30 s. Each step is an engine re-layout, and it was reported as the
  picture **zooming in and out every few seconds** while sitting soft. The persisted ratio made
  every later load soft too, so nothing about the ratio is stored any more and stale values
  are cleared on load.
- **Quality presets done** in the in-game Settings page (frame cap, resolution, Roblox's
  graphics quality, mesh LOD, MSAA, grass). The shadow and post-processing flags older tools used
  (`FIntRenderShadowIntensity`, `FFlagDisablePostFx`) are not in this engine build.
- **Still open:** if adaptation ever comes back on —
  per-scene profiles so the lobby and a mid-duel firefight do not share one ratio target.

---

## Open — overall optimisation

### 14. Startup, memory and network budgets
**Startup** — the client already logs `[WASM-TIMING]`, `[encode]` and per-request proxy lines;
turn them into a cold-vs-warm comparison and record it. Known big items on the first load:
16 MB CJK font, 14 MB `InExperience.rbxm`, 4.1 MB shader pack, 3.3 MB metadata (already gzipped
to ~279 KB). Skip the CJK font unless the locale actually needs it; prefetch the wasm in
parallel with settings + locale instead of after them.

**Memory** — sample `performance.memory` and wasm heap growth over a 10-minute session. The
heap is fixed by `FIntWasmMemoryPages` (32768 pages ≈ 2 GB); confirm actual RSS and whether
it ever fails to grow. Add texture/asset eviction only if a leak is measured.

**Network / proxy** — **dedupe done** (single-flight per cache key: measured 40 concurrent
duplicate requests → 1 upstream call) and **immutable CDN GETs are now browser-cacheable**
(`max-age=604800` for `rbxcdn.com`). **Upstream HTTP/2 done:** warm sessions to the main hosts, a reused CSRF
token, short caches for steady APIs and non-avatar thumbnails, and telemetry answered without waiting. Replaying a
game page's 11 API calls (median of 4 runs): first page 763 to 416 ms, new game 384 to 290 ms and 435 to 305 ms,
revisit 366 to 174 ms. Large assets are unchanged (6.6 MB: 568 to 714 ms on HTTP/1.1, 608 to 822 ms on HTTP/2).
Still open: log the real cache hit rate over a full session and review per-host TTLs.

**Rule:** every item lands with a before/after number in the README, otherwise it does not
land.

---

## Open — asset loading

### 15. Degrade refused assets predictably
- One consolidated console line per refused id plus a counter, instead of silence (blocked ids
  currently surface only through a failed image load, if at all).
- Experiment: substitute a neutral transparent PNG for CDN `UnapprovedImage` URLs at the proxy,
  so blocked thumbnails render as an empty slot rather than a black pill.
- State the retry policy explicitly: never retry `403`/`404`, retry `429`/`5xx` with jittered
  backoff, cap attempts per asset.
- Verify end to end that `200`-with-`errors` batch responses get the 60 s TTL (implemented, not
  yet proven by a log line).

### 16. Prefetch the first frame
- Right after the join script, request what the lobby needs (UI icons, local avatar, equipped
  weapons) instead of discovering them one by one — the first seconds currently pop in.
- Re-test `FFlagWasmPrefetchAllAssets` behind a flag and measure startup cost against pop-in.

### 17. Automate the content import
The 2,730-file copy from `%LOCALAPPDATA%\Roblox\Versions` was done by hand. Add
`tools/import-content.js` that finds the newest installed player, copies only files the bundle
lacks, skips the native D3D/Vulkan shader packs, writes a manifest (count, bytes, source
version) and lists what is still missing. Required to survive an engine update.

---

## Open — Roblox sign-in

### 18. Replace the manual cookie with a real sign-in flow
**Status:** working. With no saved session the engine starts signed out, and its own sign-in
page works through the proxy: Quick Sign In was confirmed end to end.
`auth.roblox.com/v2/login` sets `.ROBLOSECURITY` on a proxied response, `storeCookies` hands it
to `persistSession`, which writes `.roblosecurity` (0600), so it survives restarts; rotated
values Roblox issues later are saved the same way. Deleting the file signs the server out.
Password sign-in is untested (it may need a captcha the web build cannot show).

What is left of the original plan below: a sign-out control, and the expiry path end to end.

Roblox does not publish an OAuth flow that hands a client session cookie to third-party apps,
so the workable design is to let the user sign in through a real browser and capture the
session from that profile. Passwords never touch this code.

Plan:
1. `login.js`: launch a dedicated Chrome profile with `--remote-debugging-port` at
   `https://www.roblox.com/login`, poll CDP `Storage.getCookies` until `.ROBLOSECURITY` appears,
   write it atomically to `.roblosecurity` with owner-only permissions, then close the window.
2. UI state: `Signed in as <name>` via `users.roblox.com/v1/users/authenticated`, with
   "Sign in" / "Sign out" actions.
3. Persist rotation: the server already receives rotated `set-cookie` values; write the newest
   cookie back to disk (opt-in, 0600) so a restart does not silently log the user out.
4. Expiry: detect `401`, show "Session expired — sign in again", and never loop on failed joins.
5. Sign out: delete the file, clear the in-memory jar and session-scoped caches (account,
   thumbnails).
6. Never log the value; redact it from errors; keep it in `.gitignore` (already).

Tests: fresh sign-in, restart persistence, expiry, sign-out, and two accounts in sequence with
no cache bleed.

---

## Done

- [x] **Fullbright option.** Esc > Settings > Fullbright draws everything in its plain colors and applies without a
      rejoin. It patches the frame constants per draw on both renderers and leaves the game's Lighting values alone.
      Checked offline only, so it still needs testing in a game. See `fullbright.js` in `docs/internals.md`.
- [x] **Terrain, lighting and shadow review.** Checked offline only, so it still needs testing in a game.
      WGSL truncated texture array layers, which scattered wrong terrain materials. Ported glass, water,
      forcefield and soft particle shaders read the screen upside down. The light list ended at the first entry
      that looked wrong, so rooms went dark for some view directions. The engine now marks the real end of the list.
      Directional shadows lost their depth clamp in the GL backend, so casters clipped and shadows popped. Also
      fixed: `CLAMP_TO_BORDER` wrapping as repeat, depth blits ignoring rects and formats, packed 16-bit uploads,
      and the render worker failing to load on a fresh profile. See "Light list" and "Depth clamp" in
      `docs/internals.md`.
- [x] **Engine auto-port.** `npm run autoport` moves every patch to a new web client build, builds a complete
      stage, checks it against what the JavaScript assumes and installs it with `--apply`. It rebuilds the live
      engine byte for byte from the pristine download, and undoes shuffled test builds to the same bytes. It has
      not met a real newer build yet, because Roblox has not shipped one. See "Updating the engine" in
      `docs/maintaining.md`.
- [x] **Main-thread rendering split.** The patched engine skips light culling the render worker already does,
      reads particle curve tables directly instead of looking them up per particle, and can draw shadow tiles on a second
      thread with its own GL ring. A governor runs that thread only when main is the limit and the overlap pays off.
      At Level 10, main takes 3 to 8 ms a frame in 10 of the 11 games tested. Grow a Garden's title view is the
      exception at 20 ms, mostly particles. See "Shadow thread" in `docs/internals.md`.
- [x] **Blurry built-in materials.** On web, Grass, Wood, Concrete and the other built-in materials
      are hard-coded `rbxassetid://` texture packs that stream in. `FIntTM2NotSupportedUserMask` =
      3186654 and `FIntTM2SupportedUserMask` = 16 load them whole, and `FIntMaxCloudAssetDimension`
      = 4096 matches Windows and Mac. Confirmed in Grow a Garden. In `WebFlags.json` and the patch
      tool.
- [x] **Blurry studs and plastic.** The texture manager kept the built-in surface textures at
      their 1/16 mip tail and never streamed the top levels. `FIntTM2NotSupportedUserMask` =
      1049238 (Roblox's mask plus bit 9) loads them whole. In `WebFlags.json` and the patch tool.
- [x] **Repository reorganised.** Everything the browser loads lives in `public/` (the site root
      for the Node server and for static hosting); the server is `server/` (`npm start`), source
      art is `art/`. Files outside `public/` are no longer reachable over HTTP.
- [x] **Every join stuck on "Loading experience…".** Roblox enabled
      `FFlagNetworkPerfTestClientAnalysis5` in its live flags; this client stalls after
      connecting while it is on. Forced to `False` in `WebFlags.json` and `tools/patch-engine.js`.
- [x] **`server.js` split** into `server/` modules (config, static, proxy, proxy-cache,
      prefetch, join, relay, session, shader-list, shared). `server.js` is the entry point and
      router. No behaviour change. `PORT` was already configurable.
- [x] **Map tiles, the lobby Play button and other gradient UI had no fill.** The engine's GPU
      gradient path draws nothing under WebGL, silently. `FFlagUIGpuGradient12 = False` in
      `WebFlags.json` (and in `tools/patch-engine.js`) switches back to the CPU path. Found by
      A/B-ing the flag with the new `?flag=Name=Value` page parameter.
- [x] `ASSET_LOG=1` asset audit: logs each id refused inside a `200` batch response and serves
      the list at `/__assets`. A RIVALS join refuses only `17092950809` and `13975429306`, both
      refused for every requester (see README, "Assets Roblox refuses").
- [x] **Error 279 on any port but 3000** — the engine's `whipUrl` and `whip.js`'s relay port are
      hardcoded, but the UDMUX token map lives in the process that served `/v1/join-game` and
      `/local-relay` is origin-pinned to that same port. A page on another port joined through one
      process and relayed through another, so the game server got a zeroed routing header and never
      answered. `server.js` now tags the served `whipUrl` with `?relay=<its port>`, `whip.js` pins
      the session to it, tokens are mirrored to `.cache/udmux-tokens.json` so any local relay can
      use a join handled elsewhere, and the engine script is `no-store` so a stale copy cannot
      quietly undo the pin.
- [x] Engine bundle served locally; load screen and join flow wired end to end.
- [x] Session cookie handling, join UA fallback, `gameFqdn` patch, UDMUX token injection.
- [x] Local relay (WS → UDP) with per-channel bridging and redacted diagnostics.
- [x] wasm delivered as zstd (~30.8 MB, under Chrome's ~40 MB cache limit); immutable assets,
      gzip for text/JSON, in-memory proxy cache — reload transfer down to ~0.4 MB.
- [x] Missing 2,730 content files imported from the installed player (sounds, R6 meshes,
      fonts, particles, sky, cursors).
- [x] Metadata reconciliation so files on disk that the table lacks are still served.
- [x] Native text fields made transparent — no white box over focused chat input.
- [x] **Typed text was invisible, then misaligned** — the engine renders text box content
      *through the native field* (`set_text_input_color` writes `field.style.color`; a
      `FontFace` loader sets the font), and the CSS forced `color: transparent !important`
      on top of it. Then the replacement rules `display: block; width: 100%` on *both* fields
      put two 100%-wide flex items in one row: they shrink to 50% each, so the active field
      occupied the right half of the box (measured at 400 px inside a 600 px box) and an empty
      two-row textarea took the left half. The page now uses Roblox's own `#input-container` /
      `#input-input` / `#input-textarea` rules verbatim — both fields `display: none` until the
      engine activates exactly one, no forced width, height, overflow, font or colour, and
      `field-sizing: content` on the textarea.
- [x] `stencil` restored to `true` in the forced context. It had been turned off to save ~2 MB;
      the engine imports `glStencilFunc`/`glStencilOp`/`glStencilMask` and clips its 2D UI with
      them. This was a genuine latent clipping bug, though *not* the cause of the invisible
      text, which was the native field's colour.
- [x] Device-pixel-ratio double-draw fixed via `renderScale` (verified at 2×).
- [x] Server-side join path: single-flight dedupe, compression off the event loop and capped
      at 512 KB, wasm `Link: rel=preload`, browser-cacheable CDN GETs, `.cache/enc` sweep,
      configurable `PORT`, `/__stats`. Numbers in the README.
- [x] `tools/bench.js`: asset latency, wasm transfer, proxy overhead, coalescing, loop stalls.
- [x] Both transports merged: `node` (server.js) and `wisp` (static + Cobalt) coexist in one
      checkout, selected by `?mode=` or auto-detected from the marker the server injects.
      Node is the default whenever the server serves the page; wisp is opt-in per URL and the
      choice is deliberately not persisted, so it can never outlive the load that asked for it. One
      mode-aware service worker (`/sw.js?mode=`), so a mode switch replaces the registration
      instead of leaving two fetch handlers competing. Verified in both directions.
- [x] Client performance layer (`perf.js`): MSAA and alpha compositing off, discrete-GPU
      context, frame-time sampling, live adaptive resolution through the engine's own
      `getEffectiveDevicePixelRatio` hook, `?hud=1` and `window.perfReport()`.
      *Context attributes, refresh detection and the frame cap verified in a browser;
      frame-time gain with the engine running not yet measured.*
- [x] Frame cap at 60 by default, rounded to an even divisor of the detected refresh rate —
      on the 180 Hz panel used here the engine was drawing 3x the frames the native client
      draws. This is the largest GPU-work reduction available without touching the engine.
- [x] Auth logo replaced with the WEBLOX26 wordmark, in the stock asset's own format (8-bit
      palette + tRNS, 476×88, ink 476×65 centred) and at the weight of the original.
- [x] Home-screen wordmark (the "ROBLOX" beside the SELECT badge) replaced with the same
      WEBLOX26 logo in the FoundationImages sprite sheets: `img_set_1x_1` (0,456 188×36),
      `img_set_2x_3` (0,403 376×70) and `img_set_3x_3` (0,883 564×105). The sprite is 188 units
      wide at every scale; neighbouring sprites start 2 units later, so a wider box clips the
      logo and erases their edge. WEBLOX26 is 7.4:1 against the slot's 5.2:1, so it fills the
      width at about 25 of 36 units tall.
- [x] SELECT badge beside the home logo removed: it is the core content badge driven by the
      account's age-check app policy (`CoreContentBadgeText`), switched off with
      `FFlagEnableCoreContentBadge2=False` in `WebFlags.json`.
- [x] Home logo enlarged by patching the Lua app. `ExtraContent/models/{UniversalApp,
      InExperience}/*.rbxm` hold the app as Luau bytecode (zstd chunks, opcodes encoded as
      op*227). `GetImageSetData` crops the wordmark rect to the logo band (188x26 at 1x, 376x52,
      564x78) and `ROBLOX_LOGO_ASPECT_RATIO` becomes 188/26, all as same-length LOADN/constant
      edits. The `HASH` chunk is BLAKE2b-128 per script and is recomputed; `SIGN` is left stale.
- [x] Edited bundle files no longer stick in the browser cache: the page response carries a
      fingerprint cookie of the bundle and sends `Clear-Site-Data: "cache"` when it changes.
- [x] Join freeze removed: shader programs are pre-linked in parallel at startup from a shared
      list (`gen/shader-warmup.json`, grown by `POST /__shaders`), so the engine's blocking
      link checks hit the browser's program cache (3.3 s → 38 ms on the main thread).
- [x] Asset loading ~2.5x faster: the server prefetches every URL a batch lookup returns, so
      the browser's six-connection limit stops pacing downloads (50% of assets 44.9 s → 16.7 s).
- [x] **Replaced assets rendered as nothing** — the engine rejects a `rbxasset://` file whose
      size disagrees with `WebClient.metadata.json`, and two caches kept it disagreeing: the
      metadata `ETag` was JSON length + file mtime (2458 → 7052 is the same character count,
      so browsers revalidated into a 304 and kept the old table) and the gzip disk cache was
      keyed by path + body length (same key, pre-edit body). The validator is now a hash of the
      patched table, gzip is built once per rebuild, and the table is invalidated when a bundle
      file changes, so swapping an asset no longer needs a server restart.

---

## Known limitations

- Four asset ids are refused by Roblox for every requester (`403`, code 19); the native client
  only shows them from its local KTX2 cache. They cannot be fetched or reconstructed here.
- The engine must run in a visible tab: background/occluded windows throttle the animation
  frame loop and startup stalls at "Loading experience…".
- Browsers without JSPI/`exnref` cannot run the client at all.
- Wisp mode sends the session cookie and every Roblox request through a public relay; node
  mode does not. The two are not interchangeable in trust terms.
- No guarantee that a future engine build keeps the patched `WasmPlayer.js`/`WebFlags.json`
  contract; see "Updating the engine" in docs/maintaining.md.
