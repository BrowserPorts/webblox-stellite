const fs = require('fs');
const path = require('path');
const { BASE } = require('../../../server/config');
const { textureRole } = require('./ktx2');
const { parseModel } = require('./rbxm');
const { normalizeAnimation } = require('./animation');

const RECORDS_DIR = path.join(BASE, '.cache', 'places');
const VIEWER_DIR = path.join(BASE, '.cache', 'viewer');
const ROLES_FILE = path.join(VIEWER_DIR, 'roles.json');
const FILES_DIR = path.resolve(BASE, process.env.SAVE_ASSETS_DIR || 'game-cache');

const IMAGE_EXT = new Set(['png', 'jpg', 'gif', 'webp', 'ktx', 'ktx2', 'dds']);
const SOUND_EXT = new Set(['ogg', 'mp3', 'wav', 'flac']);
const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2']);
const VIDEO_EXT = new Set(['webm', 'mp4']);
const MODEL_PARTS = new Set(['Part', 'MeshPart', 'SpecialMesh', 'Accessory', 'Tool', 'Model', 'Shirt', 'Pants', 'ShirtGraphic']);
const DATA_MODELS = new Set(['HiddenSurfaceRemovalAsset', 'PartOperationAsset', 'RuntimePropertySet']);

const absolute = rel => path.join(FILES_DIR, ...rel.split('/'));

function safePath(rel) {
  const file = path.resolve(absolute(String(rel || '')));
  return file.startsWith(FILES_DIR + path.sep) ? file : null;
}

const assetIdOf = text => (/[?&]id=(\d+)/i.exec(text || '') || /rbxassetid:\/\/(\d+)/i.exec(text || '') || /^(\d{4,})$/.exec(text || '') || [])[1] || null;

const records = new Map();
const models = new Map();
let roles = {};
let rolesDirty = false;
try { roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8')); } catch {}

function saveRoles() {
  if (!rolesDirty) return;
  rolesDirty = false;
  fs.mkdirSync(VIEWER_DIR, { recursive: true });
  fs.writeFileSync(ROLES_FILE, JSON.stringify(roles));
}

function roleOf(rel) {
  if (!rel.endsWith('.ktx2')) return 'color';
  if (roles[rel]) return roles[rel];
  let role = 'color';
  try { role = textureRole(fs.readFileSync(absolute(rel))); } catch {}
  roles[rel] = role;
  rolesDirty = true;
  return role;
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, 'index.json'), 'utf8')); } catch { return {}; }
}

function readRecords(placeId) {
  const file = path.join(RECORDS_DIR, `${placeId}.jsonl`);
  let stat;
  try { stat = fs.statSync(file); } catch { return new Map(); }
  const known = records.get(placeId);
  if (known && known.mtime === stat.mtimeMs && known.size === stat.size) return known.assets;
  const assets = new Map();
  for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!text) continue;
    try {
      const line = JSON.parse(text);
      const asset = assets.get(line.k) || { key: line.k, firstSeen: line.t };
      for (const field of ['id', 'type', 'format', 'bytes', 'file']) if (line[field] != null) asset[field] = line[field];
      assets.set(line.k, asset);
    } catch {}
  }
  records.set(placeId, { mtime: stat.mtimeMs, size: stat.size, assets });
  return assets;
}

function readScene(placeId) {
  const scene = { names: new Map(), meshes: new Map(), images: new Map(), rigs: new Map(), played: new Map(), avatar: new Set(), game: new Set(), any: false };
  let text = '';
  try { text = fs.readFileSync(path.join(RECORDS_DIR, `${placeId}.scene.jsonl`), 'utf8'); } catch { return scene; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    scene.any = true;
    if (item.k === 'avatar') {
      const id = assetIdOf(item.id);
      if (id) scene.avatar.add(id);
      continue;
    }
    if (item.k === 'mesh' || item.k === 'rp') {
      for (const text of [item.m, item.t, item.sa && item.sa.c, item.sa && item.sa.n, item.sa && item.sa.m, item.sa && item.sa.r, item.sa && item.sa.p]) {
        const id = assetIdOf(text);
        if (id) scene.game.add(id);
      }
    } else if (item.id) {
      const id = assetIdOf(item.id);
      if (id) scene.game.add(id);
    }
    if (item.r && ['rig', 'rp', 'rj', 'rb'].includes(item.k)) {
      let rig = scene.rigs.get(item.r);
      if (!rig) {
        rig = { key: item.r, name: item.r.split('#')[0], root: null, parts: new Map(), joints: [], bones: new Set() };
        scene.rigs.set(item.r, rig);
      }
      if (item.k === 'rig') {
        rig.name = item.n || rig.name;
        rig.root = item.root ?? rig.root;
      } else if (item.k === 'rp') rig.parts.set(item.i, item);
      else if (item.k === 'rj') rig.joints.push(item);
      else if (item.k === 'rb') rig.bones.add(item.n);
    } else if (item.k === 'play') {
      const id = assetIdOf(item.id);
      if (!id) continue;
      const set = scene.played.get(id) || new Set();
      set.add(item.r);
      scene.played.set(id, set);
    } else if (item.k === 'mesh') {
      const id = assetIdOf(item.m);
      if (!id) continue;
      if (item.n && !scene.names.has(id)) scene.names.set(id, item.n);
      const list = scene.meshes.get(id) || [];
      list.push(item);
      scene.meshes.set(id, list);
    } else {
      const id = assetIdOf(item.id);
      if (id && item.n && !scene.names.has(id)) scene.names.set(id, item.n);
    }
  }
  return scene;
}

function modelInfo(rel) {
  const file = absolute(rel);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const known = models.get(rel);
  if (known && known.mtime === stat.mtimeMs) return known;
  const info = { mtime: stat.mtimeMs, classes: [], animation: null, links: [], name: null };
  try {
    const model = parseModel(fs.readFileSync(file));
    info.classes = [...new Set(model.instances.map(i => i.className))];
    const root = model.roots[0];
    info.name = root && root.props.Name && !/^(Model|Folder)$/.test(root.props.Name) ? root.props.Name : null;
    const animation = normalizeAnimation(model);
    if (animation) {
      info.animation = { name: animation.name, duration: animation.duration, rig: animation.rig, format: animation.format, keyframes: animation.keyframes, loop: animation.loop, parts: animation.parts };
    }
    for (const inst of model.instances) {
      if (inst.className === 'MeshPart' && inst.props.MeshId) info.links.push(linkFromPart(inst));
      if (inst.className === 'SpecialMesh' && inst.props.MeshId) info.links.push({ m: inst.props.MeshId, t: inst.props.TextureId || '', n: inst.parent && inst.parent.props.Name });
    }
  } catch (err) {
    info.error = err.message;
  }
  models.set(rel, info);
  return info;
}

function linkFromPart(inst) {
  const appearance = inst.children.find(c => c.className === 'SurfaceAppearance');
  const link = { m: inst.props.MeshId, t: inst.props.TextureID || '', n: inst.props.Name, c: inst.props.Color3uint8 };
  if (appearance) {
    link.sa = { c: appearance.props.ColorMap, n: appearance.props.NormalMap, m: appearance.props.MetalnessMap, r: appearance.props.RoughnessMap, p: appearance.props.TexturePack };
  }
  return link;
}

const BONES_FILE = path.join(VIEWER_DIR, 'bones.json');
let boneNames = {};
let bonesDirty = false;
try { boneNames = JSON.parse(fs.readFileSync(BONES_FILE, 'utf8')); } catch {}

function readBoneTable(body, at, boneCount, nameSize) {
  const names = [];
  const table = at + boneCount * 60;
  for (let i = 0; i < boneCount; i++) {
    const start = table + body.readUInt32LE(at + i * 60);
    const end = body.indexOf(0, start);
    names.push(body.toString('utf8', start, end < 0 ? table + nameSize : end));
  }
  return names;
}

function meshBones(rel) {
  if (boneNames[rel]) return boneNames[rel];
  let names = [];
  try {
    const data = fs.readFileSync(absolute(rel));
    const newline = data.indexOf(10);
    const version = data.toString('latin1', 8, newline).trim();
    let at = newline + 1;
    if (version >= '6') {
      while (at + 16 <= data.length) {
        const name = data.toString('latin1', at, at + 8).replace(/\0+$/, '');
        const size = data.readUInt32LE(at + 12);
        if (name === 'SKINNING') {
          const body = data.subarray(at + 16, at + 16 + size);
          const vertices = body.readUInt32LE(0);
          let cursor = 4 + vertices * 8;
          const bones = body.readUInt32LE(cursor);
          cursor += 4;
          const nameSize = body.readUInt32LE(cursor + bones * 60);
          const table = body.subarray(cursor, cursor + bones * 60);
          const namesAt = cursor + bones * 60 + 4;
          for (let i = 0; i < bones; i++) {
            const start = namesAt + table.readUInt32LE(i * 60);
            const end = body.indexOf(0, start);
            names.push(body.toString('utf8', start, end < 0 ? namesAt + nameSize : end));
          }
          break;
        }
        at += 16 + size;
      }
    } else if (version >= '4') {
      const headerSize = data.readUInt16LE(at);
      const vertices = data.readUInt32LE(at + 4);
      const faces = data.readUInt32LE(at + 8);
      const lods = data.readUInt16LE(at + 12);
      const bones = data.readUInt16LE(at + 14);
      const nameSize = data.readUInt32LE(at + 16);
      if (bones) {
        const bonesAt = at + headerSize + vertices * 48 + faces * 12 + lods * 4;
        names = readBoneTable(data, bonesAt, bones, nameSize);
      }
    }
  } catch {}
  boneNames[rel] = names;
  bonesDirty = true;
  return names;
}

function saveBones() {
  if (!bonesDirty) return;
  bonesDirty = false;
  fs.mkdirSync(VIEWER_DIR, { recursive: true });
  fs.writeFileSync(BONES_FILE, JSON.stringify(boneNames));
}

const IGNORED_MATCH = new Set(['HumanoidRootPart', 'RootPart', 'Root', 'root']);

function overlap(parts, names) {
  const wanted = parts.filter(name => !IGNORED_MATCH.has(name));
  if (!wanted.length) return 0;
  return wanted.filter(name => names.has(name)).length / wanted.length;
}

function animationTargets(lib, item) {
  const info = modelInfo(item.rel);
  const parts = (info && info.animation && info.animation.parts) || [];
  const targets = [];
  const custom = item.rig === 'custom';
  const played = (item.id && lib.scene.played.get(item.id)) || new Set();
  for (const rig of lib.scene.rigs.values()) {
    const names = new Set([...rig.parts.values()].map(part => part.n).concat([...rig.bones]));
    const score = overlap(parts, names);
    const explicit = played.has(rig.key);
    if ((explicit && score > 0) || (custom && score >= 0.6)) {
      targets.push({ kind: 'rig', key: rig.key, name: rig.name, match: score, explicit, partCount: rig.parts.size });
    }
  }
  if (custom) {
    for (const mesh of lib.items) {
      if (mesh.category !== 'mesh') continue;
      const bones = meshBones(mesh.rel);
      if (bones.length < 2) continue;
      const score = overlap(parts, new Set(bones));
      if (score >= 0.6) targets.push({ kind: 'mesh', uid: mesh.uid, id: mesh.id, rel: mesh.rel, name: mesh.name || `Mesh ${mesh.id || ''}`.trim(), match: score, explicit: false });
    }
  }
  targets.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.match - a.match);
  return targets.slice(0, 12);
}

function rigScene(placeId, key) {
  const lib = library(placeId);
  const rig = lib.scene.rigs.get(key);
  if (!rig) return null;
  const ordered = [...rig.parts.values()].sort((a, b) => a.i - b.i);
  const position = new Map(ordered.map((part, index) => [part.i, index]));
  return {
    name: rig.name,
    root: rig.root != null && position.has(rig.root) ? position.get(rig.root) : null,
    parts: ordered.map(part => {
      const meshId = assetIdOf(part.m);
      const mesh = meshId && lib.byId.get(`mesh:${meshId}`);
      return {
        name: part.n,
        cframe: part.cf,
        size: part.s,
        scale: part.sc || null,
        color: part.c || null,
        transparency: part.tr || 0,
        meshRel: mesh ? mesh.rel : null,
        textures: textureSet(lib, part),
      };
    }),
    joints: rig.joints.filter(j => position.has(j.a) && position.has(j.b)).map(j => ({ name: j.n, a: position.get(j.a), b: position.get(j.b), motor: Boolean(j.m), c0: j.c0 || null, c1: j.c1 || null })),
  };
}

const fontNames = new Map();

function fontName(rel) {
  if (fontNames.has(rel)) return fontNames.get(rel);
  let name = null;
  try {
    const data = fs.readFileSync(absolute(rel));
    const tables = data.readUInt16BE(4);
    for (let i = 0; i < tables && !name; i++) {
      const entry = 12 + i * 16;
      if (data.toString('latin1', entry, entry + 4) !== 'name') continue;
      const at = data.readUInt32BE(entry + 8);
      const count = data.readUInt16BE(at + 2);
      const strings = at + data.readUInt16BE(at + 4);
      for (let k = 0; k < count; k++) {
        const record = at + 6 + k * 12;
        if (data.readUInt16BE(record + 6) !== 4) continue;
        const raw = data.subarray(strings + data.readUInt16BE(record + 10), strings + data.readUInt16BE(record + 10) + data.readUInt16BE(record + 8));
        const platform = data.readUInt16BE(record);
        name = platform === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le');
        if (platform === 3) break;
      }
    }
  } catch {}
  fontNames.set(rel, name);
  return name;
}

const AVATAR_TYPES = new Set([
  'Hat', 'HairAccessory', 'FaceAccessory', 'NeckAccessory', 'ShoulderAccessory', 'FrontAccessory', 'BackAccessory', 'WaistAccessory',
  'TShirtAccessory', 'ShirtAccessory', 'PantsAccessory', 'JacketAccessory', 'SweaterAccessory', 'ShortsAccessory', 'LeftShoeAccessory',
  'RightShoeAccessory', 'DressSkirtAccessory', 'EyebrowAccessory', 'EyelashAccessory', 'FaceMakeup', 'LipMakeup', 'EyeMakeup',
  'TShirt', 'Shirt', 'Pants', 'Head', 'Face', 'Torso', 'LeftArm', 'RightArm', 'LeftLeg', 'RightLeg', 'DynamicHead', 'Package',
  'ClimbAnimation', 'DeathAnimation', 'FallAnimation', 'IdleAnimation', 'JumpAnimation', 'RunAnimation', 'SwimAnimation', 'WalkAnimation',
  'PoseAnimation', 'MoodAnimation', 'EmoteAnimation', 'MeshHiddenSurfaceRemoval',
]);

function originOf(item, scene, avatarContents) {
  if (item.id && scene.game.has(item.id)) return 'game';
  if (item.id && (scene.avatar.has(item.id) || avatarContents.has(item.id))) return 'avatar';
  if (AVATAR_TYPES.has(item.type)) return 'avatar';
  if (item.thumbnail && /avatar/i.test(item.rel + (item.key || ''))) return 'avatar';
  if (item.category === 'sound' || item.category === 'font' || item.type === 'FontFamily' || item.type === 'LocalizationTableTranslation') return 'game';
  return 'game';
}

const GENERIC_MODEL_NAMES = new Set(['R15', 'R6', 'R15ArtistIntent', 'R15Fixed']);

function categoryOf(ext, rel) {
  if (ext === 'mesh') return 'mesh';
  if (IMAGE_EXT.has(ext)) return 'texture';
  if (SOUND_EXT.has(ext)) return 'sound';
  if (FONT_EXT.has(ext)) return 'font';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (ext === 'rbxm' || ext === 'rbxmx') {
    const info = modelInfo(rel);
    if (!info) return 'data';
    if (info.animation) return 'animation';
    if (info.classes.some(c => DATA_MODELS.has(c))) return 'data';
    if (info.classes.some(c => MODEL_PARTS.has(c))) return 'model';
    return 'data';
  }
  return 'data';
}

const hashOf = key => { const m = key.match(/[0-9a-f]{32}/gi); return m ? m[m.length - 1].toLowerCase() : key; };

const libraries = new Map();

function library(placeId) {
  const assets = readRecords(placeId);
  let sceneStat = 0;
  try { sceneStat = fs.statSync(path.join(RECORDS_DIR, `${placeId}.scene.jsonl`)).mtimeMs; } catch {}
  const known = libraries.get(placeId);
  if (known && known.assets === assets && known.sceneStat === sceneStat) return known;
  const scene = readScene(placeId);
  const groups = new Map();
  for (const asset of assets.values()) {
    if (!asset.file || !fs.existsSync(absolute(asset.file))) continue;
    const ext = path.posix.extname(asset.file).slice(1).toLowerCase();
    const category = categoryOf(ext, asset.file);
    const uid = `${category}:${asset.id || hashOf(asset.key)}`;
    let item = groups.get(uid);
    if (!item) {
      item = { uid, key: asset.key, id: asset.id || null, category, type: asset.type || null, name: null, files: [], bytes: 0, firstSeen: asset.firstSeen, thumbnail: /thumbnails\//i.test(asset.file) || /^tr\.rbxcdn/i.test(asset.key) };
      groups.set(uid, item);
    }
    item.files.push({ rel: asset.file, bytes: asset.bytes || 0, ext });
    item.bytes += asset.bytes || 0;
    if (asset.type && !item.type) item.type = asset.type;
  }
  const items = [...groups.values()];
  const byId = new Map();
  for (const item of items) {
    item.files.sort((a, b) => b.bytes - a.bytes);
    item.rel = item.files[0].rel;
    item.ext = item.files[0].ext;
    if (item.id) byId.set(`${item.category}:${item.id}`, item);
    if (item.id && scene.names.has(item.id)) item.name = scene.names.get(item.id);
    if (item.category === 'animation') {
      const info = modelInfo(item.rel);
      if (info && info.animation) {
        item.duration = info.animation.duration;
        item.rig = info.animation.rig;
        item.keyframes = info.animation.keyframes;
        item.format = info.animation.format;
        item.name ||= info.animation.name;
      }
    } else if (item.category === 'model') {
      const info = modelInfo(item.rel);
      const name = info && info.name;
      item.name ||= name && !GENERIC_MODEL_NAMES.has(name) ? name : item.type;
    } else if (item.category === 'font') {
      item.name ||= fontName(item.rel);
    } else if (item.category === 'texture' && item.files.length > 1) {
      for (const file of item.files) file.role = roleOf(file.rel);
      const color = item.files.find(f => f.role === 'color');
      if (color) {
        item.rel = color.rel;
        item.ext = color.ext;
      }
    }
  }
  const links = new Map(scene.meshes);
  for (const item of items) {
    if (item.category !== 'model') continue;
    const info = modelInfo(item.rel);
    for (const link of (info && info.links) || []) {
      const id = assetIdOf(link.m);
      if (!id) continue;
      const list = links.get(id) || [];
      list.push({ ...link, source: 'model' });
      links.set(id, list);
    }
  }
  for (const item of items) {
    if (item.category === 'mesh' && item.id && links.has(item.id)) {
      item.textured = links.get(item.id).some(l => l.t || (l.sa && (l.sa.c || l.sa.p)));
      item.color = (links.get(item.id).find(l => l.c) || {}).c || null;
      if (!item.name) item.name = links.get(item.id).map(l => l.n).find(Boolean) || null;
    }
  }
  const avatarContents = new Set();
  for (const item of items) {
    if (item.category !== 'model' || !AVATAR_TYPES.has(item.type)) continue;
    const info = modelInfo(item.rel);
    for (const link of (info && info.links) || []) {
      for (const text of [link.m, link.t, link.sa && link.sa.c, link.sa && link.sa.n, link.sa && link.sa.m, link.sa && link.sa.r, link.sa && link.sa.p]) {
        const id = assetIdOf(text);
        if (id) avatarContents.add(id);
      }
    }
  }
  for (const item of items) item.origin = originOf(item, scene, avatarContents);
  const result = { assets, sceneStat, scene, items, byId, links, recorded: scene.any };
  for (const item of items) {
    if (item.category === 'animation') {
      const targets = animationTargets(result, item);
      item.linked = targets.length ? targets[0].name : null;
    }
  }
  saveRoles();
  saveBones();
  libraries.set(placeId, result);
  return result;
}

function listGames() {
  const index = readIndex();
  const out = [];
  for (const [id, meta] of Object.entries(index)) {
    const lib = library(id);
    const shown = lib.items.filter(item => item.origin === 'game');
    if (lib.items.length) out.push({ id, name: meta.name || `Place ${id}`, universeId: meta.universeId, joins: meta.joins, lastJoin: meta.lastJoin, total: shown.length, recorded: lib.recorded });
  }
  return out.sort((a, b) => (b.lastJoin || 0) - (a.lastJoin || 0));
}

const publicItem = item => ({ uid: item.uid, id: item.id, category: item.category, type: item.type, name: item.name, rel: item.rel, ext: item.ext, bytes: item.bytes, firstSeen: item.firstSeen, thumbnail: item.thumbnail, duration: item.duration, rig: item.rig, keyframes: item.keyframes, format: item.format, textured: item.textured, color: item.color, linked: item.linked, maps: item.files.length, origin: item.origin });

function findImage(lib, id) {
  if (!id) return null;
  const local = lib.byId.get(`texture:${id}`);
  if (local) return local;
  for (const placeId of Object.keys(readIndex())) {
    const other = library(placeId).byId.get(`texture:${id}`);
    if (other) return other;
  }
  return null;
}

function textureSet(lib, link) {
  const set = {};
  const take = (slot, text) => {
    const image = findImage(lib, assetIdOf(text));
    if (!image) return;
    if (image.files.length > 1) applyPack(set, image);
    else set[slot] = image.rel;
  };
  const applyPack = (out, pack) => {
    for (const file of pack.files) {
      const role = file.role || roleOf(file.rel);
      if (role === 'color' && !out.map) out.map = file.rel;
      if (role === 'normal' && !out.normal) out.normal = file.rel;
      if (role === 'surface' && !out.surface) out.surface = file.rel;
    }
  };
  const appearance = link.sa || {};
  if (appearance.p) take('map', appearance.p);
  if (appearance.c) take('map', appearance.c);
  if (appearance.n) take('normal', appearance.n);
  if (appearance.m) take('metalness', appearance.m);
  if (appearance.r) take('roughness', appearance.r);
  if (!set.map && link.t) take('map', link.t);
  return set;
}

function assetDetail(placeId, uid) {
  const lib = library(placeId);
  const item = lib.items.find(i => i.uid === uid);
  if (!item) return null;
  const detail = { ...publicItem(item), files: item.files };
  if (item.category === 'mesh' && item.id) {
    const options = [];
    const seen = new Set();
    for (const link of lib.links.get(item.id) || []) {
      const set = textureSet(lib, link);
      const key = JSON.stringify(set);
      if (seen.has(key) || !Object.keys(set).length) continue;
      seen.add(key);
      options.push({ name: link.n || null, source: link.source || 'game', color: link.c || null, material: link.mat || null, textures: set });
    }
    detail.textureOptions = options;
    const colored = (lib.links.get(item.id) || []).find(l => l.c);
    detail.color = colored ? colored.c : null;
    detail.linkKnown = lib.links.has(item.id);
  }
  if (item.category === 'texture' && item.id) {
    const usedBy = [];
    for (const [meshId, list] of lib.links) {
      const uses = list.some(link => [link.t, link.sa && link.sa.c, link.sa && link.sa.p, link.sa && link.sa.n].some(t => assetIdOf(t) === item.id));
      const mesh = uses && lib.byId.get(`mesh:${meshId}`);
      if (mesh) usedBy.push({ uid: mesh.uid, id: mesh.id, name: mesh.name });
    }
    detail.usedBy = usedBy.slice(0, 40);
    if (item.files.length > 1) detail.files = item.files.map(f => ({ ...f, role: f.role || roleOf(f.rel) }));
  }
  if (item.category === 'animation') {
    detail.targets = animationTargets(lib, item);
    saveBones();
  }
  if (item.category === 'model' || item.category === 'data') {
    const info = modelInfo(item.rel);
    detail.classes = info ? info.classes : [];
  }
  return detail;
}

function modelScene(placeId, rel) {
  const file = safePath(rel);
  if (!file) return null;
  const lib = library(placeId);
  const model = parseModel(fs.readFileSync(file));
  const parts = [];
  const insideFolder = (inst, name) => {
    for (let at = inst.parent; at; at = at.parent) if (at.props.Name === name) return true;
    return false;
  };
  const hasIntent = model.instances.some(inst => inst.props.Name === 'R15ArtistIntent');
  for (const inst of model.instances) {
    if (inst.className !== 'MeshPart' && inst.className !== 'Part') continue;
    if (hasIntent && !insideFolder(inst, 'R15ArtistIntent')) continue;
    const special = inst.children.find(c => c.className === 'SpecialMesh');
    const link = inst.className === 'MeshPart' ? linkFromPart(inst) : { m: special && special.props.MeshId, t: special && special.props.TextureId };
    const meshId = assetIdOf(link.m);
    const mesh = meshId && lib.byId.get(`mesh:${meshId}`);
    parts.push({
      name: inst.props.Name,
      cframe: inst.props.CFrame,
      size: inst.props.size || inst.props.Size || [1, 1, 1],
      initialSize: inst.props.InitialSize || null,
      scale: special ? special.props.Scale : null,
      color: inst.props.Color3uint8 || null,
      transparency: inst.props.Transparency || 0,
      meshRel: mesh ? mesh.rel : null,
      missingMesh: meshId && !mesh ? meshId : null,
      textures: textureSet(lib, link),
    });
  }
  const templates = [];
  for (const inst of model.instances) {
    const template = inst.props.ShirtTemplate || inst.props.PantsTemplate || inst.props.Graphic;
    if (!template) continue;
    const image = findImage(lib, assetIdOf(template));
    templates.push({ className: inst.className, id: assetIdOf(template), rel: image ? image.rel : null });
  }
  const tree = model.roots.slice(0, 40).map(function describe(inst) {
    return { className: inst.className, name: inst.props.Name || '', children: inst.children.slice(0, 80).map(describe) };
  });
  return { parts, templates, tree };
}

function animationData(rel) {
  const file = safePath(rel);
  return file ? normalizeAnimation(parseModel(fs.readFileSync(file))) : null;
}

module.exports = { FILES_DIR, VIEWER_DIR, listGames, library, publicItem, assetDetail, modelScene, rigScene, animationData, safePath, roleOf };
