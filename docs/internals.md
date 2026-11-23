# Internals

## How it works

A small Node server serves the engine, signs Roblox requests with your session and patches the join.
Game traffic goes straight from the browser to Roblox over WebTransport.

```
browser: public/index.html ── WasmPlayer.js ── WebClient.wasm
   │                                               │
   │ Roblox HTTP via sw.js                         │ game traffic
   ▼                                               ▼
server/  /__proxy__/<url>                    WebTransport to <name>.qdmux.roblox.com
   │
   └── gamejoin, assetdelivery, CDN, APIs (with your session)
```

1. `public/index.html` registers the service worker and loads the patched `WasmPlayer.js`.
2. The page answers the player's flag request with the pinned set in `PinnedFlags.json`, then merges in
   WebBlox's overrides (`WebFlags.json`), the graphics settings and any `?flag=` values. `?flagset=live`
   asks Roblox's settings CDN instead. See [Pinning the flags](maintaining.md#pinning-the-flags).
3. Every Roblox request goes through `/__proxy__/`. The server attaches the session, caches responses
   and merges duplicate requests.
4. Joins always use the native client's identity, since many places refuse the web client
   ("Playtesters Only"). Native joins don't include a `gameFqdn`, so
   [server/join.js](../server/join.js) builds one from the join script:
   `<token>-<machine>-<port>.<edge>.qdmux.roblox.com`, all in hex. The edge is the UDMUX address with
   the last octet plus one.
5. The engine opens a WebTransport session to that host and plays.

**Assets.** The engine looks up game assets in batches at `assetdelivery.roblox.com`, then downloads
them from `contentdelivery.roblox.com` and `fts.rbxcdn.com`. The server starts downloading everything
a batch lists before the engine asks. The engine also keeps its own asset cache in the browser's
origin-private file system (`rbx-storage`), so a game you've played before loads mostly from disk and
barely shows in the Network tab. Built-in content (fonts, sky, sounds, UI) comes from the engine bundle
in `public/engine/`.

**Home screen.** Roblox compiled the home app's entry points out of this build, and the engine exits
when there's no place id. [tools/backport](../tools/backport) ports those functions from the previous
build into the new `WebClient.wasm`, so the Roblox launcher opens and leaving a game returns to it.

## Engine fixes

`npm run patch` ([tools/patch-engine.js](../tools/patch-engine.js)) applies these to the engine bundle.
Each step reports `applied`, `already applied` or `FAILED`, and `--check` reports without writing.

- **Home screen backport** into `WebClient.wasm`. The tool checks the SHA-256 before and after, so it
  either produces the tested binary or stops.
- **Graphics settings.** [GraphicsSettings.luau](../tools/lua/GraphicsSettings.luau) is compiled to
  Roblox's CoreScript bytecode and placed in `InExperience.rbxm`.
- **Branding.** The WebBlox logo and wordmarks, plus the loader text in `WasmPlayer.js`.
- **Sky textures**, repaired after UTF-8 mangling.
- **Main loop.** `WebClient.js` drove the engine from a 1 ms message loop, thousands of times a second.
  It now runs one step per `requestAnimationFrame`, with a 16 ms timer only while the tab is hidden. On
  the idle home screen that cut main-thread time from 184–258 to 74–111 ms per second, and frame time
  p95 from 32.6 to 17.2 ms.
- **Web views.** The web view iframe loads through the proxy, at `/__proxy__/` in node mode and
  `/__frame__/` through the service worker in Wisp mode.
- **Future lighting gates** in `WebClient.wasm`. The engine only builds its "Future is bright" shadow
  maps and per-pixel local lights for an allowlist of graphics APIs (D3D11, Metal, Vulkan, consoles), so
  the web build fell back to the old shadow path and the lower lighting tiers. The patch adds
  `glsles3_web` to two allowlists and stops the local light check from requiring compute support
  (`LIGHTING_GATES` in the patch tool).

### Flag overrides

These live in `WebFlags.json` and `tools/backport/profile.json`, and apply on top of the flag pin.

| Flag | Why |
|---|---|
| `FFlagUIGpuGradient12=False` | The GPU gradient path draws nothing in WebGL, which hid buttons and panels. |
| `FFlagNetworkPerfTestClientAnalysis5=False` | With it on, joins hang on "Loading experience…". |
| `FIntTM2NotSupportedUserMask=3186654`, `FIntTM2SupportedUserMask=16` | Studs and built-in materials load whole instead of streaming. On web, Grass, Wood, Concrete and the rest are hard-coded `rbxassetid://` texture packs, and streaming left them at low mips. The texture manager uses a material's kind as its user number. These masks cover kinds 2, 3, 6 to 12, 15 and 21. |
| `FIntMaxCloudAssetDimension=4096` | The Windows and Mac value. Roblox doesn't send this flag to web, whose default of 1024 caps every cloud texture. |
| `DFIntNumConcurrentBatchWorkflowsPerAssetProviderInstance` raised | More asset batches resolve at once. |
| `FFlagSmoothClusterUseTextureArrays=True` | Terrain uses 512 px texture arrays like the desktop client, not the 256 px atlas. |
| `FFlagRenderLightIndexTexture2D=False` | The light index texture is the 3D one the shader variants expect. |
| `DFFlagRenderShadowMapInvertChartProcessingOrder=True` | Sorts shadow tile jobs the way the Windows and Mac clients do. Roblox doesn't send this flag to the web client, whose default is off. |
| `FFlagRenderFixCullHandleTransfer=True`, `FFlagShadowFValuesEnabled=True`, `FFlagTerrainShadowSkirtMainCamera=True` | Roblox sends these to the Windows and Mac clients but not to web, whose defaults are off. |

### Page fixes

- [perf.js](../public/js/perf.js) creates the WebGL2 context without MSAA or alpha but keeps the stencil
  buffer, which the engine's UI clipping needs.
- [shaders.js](../public/js/shaders.js) pre-links known shader programs in parallel, which removes the
  multi-second freeze on joins. The shipped list is `public/gen/shader-warmup.json`. Programs the server
  learns while you play go to `.cache/shader-warmup.json`, and the server merges the two.
- [gl-origin.js](../public/js/gl-origin.js) converts sub-rectangle viewports and scissors on depth-only
  framebuffers to GL's bottom-left origin. The engine renders shadow cascades into tiles of one depth
  texture with top-left coordinates. Without this, the near cascades read empty texels and cast no
  shadows. It also sets the star size. The engine draws stars 2 pixels wide in the 3D buffer, which runs
  at half density on a high-DPI screen, so the page shrinks them to keep them 2 screen pixels wide, with
  a minimum of 1 buffer pixel. It also turns on `EXT_depth_clamp` for the engine's depth clamp calls.
- [light-grid.js](../public/js/light-grid.js) fills the local light grid. On desktop a compute pass sorts
  point, spot and surface lights into screen tiles and depth slices. WebGL has no compute, so the page
  does the same on the CPU from the engine's own light list and froxel transform, and only when a light
  or the camera changes.
- [fullbright.js](../public/js/fullbright.js) holds the Fullbright patches. Setting `Lighting` from Lua would show
  in game scripts and fight the ones that set it every frame, so the game's values stay as they are and draws get
  a patched copy of their constants: `fullbrightUbo` in `gl-webgpu.js`, `uploadFullbright` in `ubo-stream.js`.
  Programs that read `CB0` rows 13, 18, 23 or 32 get ambient 1, no sun, fill light, fog or environment specular,
  neutral exposure, and the code paths for outside the light map and far from local lights. Every lighting tier
  then outputs plain albedo. Metals keep their color because the shaders scale metalness by the environment
  specular value. Exposure in `CB0[20]` is `x = 1/y`, `y = 2^ExposureCompensation / z`, and an HDR scale `z` of 4,
  so neutral is `y = 1/z`. Post passes get a patched `CB1`: no color grade, a tone curve that reaches white, a bloom
  threshold of at least 1, and an SSAO distance fade that turns ambient occlusion off. Sky and cloud programs stay
  unpatched because they use the sun color for the sky itself. DoF stays unpatched because it decodes and
  encodes with the same pair of values, so the result is unchanged.
- [mouse-capture.js](../public/js/mouse-capture.js) keeps the pointer locked for the whole game and draws a
  virtual cursor, because Helium always opens its context menu on Shift+right-click while unlocked. The engine's
  own lock requests only freeze the virtual position. `__webbloxMouse.log` lists what capture did.
- [perf.js](../public/js/perf.js) samples gamepads at most once per 8 ms, because the engine asks up to 43 times
  a frame and each `navigator.getGamepads()` builds new objects.
- `index.html` keeps the text-input elements on Roblox's own CSS.

The proxy also turns on web views in the app policy (`apis.roblox.com/guac-v2/v1/bundles/app-policy`), so
Settings and its pages open.

### System theme

Roblox's launcher follows your device's light or dark theme and switches when you change it. The page
reloads on the launcher, and in a game it waits until you return to the launcher.

The web engine has no system-theme support of its own. The patch tool gives `SystemThemeService` a
provider that reads one value from memory, and `index.html` writes `prefers-color-scheme` there (1 light,
2 dark). Two small bytecode edits in `UniversalApp.rbxm` make the launcher start from that system theme.

Theme choices in Settings > Device Preferences work while the launcher is open. The web engine doesn't
persist app storage, so the next launch starts from the device theme again.

## Desktop shaders

Roblox's web shader pack only has the two lowest lighting tiers. `npm run port-shaders`
([tools/port-shaders.js](../tools/port-shaders.js)) adds the desktop tiers by converting the Windows
client's Vulkan pack from the same release. The tool does the following:

- downloads `<windows version>-shaders.zip` from setup.rbxcdn.com into `.cache/shader-port`, and refuses
  a different release unless you pass `--windows <version-hash>` or `--force`
- patches the SPIR-V ([spirv-patch.js](../tools/spirv-patch.js)), converts it to GLSL ES 3.00 with
  `spirv-cross`, and validates it with `spirv-val` and `glslangValidator`
- names samplers from the D3D11 pack's reflection data, since the engine binds some textures (the shadow
  atlas, the BRDF table) by name
- rewrites the normal-map decode to the web's `(x * w, y)` form, because web normal maps aren't stored as
  DXT5nm
- replaces both terrain families with the texture-array versions
- repairs Roblox's own web variants that WebGL rejects (an unsigned uniform index, and the EVSM blur's
  read flip)
- removes the Y flip from `ShadowEvsmClearVS`. It gets the same tile rects as the EVSM copy passes, which
  don't flip, so on WebGL it cleared the mirrored tile and left the empty tile's old contents in place
- rewrites `vec2(0.5, -0.5)` to `vec2(0.5)`. Vulkan's first row is the top of the screen and GL's is the bottom,
  so the Vulkan form made glass, water, forcefields and soft particles read the screen upside down
- sizes uniform arrays to the buffers the web engine binds (the shadowed light block is 84 vectors here,
  not 256), since WebGL refuses to draw with an undersized buffer

It starts from the original pack each time, so you can run it again safely. `--check` reports whether the
pack is ported. About 800 Vulkan variants can't convert (storage buffers, more than 16 texture units,
multisampled textures), and the tool lists them in `.cache/shader-port/failures.txt`.

It needs `spirv-cross`. `spirv-val` and `glslangValidator` are optional. All three ship with the Vulkan
SDK, or run `brew install spirv-cross spirv-tools glslang`.

## WebGPU renderer

The engine only knows WebGL2. [gl-webgpu.js](../public/js/gl-webgpu.js) gives it an object that looks like a
WebGL2 context and runs every call on WebGPU instead. The engine doesn't change. In a browser, WebGL calls
pass through ANGLE, which validates and translates each one and tracks a lot of state. WebGPU skips most of
that, because state is compiled ahead of time into pipelines and bind groups.

The page picks the renderer before the engine starts. It reads `?renderer=`, then a failure flag in
`sessionStorage`, then the saved Renderer setting. When it uses WebGPU it sets `window.__webbloxWebGPU`, and
`ubo-stream.js`, `vertex-state.js`, `shaders.js` and `gl-origin.js` step aside because the layer does those
jobs itself. `light-grid.js` keeps only its culling code, which the layer calls.

**Shaders.** Browsers don't translate GLSL to WGSL at run time, so `npm run build-wgsl`
([tools/build-wgsl.mjs](../tools/build-wgsl.mjs)) does it ahead of time for the whole shader pack: GLSL to
SPIR-V with `glslangValidator`, then `spirv-opt --split-combined-image-sampler`, then WGSL with npm's
`naga-wasm`. The result is `public/gen/wgsl.txt` plus `wgsl-index.json`, keyed by a hash of the normalized
source ([gl-webgpu-key.js](../public/js/gl-webgpu-key.js)). It needs the same Vulkan SDK tools as
`port-shaders`. A shader missing from the table makes the program skip its draws and logs one error.

WGSL takes an integer texture array layer. naga's conversion truncates the value, while GL rounds it. Terrain
passes its layer as a varying, so 3.0 can arrive as 2.9999998 and sample the wrong material, which scatters
wrong materials across the ground. `roundArrayLayers` in the tool rounds every layer.

**Coordinates.** Storage keeps GL's row order. naga's SPIR-V reader already negates `gl_Position.y`, the
engine asks for `clipControl(LOWER_LEFT, ZERO_TO_ONE)` so depth needs no remap, and the layer flips the
front face to match. The default framebuffer is an ordinary texture, and `present()` copies it flipped to
the canvas.

**Uniforms.** The engine writes small uniform blocks into one buffer and overwrites them between draws.
The layer keeps a CPU copy, tracks each 256-byte granule's last write, copies only changed blocks into a
64 MB ring and binds them with dynamic offsets. A DOORS lobby frame writes about 18 MB this way, mostly
bone matrices.

**Failure.** No WebGPU, no adapter, a missing feature, a missing shader table or a lost device all set the
`sessionStorage` flag and reload on WebGL. So does a burst of 200 GPU errors. The layer has no silent
success path: `window.__webgpuGL.errors` lists what went wrong.

**Frame pacing.** On WebGL the main loop runs once per display frame. Under WebGPU, when a frame takes
longer than a display period, `__webbloxFrameLate` in [perf.js](../public/js/perf.js) starts the next one
as soon as the period has passed. Without this a 17 ms frame waits for the next vsync and DOORS sits at
33 ms per frame. The engine returns from an iteration without drawing if called within about 0.5 ms of
finishing the previous frame, so empty iterations retry straight away instead of waiting a whole period.
The loop also holds the next frame when three are already waiting on the GPU, which caps input latency.

A frame cap above the display's refresh rate can't use `requestAnimationFrame`, so on both renderers the loop
then runs on a timer in `perf.js`. The engine has its own limit of 240 fps and renders on a 4.17 ms grid, so
caps that don't fit the grid, like 144, hit the right average with uneven gaps.

**Presenting.** The engine can suspend through JSPI partway through a main loop iteration, so the layer
presents when the iteration finishes, not when the browser next runs microtasks. Presenting earlier put
half-drawn frames on screen as black, grey or white flashes. The canvas blit has its own submit, because one
GPU error invalidates a whole command buffer. WebGL drops a single out-of-range draw, while WebGPU would
lose the frame, so the layer checks index and vertex ranges and skips those draws.

**Reporting capabilities.** The engine reads `CLIP_DEPTH_MODE` back after enabling clip control. If it doesn't
get `ZERO_TO_ONE`, it picks shaders that treat depth as -1 to 1, which corrupts the EVSM shadow atlas and shows
up as a missing sun, the sky drawing over objects and flickering lights. `getParameter` answers these itself
and sends everything else to a probe WebGL context, so a new query can return `null` from the probe. Compare
new values against a real WebGL context.

**Light list.** The engine writes all 16320 bytes of the CB6 light block and never uploads a count, so past the
real lights is stale data from earlier frames. The patch adds one store to the writer (wasm 17775) that sets the
range field of the first unused entry to 0. A real light's packed range is at least 10.71, so `lightCount` in
[light-grid.js](../public/js/light-grid.js) stops at the first value below 10.

Don't go back to judging the list by its contents. An earlier version stopped at the first entry that looked
wrong, such as a repeated shadow slot or a colour above 10000. The list follows the camera, so one such light
switched off every light after it for some view directions and not others, and rooms went dark until the camera
turned. Culling also uses the light's full range now. A cutoff at a brightness of 0.5/255 dropped dim lights and
left blocky 32 px steps in dark rooms.

The grid rebuilds when any light field changes except the slot, which the engine reshuffles every frame, so a
spotlight that only rotates still updates its cells.

To check lighting for flicker, read the inputs instead of judging frames. Compare CB6, CB7 and CB8 as the
shader receives them from the ring, then downsample the shadow atlas each frame and count texels that go
A, B, A. A moving player's shadow changes without snapping back. Public servers are too busy for pixel scores,
because players walking past the camera look like flicker.

**Depth clamp.** Directional shadows need depth clamp, so casters outside a cascade's near and far planes still
write depth. The engine asks for it in byte 3 of its raster state and picks shaders that rely on it (key 0, not
the `gl_FragDepth` fallback at key 0x40), but its GL backend (wasm 135466) never made the GL call. Those casters
were clipped, so their shadows popped in and out as the cascades followed the camera, and sun could leak indoors.
The patch adds the `glEnable`/`glDisable`. The layer turns it into `unclippedDepth` when the adapter has
`depth-clip-control` and reports `EXT_depth_clamp` only then, so without the feature the engine picks its fallback
shaders. WebGL uses the extension directly.

**Render worker.** [gl-bridge.js](../public/js/gl-bridge.js) assembles a small wasm module at run time that
records 37 hot GL calls into a shared 128 MB ring. The engine calls it wasm to wasm, so a draw costs no JS
boundary. [gl-worker.js](../public/js/gl-worker.js) reads the ring and runs the `GL` class on an
`OffscreenCanvas`. `?glworker=0` turns this off, and so does a missing browser feature or the
`webblox.glWorkerOff` flag in `sessionStorage`.

**Shadow thread.** The engine draws on one thread, and shadows were the largest part of that frame. So the
patched engine moves shadow tile rendering (wasm 17952, called from `ShadowMapSystem::updatePerform`) to a
pthread. [gl-thread.js](../public/js/gl-thread.js) runs in that pthread and gives it its own recorder and a
second ring. The frame goes like this:

1. `updatePerform` on main skips its atlas packing and occlusion loops and stores the tile job list.
2. Main gathers its own view. Scene prepare (wasm 17417) then writes `glEnable(0x7E5A0001)` to ring 1 and wakes
   the helper.
3. The helper runs the shadow occlusion tests, packs the atlas, gathers and draws every tile, then writes
   `glEnable(0x7E5A0002)` to ring 2. Texture marks that main makes during the job wait in a queue that the helper
   drains, because the texture manager isn't safe to touch from both threads.
4. Main keeps going with particles and draws, then waits for the helper before it changes the cull tree, at the
   end of `renderPerform`, and at frame end.
5. The worker switches to ring 2 at the first marker and back at the second, saving and restoring GL state
   around it. GL order is the same as drawing everything on one thread.

The helper gets a copy of the device context and a fake device with two uniform streamers of its own, refreshed
at each kick, because the context caches GL state. With the helper on, main allows one more frame in flight. GL
calls outside the hot set (`glGenBuffers` when a streamer grows) go to main, which serves them while it waits.
Allocation and thread creation happen inside wasm, because JSPI can't suspend through JS frames.

Sharing was checked with a race detector: an instrumented engine records every read and write in the helper's
job and the rest of the frame, and lists addresses touched by both with a write. In DOORS, Jailbreak and Grow a
Garden that left:

- The shader lookup's scratch string (wasm 17785), which takes a lock.
- Per-cluster LOD state in gather (wasm 15523, 16176), which takes the same lock, held per cluster.
- The instancing buffer in cluster prepare and draw (wasm 15520, 15573). The helper runs private copies that use
  their own vector and three extra cluster fields, so draws never wait for each other.
- Draw statistics, which are plain counters, the render size read for LOD, and a field in terrain batches that both
  threads set to the same value. All are harmless.

The helper doesn't run all the time. A thread that sleeps between jobs runs about 1.4 times slower than the main
thread on this Mac, and main saves only the time it has other work to do. If H is the helper's job, Q is main's
work after the kick and P is main's work before it, a frame takes P + max(H, Q). In DOORS, H is much longer than Q,
so main would spin at the join and burn CPU for nothing. `governHelper` in
[gl-bridge.js](../public/js/gl-bridge.js) therefore starts it only when main takes over 85% of a frame that's
slower than 12 ms. It stops the helper when main drops below 60%, or when the time the overlap saves falls under
8% of the frame, and in that second case tries again 10 s later. `?helper=1` forces the thread on with no governor,
and writing byte 768 (bit 4) then toggles jobs for A/B tests. `?helper=0` turns it off.

If a helper job throws, shadows go back to main for the session, and `webblox.helperOff` keeps them there until
the tab closes. If the helper stops answering for 30 s, the page reloads without it.
`window.__webgpuGL.sideF64[15]` is the helper's total job time in ms, and `sideF64[14]` counts GL calls it sent
to main.

Toggling the helper inside one session can hide costs that outlast the toggle, so also compare whole sessions with
`?helper=0`. That's how a lost frame counter was found: the worker wrote `DONE` through the active ring's control
block, so a GPU completion that landed during a ring switch never reached main, which then held itself back to one
frame in flight and capped DOORS at 38 fps with the GPU idle 5 ms a frame.

**Redundant engine work.** Two more patches take time off main. The engine's CPU light culling fills textures
12 and 13, and the render worker replaces both with [light-grid.js](../public/js/light-grid.js) results, so the
patch skips it (`?lightcull=1` restores it). Particle vertex fill looked up three curve tables for every particle,
each with a hash probe, a 512-byte compare and a 512-byte copy, even though the emitter's key already points at the
table. It now reads through that pointer, which took the fill from 2.6 ms to 0.3 ms a frame in Grow a Garden. The fill
reads 12 bytes past a table for newborn particles and multiplies them by zero, so the patch also pads each table with
zeros. Heap bytes there could be NaN, and NaN times zero is still NaN.

**Tracing.** Start the server with `GL_TRACE=1` and open `?renderer=webgl&gltrace=<frames>&gltracename=<name>`
to record every GL call to `.cache/gl-traces/<name>`. Recording needs `renderer=webgl`, because the recorder
hooks the WebGL prototype. [tools/gl-replay-run.js](../tools/gl-replay-run.js) plays a trace on either
backend, and [tools/gl-replay-compare.js](../tools/gl-replay-compare.js) compares the frames pixel by pixel.
Set `CHROME` to a Chromium executable and make `puppeteer-core` reachable through `NODE_PATH`.

Don't trust `perfReport()` fps or the `requestAnimationFrame` rate when comparing renderers, since both can
read 60 while the engine draws far less. Count `window.__webgpuGL.stats.frames` per second. Per-pass GPU
timestamps aren't reliable on Apple GPUs, so removing passes in a replay is the better test.

## Layout

```
webblox/
├── public/      site root: index.html, sw.js, js/, gen/, launcher/, the engine bundle
├── server/      Node server: proxy, join, settings, static files, cache
├── tools/       patch-engine.js, smoke.js, update-engine.js, update-launcher.js, prep.js, bench.js, lua/, backport/, autoport/
├── fun/         the local asset viewer
├── art/         logo and loader artwork the patch tool uses
├── archive/     old launcher experiments, not used by the app
└── docs/        these docs
```
