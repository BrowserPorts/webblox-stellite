import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/OrbitControls.js';
import { RoomEnvironment } from '/vendor/three/RoomEnvironment.js';
import { loadMesh } from './mesh.js';

export const fileUrl = rel => `/file?rel=${encodeURIComponent(rel)}`;
export const textureUrl = (rel, size = 0) => `/tex?rel=${encodeURIComponent(rel)}${size ? `&size=${size}` : ''}`;

const CLAY = 0xb9c0cc;
const HEAD_MESH_TYPE = 0;
const HEAD_MESH_BASE_SCALE = 1.25;
const textureLoader = new THREE.TextureLoader();

export function loadTexture(rel, { srgb = false, size = 0 } = {}) {
  return new Promise((resolve, reject) => {
    textureLoader.load(textureUrl(rel, size), texture => {
      texture.flipY = false;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 8;
      if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
      resolve(texture);
    }, undefined, () => reject(new Error('The texture could not be read.')));
  });
}

export function makeMaterial() {
  const material = new THREE.MeshStandardMaterial({ color: CLAY, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D(map, vMapUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, sampledDiffuseColor.rgb, sampledDiffuseColor.a);
      #endif
    `);
  };
  return material;
}

export async function applyTextures(material, set = {}, { size = 0 } = {}) {
  const jobs = [
    ['map', set.map, true],
    ['normalMap', set.normal, false],
    ['roughnessMap', set.surface || set.roughness, false],
    ['metalnessMap', set.surface || set.metalness, false],
  ];
  await Promise.all(jobs.map(async ([slot, rel, srgb]) => {
    if (material[slot]) material[slot].dispose();
    material[slot] = null;
    if (!rel) return;
    try { material[slot] = await loadTexture(rel, { srgb, size }); } catch {}
  }));
  material.roughness = material.roughnessMap ? 1 : 0.7;
  material.metalness = material.metalnessMap ? 1 : 0;
  material.needsUpdate = true;
}

export function colorFrom(values) {
  if (!values) return new THREE.Color(CLAY);
  return new THREE.Color().setRGB(values[0], values[1], values[2], THREE.SRGBColorSpace);
}

const cfToMatrix = cf => new THREE.Matrix4().set(cf[3], cf[4], cf[5], cf[0], cf[6], cf[7], cf[8], cf[1], cf[9], cf[10], cf[11], cf[2], 0, 0, 0, 1);

export function makeSkeleton(info, mesh) {
  const bones = info.bones.map(data => {
    const bone = new THREE.Bone();
    bone.name = data.name;
    return bone;
  });
  const worlds = info.bones.map(data => {
    const r = data.rotation;
    return new THREE.Matrix4().set(r[0], r[1], r[2], data.position[0], r[3], r[4], r[5], data.position[1], r[6], r[7], r[8], data.position[2], 0, 0, 0, 1);
  });
  const roots = [];
  info.bones.forEach((data, i) => {
    const local = data.parent >= 0 ? worlds[data.parent].clone().invert().multiply(worlds[i]) : worlds[i].clone();
    local.decompose(bones[i].position, bones[i].quaternion, bones[i].scale);
    bones[i].userData.rest = { position: bones[i].position.clone(), quaternion: bones[i].quaternion.clone() };
    if (data.parent >= 0) bones[data.parent].add(bones[i]);
    else roots.push(bones[i]);
  });
  for (const root of roots) mesh.add(root);
  mesh.updateWorldMatrix(true, true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  return bones;
}

async function buildPart(part, meshUrl) {
  const group = new THREE.Group();
  group.name = part.name;
  const color = colorFrom(part.color);
  const opacity = 1 - (part.transparency || 0);
  if (opacity <= 0.01) return { group, bones: [], meshes: [] };
  const material = makeMaterial();
  material.color.copy(color);
  material.userData.color = color.clone();
  if (opacity < 1) {
    material.transparent = true;
    material.opacity = opacity;
  }
  if (part.textures) await applyTextures(material, part.textures);
  const size = new THREE.Vector3(...(part.size || [1, 1, 1]));
  let bones = [];
  let mesh;
  if (meshUrl) {
    try {
      const info = await loadMesh(meshUrl);
      const box = info.geometry.boundingBox;
      const dims = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const skinned = info.bones.length > 0;
      mesh = skinned ? new THREE.SkinnedMesh(info.geometry, material) : new THREE.Mesh(info.geometry, material);
      const holder = new THREE.Group();
      if (part.scale) {
        holder.scale.set(...part.scale);
        if (part.meshType === HEAD_MESH_TYPE) holder.scale.divideScalar(HEAD_MESH_BASE_SCALE);
      } else {
        holder.scale.set(size.x / (dims.x || 1), size.y / (dims.y || 1), size.z / (dims.z || 1));
        holder.position.copy(center).multiply(holder.scale).negate();
      }
      holder.add(mesh);
      group.add(holder);
      if (skinned) bones = makeSkeleton(info, mesh);
    } catch {
      mesh = null;
    }
  }
  if (!mesh) {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
    group.add(mesh);
  }
  return { group, bones, meshes: [mesh] };
}

const R6_JOINTS = [
  { part0: 'HumanoidRootPart', part1: 'Torso', c0: [0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 1, 0], c1: [0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 1, 0] },
  { part0: 'Torso', part1: 'Head', c0: [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 1, 0], c1: [0, -0.5, 0, -1, 0, 0, 0, 0, 1, 0, 1, 0] },
  { part0: 'Torso', part1: 'Right Arm', c0: [1, 0.5, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0], c1: [-0.5, 0.5, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0] },
  { part0: 'Torso', part1: 'Left Arm', c0: [-1, 0.5, 0, 0, 0, -1, 0, 1, 0, 1, 0, 0], c1: [0.5, 0.5, 0, 0, 0, -1, 0, 1, 0, 1, 0, 0] },
  { part0: 'Torso', part1: 'Right Leg', c0: [1, -1, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0], c1: [0.5, 1, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0] },
  { part0: 'Torso', part1: 'Left Leg', c0: [-1, -1, 0, 0, 0, -1, 0, 1, 0, 1, 0, 0], c1: [-0.5, 1, 0, 0, 0, -1, 0, 1, 0, 1, 0, 0] },
];

export async function buildRig(def, resolveMesh) {
  const built = await Promise.all(def.parts.map(part => buildPart(part, resolveMesh(part))));
  const root = new THREE.Group();
  const nodes = def.parts.map((part, i) => ({
    part,
    group: built[i].group,
    world: cfToMatrix(part.cframe),
    joints: [],
    bones: built[i].bones,
  }));
  const byName = new Map();
  nodes.forEach(node => { if (!byName.has(node.part.name)) byName.set(node.part.name, node); });
  let joints = (def.joints || []).map(joint => ({
    a: joint.a != null ? nodes[joint.a] : byName.get(joint.part0),
    b: joint.b != null ? nodes[joint.b] : byName.get(joint.part1),
    c0: joint.c0,
    c1: joint.c1,
    motor: joint.motor !== false,
  })).filter(joint => joint.a && joint.b);
  if (!joints.length && byName.has('Torso')) {
    joints = R6_JOINTS.map(joint => ({ a: byName.get(joint.part0), b: byName.get(joint.part1), c0: joint.c0, c1: joint.c1, motor: true })).filter(joint => joint.a && joint.b);
  }
  for (const joint of joints) {
    joint.c0m = joint.c0 ? cfToMatrix(joint.c0) : joint.a.world.clone().invert().multiply(joint.b.world);
    joint.c1m = joint.c1 ? cfToMatrix(joint.c1) : new THREE.Matrix4();
    joint.c1i = joint.c1m.clone().invert();
    joint.c0i = joint.c0m.clone().invert();
    joint.a.joints.push({ joint, child: joint.b, forward: true });
    joint.b.joints.push({ joint, child: joint.a, forward: false });
  }
  const rootNode = (def.root != null && nodes[def.root]) || byName.get('HumanoidRootPart') ||
    nodes.reduce((best, node) => (node.joints.length > best.joints.length ? node : best), nodes[0]);
  for (const node of nodes) {
    node.group.matrixAutoUpdate = false;
    node.group.matrix.copy(node.world);
    root.add(node.group);
  }
  const allBones = new Map();
  for (const node of nodes) for (const bone of node.bones) if (!allBones.has(bone.name)) allBones.set(bone.name, []), allBones.get(bone.name).push(bone); else allBones.get(bone.name).push(bone);
  const scratch = new THREE.Matrix4();
  const transforms = new Map();
  const pose = () => {
    const visited = new Set([rootNode]);
    const walk = node => {
      node.group.matrix.copy(node.world);
      for (const link of node.joints) {
        if (visited.has(link.child)) continue;
        visited.add(link.child);
        const matrix = node.world.clone();
        if (link.forward) {
          matrix.multiply(link.joint.c0m);
          const transform = link.joint.motor && transforms.get(link.child.part.name);
          if (transform) matrix.multiply(transform);
          matrix.multiply(link.joint.c1i);
        } else {
          matrix.multiply(link.joint.c1m);
          const transform = link.joint.motor && transforms.get(node.part.name);
          if (transform) matrix.multiply(scratch.copy(transform).invert());
          matrix.multiply(link.joint.c0i);
        }
        link.child.world = matrix;
        walk(link.child);
      }
    };
    walk(rootNode);
    for (const node of nodes) {
      node.group.matrix.copy(node.world);
      node.group.matrixWorldNeedsUpdate = true;
    }
    root.updateMatrixWorld(true);
  };
  const motorNames = new Set(joints.filter(j => j.motor).map(j => j.b.part.name));
  const targets = new Set([...motorNames, ...allBones.keys()]);
  return {
    root,
    targets,
    setTransforms(values) {
      transforms.clear();
      for (const [name, value] of values) {
        transforms.set(name, value.matrix);
        for (const bone of allBones.get(name) || []) {
          const rest = bone.userData.rest;
          bone.position.copy(value.position).applyQuaternion(rest.quaternion).add(rest.position);
          bone.quaternion.copy(rest.quaternion).multiply(value.quaternion);
        }
      }
      pose();
    },
    reset() {
      transforms.clear();
      for (const list of allBones.values()) {
        for (const bone of list) {
          bone.position.copy(bone.userData.rest.position);
          bone.quaternion.copy(bone.userData.rest.quaternion);
        }
      }
      pose();
    },
    dispose() {
      for (const node of nodes) {
        node.group.traverse(child => {
          if (child.material) child.material.dispose();
          if (child.skeleton) child.skeleton.dispose();
        });
      }
    },
  };
}

function ease(style, direction, t) {
  if (style === 'constant') return 0;
  if (style === 'linear') return t;
  const curve = x => {
    if (style === 'cubic') return x * x * x;
    if (style === 'elastic') return x === 0 || x === 1 ? x : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * (2 * Math.PI) / 3);
    if (style === 'bounce') {
      const u = 1 - x;
      const n = 7.5625;
      const d = 2.75;
      let v;
      if (u < 1 / d) v = n * u * u;
      else if (u < 2 / d) { const w = u - 1.5 / d; v = n * w * w + 0.75; }
      else if (u < 2.5 / d) { const w = u - 2.25 / d; v = n * w * w + 0.9375; }
      else { const w = u - 2.625 / d; v = n * w * w + 0.984375; }
      return 1 - v;
    }
    return x;
  };
  if (direction === 'in') return curve(t);
  if (direction === 'out') return 1 - curve(1 - t);
  return t < 0.5 ? curve(t * 2) / 2 : 1 - curve((1 - t) * 2) / 2;
}

export function sampleAnimation(animation, time) {
  const out = new Map();
  for (const [name, keys] of Object.entries(animation.tracks)) {
    if (!keys.length) continue;
    let hi = keys.findIndex(key => key.t > time);
    let a;
    let b;
    let alpha = 0;
    if (hi === 0) {
      a = b = keys[0];
    } else if (hi < 0) {
      a = b = keys[keys.length - 1];
    } else {
      a = keys[hi - 1];
      b = keys[hi];
      alpha = ease(a.e, a.d, (time - a.t) / ((b.t - a.t) || 1));
    }
    const position = new THREE.Vector3(...a.p).lerp(new THREE.Vector3(...b.p), alpha);
    const quaternion = new THREE.Quaternion(...a.q).slerp(new THREE.Quaternion(...b.q), alpha);
    out.set(name, { position, quaternion, matrix: new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1)) });
  }
  return out;
}

export class Stage {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 1;
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 4, -3);
    this.scene.add(key);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());
    this.content = new THREE.Group();
    this.scene.add(this.content);
    this.frame = null;
    this.ticker = null;
    this.home = null;
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(container);
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const moving = this.controls.update();
      if (this.ticker) this.ticker();
      this.renderer.render(this.scene, this.camera);
      if (moving || this.ticker) this.invalidate();
    });
  }

  clear() {
    this.ticker = null;
    while (this.content.children.length) {
      const child = this.content.children.pop();
      child.traverse(node => {
        if (node.material) {
          for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) if (node.material[slot]) node.material[slot].dispose();
          node.material.dispose();
        }
      });
    }
    this.invalidate();
  }

  add(object) {
    this.content.add(object);
    this.invalidate();
  }

  measure(box = new THREE.Box3()) {
    this.content.updateMatrixWorld(true);
    this.content.traverse(node => {
      if (!node.isMesh) return;
      if (node.isSkinnedMesh) {
        node.computeBoundingBox();
        box.union(node.boundingBox.clone().applyMatrix4(node.matrixWorld));
      } else {
        if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
        box.expandByObject(node);
      }
    });
    return box;
  }

  frameContent(direction = new THREE.Vector3(0.62, 0.42, -1), box = this.measure()) {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = sphere.radius || 1;
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.08;
    this.camera.near = Math.max(radius / 200, 0.001);
    this.camera.far = radius * 60 + 10;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(direction.clone().normalize(), distance);
    this.controls.minDistance = radius * 0.1;
    this.controls.maxDistance = radius * 12;
    this.home = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    this.controls.update();
    this.invalidate();
  }

  resetView() {
    if (!this.home) return;
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.controls.update();
    this.invalidate();
  }

  setWireframe(on) {
    this.content.traverse(node => {
      if (node.material) node.material.wireframe = on;
    });
    this.invalidate();
  }

  setTicker(fn) {
    this.ticker = fn;
    this.invalidate();
  }

  dispose() {
    this.resizer.disconnect();
    this.renderer.dispose();
  }
}
