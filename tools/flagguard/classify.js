'use strict';

const SUBSYSTEMS = [
  ['Luau', /Luau|Codegen|CodeGen|LuaVM|Bytecode|Lua(?=[A-Z])|Gc(?=[A-Z])|Script/],
  ['Terrain', /Terrain|Voxel|SmoothCluster|Water(?!mark)/],
  ['Rendering', /Render|Graphics|Gfx|Shadow|Light|Texture|Shader|Gpu|GPU|Mesh|Material|Fog|Sky|Atmosphere|Bloom|Particle|Decal|Msaa|MSAA|Lod|LOD|CSG|FRM|Frm|Draw|Culling|Occlusion|Video|Image|Transcode/],
  ['Physics', /Physics|Sim(?=[A-Z])|Solver|Collision|Contact|Humanoid|Constraint|Aerodynamic|Assembly|Raycast|Joint|Pathfinding|Kinematic/],
  ['Network', /Network|Replicat|RakNet|Raknet|Packet|Stream|Http|Transport|Quic|Udp|Join|Teleport|Server|Ping|Bandwidth|Connection|Socket/],
  ['Assets', /Asset|Content|Download|Cache|Preload|Package|Bundle|Rbxm|Model(?=[A-Z])/],
  ['Audio', /Audio|Sound|Voice|Speech|Microphone|Mic(?=[A-Z])/],
  ['Avatar', /Avatar|Animat|Anim(?=[A-Z])|Emote|Accessory|Facial|Rig(?=[A-Z])|R15|R6|Outfit|Catalog|Layered|Cage/],
  ['Input', /Input|Mouse|Keyboard|Touch|Gamepad|Cursor|Gesture|Controller/],
  ['Interface', /Gui|UI(?=[A-Z])|Text|Font|Chat|TopBar|Menu|Button|Layout|Notification|Toast|Prompt|Dialog|Screen/],
  ['Performance', /Memory|TaskScheduler|Thread|Perf|Fps|Frame|Budget|Job(?=[A-Z])|Tick/],
];
const NOISE = /Telemetry|Influx|Analytics|Report(?!Abuse)|Reporting|Throttle|HundredthsPercent|PercentHundredths|Hundreth|Sampl|Counter|Metric|Stats(?=[A-Z]|$)|Logging|Breadcrumb|Sentry|Diag|Tracing|Trace(?=[A-Z]|$)|Benchmark|Ephemeral/;
const OTHER_PLATFORMS = /Android|iOS|IOS(?=[A-Z])|Xbox|PlayStation|PS4|PS5|Console|Quest|OpenXr|VR(?=[A-Z])|Steam|Gdk|GDK|Windows(?=[A-Z])|Win32|D3D|Direct3D|Vulkan|Metal|MacOS|OSX|Tencent|Studio|Rcc|RCC/;

const BOOKKEEPING = /FlagRepoGitHash|FlipTimeStamp/;

function subsystemOf(name) {
  for (const [label, pattern] of SUBSYSTEMS) if (pattern.test(name)) return label;
  return 'Other';
}

function noiseOf(key) {
  if (BOOKKEEPING.test(key)) return 'bookkeeping';
  if (/^(?:DF|F)Log/.test(key)) return 'logging';
  if (NOISE.test(key)) return 'telemetry';
  if (OTHER_PLATFORMS.test(key)) return 'other platforms';
  return null;
}

module.exports = { subsystemOf, noiseOf };
