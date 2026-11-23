import * as THREE from 'three';
import { RoomEnvironment } from '/vendor/three/RoomEnvironment.js';
import { loadMesh } from './mesh.js';
import { applyTextures, colorFrom, fileUrl, makeMaterial } from './stage.js';

const SIZE = 240;
const DB_NAME = 'asset-viewer-thumbs';
const STORE = 'thumbs';

let renderer = null;
let scene = null;
let camera = null;
let dbPromise = null;
const waiting = [];
let running = false;

function setup() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 1;
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 4, -3);
  scene.add(key);
  camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10000);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function readThumb(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise(resolve => {
    const get = db.transaction(STORE).objectStore(STORE).get(key);
    get.onsuccess = () => resolve(get.result || null);
    get.onerror = () => resolve(null);
  });
}

async function writeThumb(key, blob) {
  const db = await openDb();
  if (!db) return;
  try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, key); } catch {}
}

async function render(job) {
  setup();
  const info = await loadMesh(fileUrl(job.rel));
  const geometry = info.geometry.clone();
  geometry.deleteAttribute('skinIndex');
  geometry.deleteAttribute('skinWeight');
  const material = makeMaterial();
  if (job.color) material.color.copy(colorFrom(job.color));
  let textures = null;
  if (job.detail) {
    const detail = await job.detail();
    const option = detail && detail.textureOptions && detail.textureOptions[0];
    if (detail && detail.color) material.color.copy(colorFrom(detail.color));
    if (option) {
      textures = option.textures;
      if (option.color) material.color.copy(colorFrom(option.color));
    }
  }
  if (textures) await applyTextures(material, textures, { size: 256 });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  geometry.computeBoundingSphere();
  const box = geometry.boundingBox || (geometry.computeBoundingBox(), geometry.boundingBox);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = sphere.radius || 1;
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.04;
  camera.near = radius / 100;
  camera.far = radius * 50;
  camera.position.copy(sphere.center).addScaledVector(new THREE.Vector3(0.62, 0.42, -1).normalize(), distance);
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const blob = await new Promise(resolve => renderer.domElement.toBlob(resolve, 'image/webp', 0.85));
  scene.remove(mesh);
  for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) if (material[slot]) material[slot].dispose();
  material.dispose();
  geometry.dispose();
  return blob;
}

async function pump() {
  if (running) return;
  running = true;
  while (waiting.length) {
    const job = waiting.pop();
    if (job.cancelled()) {
      job.resolve(null);
      continue;
    }
    try {
      const blob = await render(job);
      if (blob) writeThumb(job.key, blob);
      job.resolve(blob);
    } catch {
      job.resolve(null);
    }
  }
  running = false;
}

export async function meshThumbnail({ key, rel, color, detail, cancelled }) {
  const stored = await readThumb(key);
  if (stored) return stored;
  if (cancelled()) return null;
  return new Promise(resolve => {
    waiting.push({ key, rel, color, detail, cancelled, resolve });
    pump();
  });
}
