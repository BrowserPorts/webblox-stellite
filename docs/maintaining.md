# Maintaining

## Updating the engine

Every WebBlox patch is tied to one engine build. `npm run autoport` moves all of them to a new build and
checks the result. It works in `.cache/engine-update/<version>` and leaves `public/` alone until you
install the result.

1. Run `npm run autoport`. It downloads the live web client, matches its functions against the current
   build, ports every patch and builds a complete copy of `public/engine` and `public/gen` called the stage.
   The first run for a build takes a few minutes. Later runs reuse the saved function match.
2. Read `.cache/engine-update/<version>/report.md`. It lists every patch with its status, anything worth
   checking by hand, and what the contract checks found.
3. Run `npm run autoport -- --smoke` to boot the stage in a headless browser. When the boot fails, the smoke test prints
   the last console errors and saves the whole console next to the screenshot.
4. Run `npm run autoport -- --apply`, restart the server and play a few games. `--apply` swaps in the stage,
   updates the version in `server/config.js`, `public/index.html` and `TODO.md`, and replaces the plans in
   `tools/backport`. `npm run autoport -- --rollback` undoes all of that.
5. Run `npm run flags -- pin` to read fresh experiment values and test the new build's flag pin. See
   [Pinning the flags](#pinning-the-flags).
6. Commit the result.

`npm run update-engine` prints the current and live builds. `npm run autoport -- --help` lists every option.

The tool exits with 0 when the stage is ready, 2 when it works without some optional patches, and 1 when
it stopped. A stopped run changes nothing in `public/`. A stage that is missing optional patches installs
only with `--allow-partial`.

### What it ports

| Patch | How it moves to a new build | If it fails |
| --- | --- | --- |
| Home screen backport | Translates each function, table slot, string and data address in the 44 backported functions | Stops the update |
| System theme provider | Finds the vtable by address and checks its functions | Optional. The launcher stops following the device theme |
| Future lighting gates | Finds the three checks by pattern, and the shader pack names by text | Optional. Future lighting stays off |
| Light list end, raster depth clamp | Regenerated from patterns | Stops the update, because stale lights and clipped shadows would ship |
| Particle curves, bounds update, light cull skip, shadow thread | Regenerated from patterns | Optional. Each one costs main thread time |
| `WebClient.js` patches | Follows renamed minified identifiers | Stops the update |
| `WasmPlayer.js` wording | Follows renamed minified identifiers | Optional unless the patch calls WebBlox code |
| Lua bytecode edits and sprite rects | Finds each function by shape and re-reads the sprite table | Optional, except a replaced script that vanished |
| Desktop shaders, WGSL table | Runs `tools/port-shaders.js` and `tools/build-wgsl.mjs` on the stage | Stops the update |
| Flag overrides in `profile.json` | Moves an override to the new key when Roblox bumps the flag's version | Warns. Nothing reads a lost override |
| Flag pin | Pins the live flags for the new build, with the old pin's experiment values | Warns. The page uses live flags until you pin |

### How it checks itself

The function matcher is only a starting point. It compares both builds using strings, call graphs, constants
and vtables. From 0.745 to 0.746 it matched 135,359 of 167,913 functions, which cover 88% of the old code. Its
weak answers can be wrong, so a patch never trusts them. Each patch describes the code it edits as a small pattern with holes, and a hole binds
to whatever the new build has there: a struct offset, a local or a callee. A missing or ambiguous site fails
that one unit with the closest match and a code listing. The unit rolls back and the others carry on, so a
single run reports every problem at once.

A reference with no direct match isn't a failure yet. These checks look for its new home, and the report lists every answer under "Worth checking by hand":

| Problem | How the tool resolves it |
| --- | --- |
| The linker merged identical functions, or a function became a thunk | Follows the aligned call sites of matched callers to the function they now call |
| A function only lives in a vtable or an ops table | Finds a new function with the same callees and the same table contents, the same stores from the same fields, or the same neighbours in its table |
| A fuzzy match picked a function that does different work | The store comparison catches it and picks one that does the same stores |
| The compiler reordered the statements around a data address | Matches each constant by how the next instructions use it, keeping data and BSS apart |
| Roblox added virtual methods to a class the backport calls | Reads the receiver's vtable from its getter and moves the call to the method's new offset |
| Roblox edited code inside a `WebClient.js` patch | Merges the edit into the patch when it falls in code the patch keeps, and stops with the conflicting text when it doesn't |

After porting, the contract checks test what the JavaScript side assumes:

- The render worker still records GL calls the engine imports, with the same argument counts.
- The frame constant struct has not changed, so the rows in `fullbright.js` and `light-grid.js` still hold.
- Light entries are still 5 rows and the froxel transform is still at row 54.
- Fullbright treats every shader the same way it did.
- V8 and `wasm-tools` accept the patched module, and the patched JavaScript parses.
- The patches applied by `tools/patch-engine.js` reproduce the hash the planner recorded.

The contracts cannot see behaviour. A clean report means the patches landed where they should, and playing a
few games is still the final check.

### Where the data lives

`tools/backport/profile.json` holds every value tied to one build, and `tools/patch-engine.js` applies exactly
what it says. The profile and the plans next to it are the output of the last port and the input of the next.
`pristine.delta` rebuilds the unpatched `WebClient.wasm` from the patched one, because Roblox's CDN drops old
builds. It is about 3 KB.

### When a unit fails

Open the report and find the unit. Its code listing shows the closest match in the new build.

1. Change the pattern in [tools/autoport/patches](../tools/autoport/patches). `render-threads.js` holds the
   thread, light and depth patches, and `engine-wasm.js` holds the theme and gates. Use `gap(n)` where the
   compiler may reorder a few harmless instructions, and keep patterns short.
2. Run `npm run autoport` again. The saved match makes this take about a minute.
3. If the match itself is wrong, the report's named functions table shows it. A pattern that names a callee
   binds the true function and overrides the matcher.

If a contract check fails, the JavaScript in `public/js` needs changing to match the new build.

### Testing the tool

- `npm run autoport:test` runs the unit tests in a few seconds.
- `npm run autoport -- --selftest` rebuilds the live engine from its pristine download and compares every file
  with `public/`. Run it after changing a patch or the tool. `UniversalApp.rbxm` may differ in its compiled bundle
  when the live file came from another Windows upload with the same checksum. The report notes this.
- `node tools/autoport/test/scenarios.js` fakes new builds with a known answer: shuffled functions, renumbered
  locals, moved data, moved struct fields, renamed JavaScript, removed patch sites, and two updates in a row.
  Undoing a shuffle after a port must give the live engine byte for byte. It needs the pristine build in
  `.cache/engine-builds` and takes about 7 minutes. Pass `boot` to port a shuffled build and boot it to the
  launcher in a headless browser instead.

## Updating the launcher files

The web bundle no longer ships `UniversalApp.rbxm`, so `UniversalApp.rbxm` and `InExperience.rbxm` both
come from the latest Windows client. The server checks when it starts and then every hour.
`npm run update-launcher` runs the same check by hand.

- The tool replaces a file only when its checksum in the Windows package changes. It patches the new files
  in a staging folder and moves them into the bundle once every patch applies, so a running server never
  serves an unpatched file.
- If a patch no longer fits, the tool ports it to the new files and saves the result in
  `tools/backport/profile.json`, which then shows up in `git status`. If that fails, the current files stay and
  the log says so. Run `npm run autoport -- --force` for a full report.
- If Windows and the engine are on different releases, the current files stay until they match. `--force`
  takes the Windows files anyway.
- An update changes tracked files in `public/`, so it shows up in `git status`.

## Pinning the flags

The engine build is fixed, but Roblox edits its fast flags several times a day, and the engine used to read
them live on every launch. In one day the web channel gained 160 flags. Bugs such as the future lighting
flicker and hung joins came from flags. Flag Guard pins the flags instead. The page gives the engine
`public/engine/PinnedFlags.json` and only asks Roblox when you choose to. `WebFlags.json`, the graphics
settings and `?flag=` still apply on top of the pin.

`npm run flags` fetches the live flags and lists what changed since the pin, sorted by what each change does
to this build. Most changes do nothing here, because this build never reads the flag, the new value equals the
compiled default, or the flag only sends telemetry. The server runs the same check an hour after it starts and
then every hour, and prints one line when the answer changes.

### Taking new flags

1. Run `npm run flags -- test --set live` to boot the live flags in a headless browser, or open
   `http://localhost:3000/?flagset=live` and play. The parameter stays when you start a game from the launcher.
2. Run `npm run flags -- pin`. It boots once to read this account's experiment values, boots again to test the
   new set, and writes the pin only if the test passes.
3. To take a few changes and leave the rest, run `npm run flags -- accept <key> [<key> ...]`.

The test boot checks that the engine starts, that the page used the set, that every engine flag holds the
value the set asks for, that every WebBlox override took effect, and that the screen is not blank. It reads
each flag straight from engine memory, so a flag that silently fails to apply shows up by name. A few flags
are rewritten by the engine itself, such as the texture budgets. The first pin remembers those, and later
tests list them without failing.

A pin leaves out staged rollouts (`_Staged` keys). Roblox ramps those up over minutes on a timer, so the same
flag could differ from one launch to the next. It also pins the experiment values (IXP). Roblox assigns those
per account, the engine caches them, and they change flag values too, so a fresh browser profile used to run
with different flags than the one you play in.

### Finding a bad flag

When something broke between two sets, `npm run flags -- bisect start` splits the changes between the pin
(good) and the live flags (bad) and writes a test set. Open `http://localhost:3000/?flagset=bisect`, check for
the problem, and answer `npm run flags -- bisect good`, `bad` or `skip`. About seven answers find one flag
among 100 changes, and the search still works when it takes two flags together. `--good` and `--bad` take any
set name, so `--good pinned --bad parity` works too. `npm run flags -- bisect auto` uses the headless test as
the judge, which only finds problems the test can see, such as a failed boot or a blank screen.

Named sets are served by the Node server at `/__flagset/<name>.json`. Restart the server once after updating
WebBlox so it knows the route.

### Desktop parity

`npm run flags -- parity` lists the engine flags where the Mac and PC channels agree and the web channel
differs. It compares the value the engine ends up with, not the raw text. The decisions live in
[tools/flagguard/parity.json](../tools/flagguard/parity.json). `adopt` takes the desktop value, and `keep` keeps
web's with a reason. Adopted flags form the `parity` set, which is the pin plus those flags. Test it with
`npm run flags -- test --set parity` and in game with `?flagset=parity`. Once it holds up,
`npm run flags -- adopt` writes the adopted flags into `profile.json` and `WebFlags.json` as permanent
overrides. `adopt Key=Value` does the same for any key.

### Other commands

- `npm run flags -- explain <key>` shows who reads a key, its compiled default, and its value in the pin, live
  and on desktop. For a dead key it names the key the build reads instead.
- `npm run flags -- history [key]` shows when Roblox changed flags. Every status, check and pin run adds to it.
- `npm run flags -- diff` lists every change, and `--all` adds the ones with no effect.

### How it knows what the engine reads

Flag names in the engine are not enough. Roblox now versions many flags. The engine registers
`UseRbxTransportClient` with version 3 and reads only the key `FFlagUseRbxTransportClient3`, so the plain key
does nothing. A `DFFlag` key does nothing for a flag registered as `FFlag`. `tools/flagguard/table.js` reads
all of this from the wasm:

- the registration calls for flags, ints, logs and strings, with each flag's compiled default from the data
  section,
- the version of each flag, by running the start-up code that builds the name strings in a small interpreter
  (`tools/flagguard/machine.js`),
- Luau's own flags, from the linked lists the start-up code builds,
- names the engine looks up at run time, such as API members gated by a flag,
- and the flags the Lua scripts define, with their defaults, from the bytecode in the models.

On the current build the table matches engine memory for 12,778 of 12,785 flags after a real boot. The rest
are flags the engine rewrites itself. The table is cached per build in `.cache/flagguard`.

### Where the flag data lives

| Path | What it holds |
| --- | --- |
| `public/engine/PinnedFlags.json` | The pin: the engine version, the time, the flags and the experiment values |
| `public/engine/WebFlags.json` | WebBlox's overrides, applied on top of the pin |
| `tools/flagguard/parity.json` | Desktop parity decisions with a reason for each flag |
| `.cache/flagguard/` | The flag table, channel snapshots, history, test sets, test results and screenshots |

A pin made for another engine build is skipped, so the page falls back to live flags instead of applying
stale ones. Auto-Port writes a new pin for each new build.

### Testing Flag Guard

`npm run flags:test` runs the unit tests. They build a small fake engine with every kind of flag
registration, run the page's flag code in a sandbox, and check the bisect search with known answers.
