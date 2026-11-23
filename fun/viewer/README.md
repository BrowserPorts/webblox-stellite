# Asset viewer

A local website for browsing what a game loaded: rotate meshes with their textures on, listen to
sounds, look through textures, and play animations.

```bash
SAVE_ASSETS=1 node server
```

```bash
npm run viewer
```

Join a game with the first command running, then open http://localhost:3200/. `VIEWER_PORT` picks a
different port.

## Where things come from

- **Files** are read from `game-cache/`, which `SAVE_ASSETS=1` fills as you play.
- **What belongs to the game** comes from a small script in the engine's settings module. While saving
  is on, it walks the game and reports each part's mesh and textures, every sound, image and animation,
  and each rig's parts and joints, to `.cache/places/<place id>.scene.jsonl`. Anything reported on a player's
  character or an avatar copy is skipped or deleted. Images, meshes, models and animations it never saw are
  kept only if their creator also made something it did see. Sounds and fonts skip that check.
- **Animations** play on the model the game used them with. Failing that, a custom animation looks for a
  recorded rig or a skinned mesh whose part or bone names match. Everything else plays on the R15 rig.
- **The R15 rig** comes from `content-avatar.zip` in the latest Windows Studio build, and its meshes from
  Roblox's asset API. Both are saved under `.cache/viewer/rig/`.

## Files

```
fun/viewer/
├── server.js          Local web server and JSON API
├── ktx2-png.js        npm run ktx2png, writes viewable PNGs beside saved KTX2 textures
├── lib/
│   ├── library.js     Asset index, game and avatar sorting, texture and rig links
│   ├── rbxm.js        Binary and XML model parser
│   ├── animation.js   Keyframe and curve animation reader
│   ├── ktx2.js        KTX2 decoder and texture role detection
│   └── rig.js         Downloads the R15 rig from the Studio package
└── public/
    ├── js/mesh.js     Roblox mesh parser, versions 1 to 7 with Draco and skinning
    ├── js/stage.js    3D scene, rigs and animation sampling
    ├── js/thumbs.js   Mesh thumbnails, cached in the browser
    ├── js/app.js      Browsing and the asset panels
    └── vendor/        three.js, Draco, Lucide
```
