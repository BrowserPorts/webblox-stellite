const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { BASE } = require('../../../server/config');
const { parseModel } = require('./rbxm');

const DIR = path.join(BASE, '.cache', 'viewer', 'rig');
const VERSION_URL = 'https://clientsettingscdn.roblox.com/v2/client-version/WindowsStudio64';
const PACKAGE_URL = (version, name) => `https://setup.rbxcdn.com/${version}-${name}.zip`;
const BATCH_URL = 'https://assetdelivery.roblox.com/v1/assets/batch';
const RIG_FILES = { R15: 'characterR15.rbxm', R6: 'characterR6NoFace.rbxm' };

const state = { status: 'starting', error: null, version: null, rigs: null, dir: null };

function zipEntries(zip) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('latin1', at + 46, at + 46 + nameLength).replace(/\\/g, '/').replace(/^\/+/, '');
    entries.set(name, () => {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compressed);
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.split('?')[0]} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadAssets(ids, dir) {
  if (!ids.length) return;
  const { cookieHeader } = require('../../../server/session');
  const body = JSON.stringify(ids.map((id, i) => ({ assetId: Number(id), requestId: String(i) })));
  const res = await fetch(BATCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Roblox/WinInet', cookie: cookieHeader() },
    body,
  });
  if (!res.ok) throw new Error(`asset lookup answered ${res.status}; sign in to WebBlox first`);
  const answers = await res.json();
  for (const answer of answers) {
    if (!answer.location) continue;
    const id = ids[Number(answer.requestId)];
    fs.writeFileSync(path.join(dir, `${id}.mesh`), await download(answer.location));
  }
}

const assetId = url => (/[?&]id=(\d+)/i.exec(url || '') || /rbxassetid:\/\/(\d+)/i.exec(url || '') || [])[1] || null;

function describeRig(model) {
  const parts = [];
  const joints = [];
  for (const inst of model.instances) {
    if (inst.className === 'Motor6D' && inst.props.Part0 && inst.props.Part1) {
      joints.push({
        name: inst.props.Name,
        part0: inst.props.Part0.props.Name,
        part1: inst.props.Part1.props.Name,
        c0: inst.props.C0,
        c1: inst.props.C1,
      });
    }
    if (inst.className !== 'Part' && inst.className !== 'MeshPart') continue;
    const special = inst.children.find(c => c.className === 'SpecialMesh');
    const decal = inst.children.find(c => c.className === 'Decal');
    parts.push({
      name: inst.props.Name,
      cframe: inst.props.CFrame,
      size: inst.props.size || inst.props.Size || [1, 1, 1],
      initialSize: inst.props.InitialSize || null,
      color: inst.props.Color3uint8 || [0.64, 0.64, 0.65],
      transparency: inst.props.Transparency || 0,
      mesh: inst.props.MeshId || (special && special.props.MeshId) || '',
      meshType: special ? special.props.MeshType : null,
      scale: special ? special.props.Scale : null,
      face: Boolean(decal),
    });
  }
  return { parts, joints };
}

async function build(version) {
  const dir = path.join(DIR, version);
  const marker = path.join(dir, 'rig.json');
  if (fs.existsSync(marker)) return { dir, rigs: JSON.parse(fs.readFileSync(marker, 'utf8')) };
  state.status = 'downloading';
  fs.mkdirSync(dir, { recursive: true });
  const avatar = zipEntries(await download(PACKAGE_URL(version, 'content-avatar')));
  const rigs = {};
  const ids = new Set();
  for (const [type, file] of Object.entries(RIG_FILES)) {
    const entry = avatar.get(file);
    if (!entry) throw new Error(`${file} is not in the Studio package`);
    rigs[type] = describeRig(parseModel(entry()));
    for (const part of rigs[type].parts) {
      const id = assetId(part.mesh);
      if (id) {
        ids.add(id);
        part.file = `${id}.mesh`;
      } else if (/^rbxasset:\/\/avatar\//i.test(part.mesh)) {
        part.file = path.posix.basename(part.mesh);
        const local = avatar.get(part.mesh.replace(/^rbxasset:\/\/avatar\//i, ''));
        if (local) fs.writeFileSync(path.join(dir, part.file), local());
      } else if (part.meshType === 0 && avatar.has('heads/head.mesh')) {
        part.file = 'head.mesh';
        fs.writeFileSync(path.join(dir, 'head.mesh'), avatar.get('heads/head.mesh')());
      }
    }
  }
  await downloadAssets([...ids], dir);
  try {
    const textures = zipEntries(await download(PACKAGE_URL(version, 'content-textures2')));
    const face = textures.get('face.png') || textures.get('textures/face.png');
    if (face) fs.writeFileSync(path.join(dir, 'face.png'), face());
  } catch {}
  fs.writeFileSync(marker, JSON.stringify(rigs));
  return { dir, rigs };
}

async function ensureRig() {
  try {
    const { clientVersionUpload: version } = await (await fetch(VERSION_URL)).json();
    const { dir, rigs } = await build(version);
    Object.assign(state, { status: 'ready', version, dir, rigs });
    console.log(`R15 rig ready from Roblox Studio ${version}`);
  } catch (err) {
    let found = false;
    try {
      const saved = fs.readdirSync(DIR).filter(name => fs.existsSync(path.join(DIR, name, 'rig.json')));
      if (saved.length) {
        const version = saved.sort((a, b) => fs.statSync(path.join(DIR, b)).mtimeMs - fs.statSync(path.join(DIR, a)).mtimeMs)[0];
        const dir = path.join(DIR, version);
        Object.assign(state, { status: 'ready', version, dir, rigs: JSON.parse(fs.readFileSync(path.join(dir, 'rig.json'), 'utf8')) });
        found = true;
      }
    } catch {}
    if (!found) Object.assign(state, { status: 'failed', error: err.message });
    console.error(`Rig download failed: ${err.message}`);
  }
}

module.exports = { state, ensureRig };
