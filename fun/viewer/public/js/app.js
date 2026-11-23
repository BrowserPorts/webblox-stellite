import * as THREE from 'three';
import { Stage, applyTextures, buildRig, colorFrom, fileUrl, makeMaterial, makeSkeleton, sampleAnimation, textureUrl } from './stage.js';
import { loadMesh } from './mesh.js';
import { meshThumbnail } from './thumbs.js';

const CATEGORIES = [
  { id: 'mesh', label: 'Meshes', icon: 'Box' },
  { id: 'texture', label: 'Textures', icon: 'Image' },
  { id: 'sound', label: 'Sounds', icon: 'AudioLines' },
  { id: 'animation', label: 'Animations', icon: 'PersonStanding' },
  { id: 'model', label: 'Models', icon: 'Boxes' },
  { id: 'font', label: 'Fonts', icon: 'Type' },
  { id: 'video', label: 'Videos', icon: 'Film' },
  { id: 'data', label: 'Other data', icon: 'FileCode' },
];
const ROW_CATEGORIES = new Set(['sound', 'animation', 'font', 'data', 'video', 'model']);
const PAGE = 90;
const ROLE_LABELS = { color: 'Color', normal: 'Normal', surface: 'Metal and roughness' };

const $ = id => document.getElementById(id);
const state = { games: [], game: null, category: 'mesh', all: [], items: [], counts: {}, visible: [], shown: 0, selected: null, recorded: false, sort: 'newest', query: '', only: false };

function icon(name, attrs = {}) {
  const svg = window.lucide.createElement(window.lucide.icons[name]);
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  return svg;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function toolButton({ label, iconName, text, pressed, onclick, main }) {
  const button = el('button', { class: `tool${main ? ' main' : ''}`, type: 'button', 'aria-label': label, title: label, onclick });
  if (iconName) button.append(icon(iconName));
  if (text) button.append(text);
  if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
  return button;
}

function markElement(extra = '') {
  const holder = el('div', { class: `mark ${extra}`.trim() });
  holder.append($('mark-template').content.cloneNode(true));
  return holder;
}

const LAST_GAME_KEY = 'webblox.viewer.game';

function readLastGame() {
  try { return localStorage.getItem(LAST_GAME_KEY); } catch { return null; }
}

function writeLastGame(id) {
  try { localStorage.setItem(LAST_GAME_KEY, id); } catch {}
}

function showSplashArt(placeId) {
  if (!placeId) return;
  const image = $('splash-image');
  image.onload = () => $('splash-art').classList.add('ready');
  image.src = `/icon?place=${placeId}`;
}

function hideSplash() {
  const splash = $('splash');
  splash.classList.add('leaving');
  setTimeout(() => splash.remove(), 340);
}

const api = async path => {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `The viewer server answered ${res.status}.`);
  return data;
};

const size = bytes => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

const clock = seconds => {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

const titleOf = item => item.name || (item.id ? `Asset ${item.id}` : `Unnamed ${item.category}`);

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { game: params.get('game'), category: params.get('cat'), asset: params.get('asset') };
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.game) params.set('game', state.game);
  params.set('cat', state.category);
  if (state.selected) params.set('asset', state.selected);
  history.replaceState(null, '', `#${params}`);
}

async function loadGames() {
  const { games, folder } = await api('/api/games');
  state.games = games;
  const select = $('game-select');
  select.replaceChildren(...games.map(game => el('option', { value: game.id, text: game.name })));
  if (!games.length) {
    $('cats').replaceChildren();
    $('list').className = 'list';
    $('list').replaceChildren(el('div', { class: 'empty' },
      el('strong', { text: 'No saved games yet' }),
      'Start the game server with ', el('code', { text: 'SAVE_ASSETS=1 node server' }), ' and join a game. Its assets appear here, saved in ', el('code', { text: folder }), '.'));
    $('count').textContent = '';
    showEmptyInspector();
    return;
  }
  const wanted = readHash();
  const game = games.find(g => g.id === wanted.game) || games[0];
  select.value = game.id;
  await openGame(game.id, wanted.category, wanted.asset);
}

async function openGame(id, category, asset) {
  state.game = id;
  state.selected = null;
  writeLastGame(id);
  const gameIcon = $('game-icon');
  gameIcon.hidden = true;
  gameIcon.onload = () => { gameIcon.hidden = false; };
  gameIcon.onerror = () => { gameIcon.hidden = true; };
  gameIcon.src = `/icon?place=${id}`;
  const data = await api(`/api/assets?game=${id}`);
  state.all = data.items;
  state.recorded = data.recorded;
  refreshItems();
  const present = CATEGORIES.filter(c => state.counts[c.id]);
  state.category = category && state.counts[category] ? category : (present[0] || CATEGORIES[0]).id;
  renderSideNote();
  renderCategories();
  applyFilters();
  const target = asset && state.all.find(i => i.uid === asset && i.origin === 'game');
  if (target) {
    state.category = target.category;
    renderCategories();
    applyFilters();
    select(target.uid, { scroll: true });
  } else showEmptyInspector();
  writeHash();
}

function refreshItems() {
  state.items = state.all.filter(item => item.origin === 'game');
  state.counts = {};
  for (const item of state.items) state.counts[item.category] = (state.counts[item.category] || 0) + 1;
}

function renderSideNote() {
  const note = $('side-note');
  const bytes = state.items.reduce((sum, item) => sum + (item.bytes || 0), 0);
  const children = [el('span', { text: `${state.items.length.toLocaleString()} assets, ${size(bytes)}` })];
  note.replaceChildren(...children);
}

function renderCategories() {
  $('cats').replaceChildren(...CATEGORIES.filter(c => state.counts[c.id]).map(c => el('button', {
    class: 'cat', type: 'button', 'aria-current': String(c.id === state.category),
    onclick: () => {
      state.category = c.id;
      state.selected = null;
      state.only = false;
      $('only').checked = false;
      renderCategories();
      applyFilters();
      showEmptyInspector();
      writeHash();
    },
  }, icon(c.icon), c.label, el('small', { text: state.counts[c.id].toLocaleString() }))));
}

function onlyOption() {
  if (state.category === 'mesh') return 'Has textures';
  if (state.category === 'animation') return 'Linked to a model';
  return null;
}

function applyFilters() {
  const option = onlyOption();
  $('only-wrap').hidden = !option;
  $('only-label').textContent = option || '';
  const query = state.query.trim().toLowerCase();
  let items = state.items.filter(item => item.category === state.category);
  if (state.only && state.category === 'mesh') items = items.filter(i => i.textured);
  if (state.only && state.category === 'animation') items = items.filter(i => i.linked);
  if (query) items = items.filter(i => `${i.name || ''} ${i.id || ''} ${i.type || ''}`.toLowerCase().includes(query));
  const sorters = {
    newest: (a, b) => (b.firstSeen || 0) - (a.firstSeen || 0),
    largest: (a, b) => (b.bytes || 0) - (a.bytes || 0),
    name: (a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || titleOf(a).localeCompare(titleOf(b)),
  };
  items.sort(sorters[state.sort]);
  state.visible = items;
  state.shown = 0;
  const list = $('list');
  $('browse').scrollTop = 0;
  list.className = `list ${ROW_CATEGORIES.has(state.category) ? 'rows' : 'grid'}`;
  list.replaceChildren();
  const noun = CATEGORIES.find(c => c.id === state.category).label.toLowerCase();
  $('count').textContent = `${items.length.toLocaleString()} ${noun}`;
  if (!items.length) {
    list.append(el('div', { class: 'empty' }, el('strong', { text: `No ${noun} match` }), query ? 'Try a different name or asset ID.' : 'Turn off the filter to see the rest.'));
    return;
  }
  renderMore();
}

function renderMore() {
  const list = $('list');
  const next = state.visible.slice(state.shown, state.shown + PAGE);
  state.shown += next.length;
  const render = ROW_CATEGORIES.has(state.category) ? renderRow : renderTile;
  list.append(...next.map(render));
}

const observer = new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting) && state.shown < state.visible.length) renderMore();
}, { root: $('browse'), rootMargin: '700px' });
observer.observe($('sentinel'));

const thumbObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const box = entry.target;
    box.dataset.visible = entry.isIntersecting ? '1' : '';
    if (entry.isIntersecting && !box.dataset.loaded) {
      box.dataset.loaded = '1';
      loadMeshThumb(box);
    }
  }
}, { root: $('browse'), rootMargin: '200px' });

async function loadMeshThumb(box) {
  const item = state.items.find(i => i.uid === box.dataset.uid);
  if (!item) return;
  const key = `4:${item.rel}:${item.textured ? 'tex' : (item.color || []).join(',')}`;
  const blob = await meshThumbnail({
    key,
    rel: item.rel,
    color: item.color,
    detail: item.textured ? () => api(`/api/asset?game=${state.game}&uid=${encodeURIComponent(item.uid)}`).catch(() => null) : null,
    cancelled: () => !box.isConnected || box.dataset.visible !== '1',
  });
  if (!blob) {
    if (box.isConnected && box.dataset.visible !== '1') box.dataset.loaded = '';
    return;
  }
  const url = URL.createObjectURL(blob);
  const image = el('img', { src: url, alt: '' });
  image.onload = () => URL.revokeObjectURL(url);
  box.replaceChildren(image, ...box.querySelectorAll('.badge'));
}

function renderTile(item) {
  const box = el('span', { class: `thumb${item.category === 'mesh' || item.category === 'model' ? ' plain' : ''}` });
  if (item.category === 'texture') {
    box.append(el('img', { src: textureUrl(item.rel, 256), alt: '', loading: 'lazy' }));
    if (item.maps > 1 && item.type === 'TexturePack') box.append(el('span', { class: 'badge', text: `${item.maps} maps` }));
  } else if (item.category === 'mesh') {
    box.dataset.uid = item.uid;
    box.append(icon('Box'));
    thumbObserver.observe(box);
  } else box.append(icon('Boxes'));
  return el('button', {
    class: 'tile', type: 'button', 'data-uid': item.uid, 'aria-pressed': String(item.uid === state.selected),
    onclick: () => select(item.uid),
  }, box, el('span', { class: 'tile-text' },
    el('span', { class: 'tile-name', text: titleOf(item) }),
    el('span', { class: 'tile-meta', text: [item.name ? item.id : null, size(item.bytes)].filter(Boolean).join(', ') })));
}

const player = new Audio();
player.preload = 'metadata';
let playingUid = null;

function syncPlayIcons() {
  document.querySelectorAll('.row-icon.play').forEach(button => {
    const on = button.dataset.uid === playingUid && !player.paused;
    button.classList.toggle('playing', on);
    button.replaceChildren(icon(on ? 'Pause' : 'Play'));
    button.setAttribute('aria-label', on ? 'Pause' : 'Play');
  });
}

function playSound(item) {
  if (playingUid === item.uid && !player.paused) {
    player.pause();
    return;
  }
  if (playingUid !== item.uid) {
    playingUid = item.uid;
    player.src = fileUrl(item.rel);
  }
  player.play().catch(() => {});
}

for (const type of ['play', 'pause', 'ended']) player.addEventListener(type, syncPlayIcons);

function renderRow(item) {
  let lead;
  if (item.category === 'sound') {
    lead = el('span', { class: 'row-icon play', role: 'button', tabindex: 0, 'data-uid': item.uid, 'aria-label': 'Play',
      onclick: event => { event.stopPropagation(); select(item.uid, { keepPlaying: true }); playSound(item); },
      onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); playSound(item); } },
    }, icon('Play'));
  } else {
    const iconName = CATEGORIES.find(c => c.id === item.category).icon;
    lead = el('span', { class: 'row-icon' }, icon(iconName));
  }
  const meta = [];
  if (item.name && item.id) meta.push(item.id);
  if (item.category === 'animation') {
    meta.push(item.linked ? `Plays on ${item.linked}` : 'Plays on R15 rig');
    if (item.rig === 'custom' && !item.linked) meta[meta.length - 1] = 'Custom rig, no model found';
  } else if (item.type) meta.push(item.type);
  const end = item.category === 'animation' && item.duration ? `${item.duration.toFixed(1)} s` : size(item.bytes);
  return el('button', { class: 'row', type: 'button', 'data-uid': item.uid, 'aria-pressed': String(item.uid === state.selected), onclick: () => select(item.uid) },
    lead,
    el('span', { class: 'row-body' }, el('span', { class: 'row-name', text: titleOf(item) }), el('span', { class: 'row-meta', text: meta.join(', ') })),
    el('span', { class: 'row-end', text: end }));
}

let stage = null;
let teardown = null;
let selectToken = 0;

function getStage(host) {
  stage = stage || new Stage(document.createElement('div'));
  stage.clear();
  stage.home = null;
  host.append(stage.container);
  stage.container.style.cssText = 'position:absolute;inset:0';
  stage.resize();
  return stage;
}

function resetInspector() {
  if (teardown) {
    teardown();
    teardown = null;
  }
  if (stage) stage.clear();
  $('inspect').classList.remove('open');
}

function showEmptyInspector() {
  resetInspector();
  $('inspect').replaceChildren(el('div', { class: 'inspect-empty' }, markElement()));
}

function select(uid, { scroll, keepPlaying } = {}) {
  state.selected = uid;
  document.querySelectorAll('[aria-pressed][data-uid]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.uid === uid)));
  writeHash();
  if (!keepPlaying && playingUid && playingUid !== uid) player.pause();
  if (scroll) {
    const index = state.visible.findIndex(i => i.uid === uid);
    while (index >= state.shown && state.shown < state.visible.length) renderMore();
    document.querySelector(`[data-uid="${CSS.escape(uid)}"]`)?.scrollIntoView({ block: 'center' });
  }
  showInspector(uid);
}

async function showInspector(uid) {
  const token = ++selectToken;
  resetInspector();
  const inspect = $('inspect');
  inspect.classList.add('open');
  const item = state.items.find(i => i.uid === uid);
  const view = el('div', { class: 'view' });
  const info = el('div', { class: 'info' },
    el('button', { class: 'tool back', type: 'button', onclick: () => inspect.classList.remove('open') }, icon('ArrowLeft'), 'Back to list'),
    el('h2', { text: titleOf(item) }));
  inspect.replaceChildren(view, info);
  inspect.scrollTop = 0;
  let detail;
  try {
    detail = await api(`/api/asset?game=${state.game}&uid=${encodeURIComponent(uid)}`);
  } catch (err) {
    if (token === selectToken) info.append(el('p', { class: 'note error', text: err.message }));
    return;
  }
  if (token !== selectToken) return;
  const context = { token, view, info, detail, alive: () => token === selectToken };
  const renderers = { mesh: showMesh, texture: showTexture, sound: showSound, animation: showAnimation, model: showModel, font: showFont, video: showVideo, data: showData };
  try {
    await renderers[item.category](context);
  } catch (err) {
    if (context.alive()) info.append(el('p', { class: 'note error', text: err.message }));
  }
  if (context.alive()) window.lucide.createIcons({ root: inspect });
}

function facts(rows) {
  const list = el('dl', { class: 'facts' });
  for (const [label, value] of rows) {
    if (value == null || value === '') continue;
    list.append(el('div', {}, el('dt', { text: label }), el('dd', {}, value)));
  }
  return list;
}

function fileFacts(detail, extra = []) {
  const rows = [];
  if (detail.id) rows.push(['Asset ID', el('a', { href: `https://create.roblox.com/store/asset/${detail.id}`, target: '_blank', rel: 'noopener', text: detail.id })]);
  if (detail.type) rows.push(['Type', detail.type]);
  rows.push(...extra);
  rows.push(['Size', size(detail.bytes)]);
  rows.push(['File', el('a', { href: fileUrl(detail.rel), download: downloadName(detail), text: 'Download' })]);
  return facts(rows);
}

function downloadName(detail) {
  const file = detail.rel.split('/').pop();
  const extension = file.slice(file.lastIndexOf('.'));
  const name = (detail.name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (name && detail.id) return `${name} (${detail.id})${extension}`;
  return `${name || detail.id || file.slice(0, file.lastIndexOf('.'))}${extension}`;
}

function stageState(view, text, isError) {
  let node = view.querySelector('.view-state');
  if (!text) {
    if (node) node.remove();
    return;
  }
  if (!node) {
    node = el('div', { class: 'view-state' });
    view.append(node);
  }
  node.classList.toggle('error', Boolean(isError));
  node.replaceChildren(...(isError ? [] : [markElement('turning')]), el('span', { text }));
}

function stageTools(view, extras = []) {
  let wire = false;
  const wireButton = toolButton({ label: 'Wireframe', iconName: 'Grid3x3', pressed: false, onclick: () => {
    wire = !wire;
    wireButton.setAttribute('aria-pressed', String(wire));
    stage.setWireframe(wire);
  } });
  view.append(el('div', { class: 'view-tools' }, ...extras, wireButton,
    toolButton({ label: 'Reset view', iconName: 'RotateCcw', onclick: () => stage.resetView() })));
}

async function showMesh({ view, info, detail, alive }) {
  getStage(view);
  stageState(view, 'Loading mesh');
  const meshInfo = await loadMesh(fileUrl(detail.rel));
  if (!alive()) return;
  stageState(view);
  const material = makeMaterial();
  if (detail.color) material.color.copy(colorFrom(detail.color));
  const baseColor = material.color.clone();
  const skinned = meshInfo.bones.length > 0;
  const mesh = skinned ? new THREE.SkinnedMesh(meshInfo.geometry, material) : new THREE.Mesh(meshInfo.geometry, material);
  stage.add(mesh);
  if (skinned) makeSkeleton(meshInfo, mesh);
  stage.frameContent();
  const dims = meshInfo.geometry.boundingBox.getSize(new THREE.Vector3());
  const options = detail.textureOptions || [];
  let current = options[0] || null;
  let textured = true;
  const apply = async () => {
    const set = textured && current ? current.textures : {};
    material.color.copy(textured && current && current.color ? colorFrom(current.color) : baseColor);
    await applyTextures(material, set);
    stage.invalidate();
  };
  if (current) await apply();
  if (!alive()) return;
  let texButton = null;
  if (options.length) {
    texButton = toolButton({ label: 'Show textures', iconName: 'Paintbrush', pressed: true, onclick: () => {
      textured = !textured;
      texButton.setAttribute('aria-pressed', String(textured));
      apply();
    } });
  }
  stageTools(view, texButton ? [texButton] : []);
  info.append(fileFacts(detail, [
    ['Triangles', meshInfo.faces.toLocaleString()],
    ['Vertices', meshInfo.vertices.toLocaleString()],
    ['Dimensions', `${dims.x.toFixed(2)} x ${dims.y.toFixed(2)} x ${dims.z.toFixed(2)}`],
    ['Format', `Version ${meshInfo.version}${meshInfo.lods > 1 ? `, ${meshInfo.lods} detail levels` : ''}`],
    ['Bones', meshInfo.bones.length ? meshInfo.bones.length.toLocaleString() : null],
  ]));
  const choices = el('div', { class: 'choice-list' });
  const setChoice = async (option, button) => {
    current = option;
    textured = true;
    if (texButton) texButton.setAttribute('aria-pressed', 'true');
    choices.querySelectorAll('.choice').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
    await apply();
  };
  const addChoice = (option, label) => {
    const button = el('button', { class: 'choice', type: 'button', 'aria-pressed': String(option === current), onclick: () => setChoice(option, button) },
      el('img', { src: textureUrl(option.textures.map || option.textures.normal || option.textures.surface, 64), alt: '', loading: 'lazy' }),
      el('span', { text: label }));
    choices.append(button);
  };
  options.forEach((option, i) => addChoice(option, option.name || `Texture set ${i + 1}`));
  const group = el('div', { class: 'group' });
  if (options.length) group.append(el('h3', { text: options.length > 1 ? 'Textures' : 'Texture' }), choices);
  const pick = el('button', { class: 'link-button', type: 'button', text: 'Try another texture', onclick: () => {
    pick.remove();
    const textures = state.items.filter(i => i.category === 'texture' && !i.thumbnail).slice(0, 400);
    const list = el('div', { class: 'choice-list' });
    for (const item of textures) {
      const option = { textures: { map: item.rel }, color: null };
      const button = el('button', { class: 'choice', type: 'button', 'aria-pressed': 'false', onclick: () => {
        list.querySelectorAll('.choice').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
        current = option;
        textured = true;
        apply();
      } }, el('img', { src: textureUrl(item.rel, 64), alt: '', loading: 'lazy' }), el('span', { text: titleOf(item) }));
      list.append(button);
    }
    group.append(list);
  } });
  group.append(pick);
  info.append(group);
}

function showTexture({ view, info, detail, alive }) {
  view.className = 'view image';
  const image = el('img', { alt: `Texture ${detail.id || ''}`, src: textureUrl(detail.rel) });
  view.append(image);
  const dims = el('span', { text: '' });
  image.onload = () => { dims.textContent = `${image.naturalWidth} x ${image.naturalHeight}`; };
  image.onerror = () => { if (alive()) stageState(view, 'This image could not be decoded.', true); };
  if (detail.files.length > 1) {
    const roles = detail.files.map(file => file.role);
    const distinct = new Set(roles).size === roles.length;
    const buttons = detail.files.map(file => {
      const label = distinct ? ROLE_LABELS[file.role] || 'Map' : `${file.ext.toUpperCase()} ${size(file.bytes)}`;
      const button = toolButton({ label, text: label, pressed: file.rel === detail.rel, onclick: () => {
        image.src = textureUrl(file.rel);
        buttons.forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      } });
      return button;
    });
    info.append(el('div', { class: 'segment' }, ...buttons));
  }
  info.append(fileFacts(detail, [['Dimensions', dims], ['Format', detail.ext.toUpperCase()]]));
  if (detail.usedBy && detail.usedBy.length) {
    const group = el('div', { class: 'group' }, el('h3', { text: 'Used on these meshes' }));
    for (const mesh of detail.usedBy) {
      group.append(el('button', { class: 'link-button', type: 'button', text: mesh.name || `Asset ${mesh.id}`, onclick: () => {
        state.category = 'mesh';
        renderCategories();
        applyFilters();
        select(mesh.uid, { scroll: true });
      } }));
    }
    info.append(group);
  }
}

async function drawWave(canvas, rel, alive) {
  const context = new AudioContext();
  try {
    const buffer = await (await fetch(fileUrl(rel))).arrayBuffer();
    const audio = await context.decodeAudioData(buffer);
    if (!alive()) return null;
    const samples = audio.getChannelData(0);
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth * ratio;
    const height = canvas.clientHeight * ratio;
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const paint = progress => {
      g.clearRect(0, 0, width, height);
      const step = Math.max(1, Math.floor(samples.length / width * 2));
      for (let x = 0; x < width; x += 2) {
        let peak = 0;
        const start = Math.floor(x / width * samples.length);
        for (let i = start; i < start + step && i < samples.length; i += 8) peak = Math.max(peak, Math.abs(samples[i]));
        const h = Math.max(2 * ratio, peak * height * 0.86);
        g.fillStyle = x / width <= progress ? '#f7f7f8' : '#6a6d74';
        g.fillRect(x, (height - h) / 2, 1.2 * ratio, h);
      }
    };
    paint(0);
    return { paint, channels: audio.numberOfChannels, rate: audio.sampleRate };
  } finally {
    context.close();
  }
}

async function showSound({ view, info, detail, alive }) {
  view.className = 'view flat';
  const canvas = el('canvas', { class: 'wave' });
  view.append(canvas);
  const item = state.items.find(i => i.uid === detail.uid);
  if (playingUid !== item.uid) {
    playingUid = item.uid;
    player.src = fileUrl(item.rel);
  }
  const range = el('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Playback position' });
  const time = el('output', { text: '0:00 / 0:00' });
  const playButton = toolButton({ label: 'Play', iconName: 'Play', main: true, onclick: () => playSound(item) });
  let wave = null;
  const update = () => {
    const duration = player.duration || 0;
    const fraction = duration ? player.currentTime / duration : 0;
    if (document.activeElement !== range) range.value = fraction * 1000;
    time.textContent = `${clock(player.currentTime)} / ${clock(duration)}`;
    if (wave) wave.paint(fraction);
  };
  const syncButton = () => {
    playButton.replaceChildren(icon(player.paused ? 'Play' : 'Pause'));
    playButton.setAttribute('aria-label', player.paused ? 'Play' : 'Pause');
    playButton.title = player.paused ? 'Play' : 'Pause';
  };
  range.addEventListener('input', () => { if (player.duration) player.currentTime = range.value / 1000 * player.duration; });
  const problem = el('p', { class: 'note error', text: 'This sound could not be played.', hidden: true });
  const showProblem = () => { problem.hidden = false; };
  for (const type of ['timeupdate', 'loadedmetadata', 'seeked']) player.addEventListener(type, update);
  for (const type of ['play', 'pause', 'ended']) player.addEventListener(type, syncButton);
  player.addEventListener('error', showProblem);
  teardown = () => {
    for (const type of ['timeupdate', 'loadedmetadata', 'seeked']) player.removeEventListener(type, update);
    for (const type of ['play', 'pause', 'ended']) player.removeEventListener(type, syncButton);
    player.removeEventListener('error', showProblem);
  };
  syncButton();
  info.append(el('div', { class: 'transport' }, playButton, range, time), problem);
  const channels = el('span');
  info.append(fileFacts(detail, [['Format', detail.ext.toUpperCase()], ['Audio', channels]]));
  update();
  try {
    wave = await drawWave(canvas, item.rel, alive);
    if (wave && alive()) {
      channels.textContent = `${wave.channels === 1 ? 'Mono' : 'Stereo'}, ${(wave.rate / 1000).toFixed(1)} kHz`;
      update();
    }
  } catch {
    if (alive()) canvas.remove();
  }
}

function buildSkinnedTarget(meshInfo, material) {
  const mesh = new THREE.SkinnedMesh(meshInfo.geometry, material);
  const holder = new THREE.Group();
  holder.add(mesh);
  const bones = makeSkeleton(meshInfo, mesh);
  const byName = new Map(bones.map(bone => [bone.name, bone]));
  return {
    root: holder,
    targets: new Set(byName.keys()),
    setTransforms(values) {
      for (const [name, value] of values) {
        const bone = byName.get(name);
        if (!bone) continue;
        const rest = bone.userData.rest;
        bone.position.copy(value.position).applyQuaternion(rest.quaternion).add(rest.position);
        bone.quaternion.copy(rest.quaternion).multiply(value.quaternion);
      }
    },
    reset() {
      for (const bone of bones) {
        bone.position.copy(bone.userData.rest.position);
        bone.quaternion.copy(bone.userData.rest.quaternion);
      }
    },
    dispose() {},
  };
}

let rigRequest = null;
async function fetchStudioRigs() {
  rigRequest = rigRequest || api('/api/rig').then(data => {
    if (data.status !== 'ready') rigRequest = null;
    return data;
  });
  return rigRequest;
}

function addFace(rig, def) {
  const headIndex = def.parts.findIndex(part => part.name === 'Head' && part.face);
  if (headIndex < 0) return;
  const group = rig.root.children[headIndex];
  const head = group && group.children[0] && group.children[0].children[0];
  if (!head || !head.geometry) return;
  const geometry = head.geometry.clone();
  const box = geometry.boundingBox;
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const uv = new Float32Array(position.count * 2);
  const width = box.max.x - box.min.x || 1;
  const height = box.max.y - box.min.y || 1;
  for (let i = 0; i < position.count; i++) {
    uv[i * 2] = 1 - (position.getX(i) - box.min.x) / width;
    uv[i * 2 + 1] = (position.getY(i) - box.min.y) / height;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const source = geometry.index ? geometry.index.array : Array.from({ length: position.count }, (_, i) => i);
  const start = geometry.drawRange.start;
  const end = Math.min(source.length, start + geometry.drawRange.count);
  const front = [];
  for (let i = start; i + 2 < end; i += 3) {
    const a = source[i];
    const b = source[i + 1];
    const c = source[i + 2];
    if (normal.getZ(a) + normal.getZ(b) + normal.getZ(c) < 0) front.push(a, b, c);
  }
  geometry.setIndex(front);
  geometry.setDrawRange(0, Infinity);
  const texture = new THREE.TextureLoader().load('/rig-file?name=face.png', () => stage && stage.invalidate());
  texture.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide, roughness: 0.8 }));
  face.renderOrder = 2;
  head.parent.add(face);
}

async function makeAnimationTarget(target, animation) {
  if (target.kind === 'studio') {
    const data = await fetchStudioRigs();
    if (data.status !== 'ready') throw new Error(data.status === 'failed' ? `The R15 rig could not be downloaded: ${data.error}` : 'The R15 rig is still downloading from Roblox. Select this animation again in a moment.');
    const def = data.rigs[target.rigType] || data.rigs.R15;
    const rig = await buildRig(def, part => (part.file ? `/rig-file?name=${encodeURIComponent(part.file)}` : null));
    addFace(rig, def);
    return { rig };
  }
  if (target.kind === 'rig') {
    const def = await api(`/api/rig-scene?game=${state.game}&key=${encodeURIComponent(target.key)}`);
    const rig = await buildRig(def, part => (part.meshRel ? fileUrl(part.meshRel) : null));
    return { rig };
  }
  const meshInfo = await loadMesh(fileUrl(target.rel));
  const detail = await api(`/api/asset?game=${state.game}&uid=${encodeURIComponent(target.uid)}`);
  const material = makeMaterial();
  const option = detail.textureOptions && detail.textureOptions[0];
  if (option) await applyTextures(material, option.textures);
  return { rig: buildSkinnedTarget(meshInfo, material) };
}

async function showAnimation({ view, info, detail, alive }) {
  getStage(view);
  stageState(view, 'Loading animation');
  const animation = await api(`/api/animation?rel=${encodeURIComponent(detail.rel)}`);
  if (!alive()) return;
  const nameCounts = new Map();
  for (const t of detail.targets) nameCounts.set(t.name, (nameCounts.get(t.name) || 0) + 1);
  const targets = detail.targets.map(t => ({ ...t, label: nameCounts.get(t.name) > 1 && t.partCount ? `${t.name}, ${t.partCount} parts` : t.name }));
  if (detail.rig !== 'custom' || !targets.length) targets.push({ kind: 'studio', rigType: detail.rig === 'R6' ? 'R6' : 'R15', label: detail.rig === 'R6' ? 'R6 rig' : 'R15 rig' });
  let time = 0;
  let playing = animation.duration > 0;
  let speed = 1;
  let last = performance.now();
  let current = null;
  const range = el('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Animation position' });
  const clockOut = el('output', { text: '' });
  const playButton = toolButton({ label: 'Pause', iconName: 'Pause', main: true, onclick: () => {
    playing = !playing;
    last = performance.now();
    syncPlay();
  } });
  const syncPlay = () => {
    playButton.replaceChildren(icon(playing ? 'Pause' : 'Play'));
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playButton.title = playing ? 'Pause' : 'Play';
  };
  syncPlay();
  const showTime = () => {
    clockOut.textContent = `${time.toFixed(2)} / ${animation.duration.toFixed(2)} s`;
    if (document.activeElement !== range) range.value = animation.duration ? time / animation.duration * 1000 : 0;
  };
  range.addEventListener('input', () => {
    playing = false;
    syncPlay();
    time = range.value / 1000 * animation.duration;
  });
  const ticker = () => {
    if (!current) return;
    const now = performance.now();
    if (playing && animation.duration > 0) {
      time += (now - last) / 1000 * speed;
      if (time > animation.duration) time %= animation.duration;
    }
    last = now;
    current.rig.setTransforms(sampleAnimation(animation, time));
    showTime();
  };
  const load = async target => {
    stage.setTicker(null);
    stage.clear();
    if (current) current.rig.dispose();
    current = null;
    stageState(view, 'Loading model');
    const built = await makeAnimationTarget(target, animation);
    if (!alive()) return;
    stageState(view);
    current = built;
    stage.add(built.rig.root);
    built.rig.reset();
    const box = stage.measure();
    for (let i = 1; i <= 6 && animation.duration > 0; i++) {
      built.rig.setTransforms(sampleAnimation(animation, animation.duration * i / 6));
      stage.measure(box);
    }
    built.rig.reset();
    stage.frameContent(undefined, box);
    last = performance.now();
    stage.setTicker(ticker);
  };
  teardown = () => {
    stage.setTicker(null);
    if (current) current.rig.dispose();
    current = null;
  };
  const speeds = [0.25, 0.5, 1];
  const speedButtons = speeds.map(value => {
    const button = toolButton({ label: `Play at ${value} times speed`, text: `${value}x`, pressed: value === 1, onclick: () => {
      speed = value;
      speedButtons.forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    } });
    return button;
  });
  stageTools(view);
  const controls = [el('div', { class: 'transport' }, playButton, range, clockOut), el('div', { class: 'segment' }, ...speedButtons)];
  if (targets.length > 1) {
    const select = el('select', { class: 'game-select', 'aria-label': 'Model to play on', onchange: () => load(targets[Number(select.value)]).catch(err => stageState(view, err.message, true)) },
      ...targets.map((target, i) => el('option', { value: i, text: target.label })));
    controls.push(el('div', { class: 'group' }, el('h3', { text: 'Play on' }), select));
  }
  info.append(...controls);
  const flags = [animation.loop ? 'Loops' : 'Plays once', animation.format === 'CurveAnimation' ? 'Curve animation' : 'Keyframes'];
  info.append(fileFacts(detail, [
    ['Length', `${animation.duration.toFixed(2)} s`],
    ['Keys', animation.keyframes.toLocaleString()],
    ['Parts', animation.parts.length.toLocaleString()],
    ['Style', flags.join(', ')],
  ]));
  if (detail.rig === 'custom' && !detail.targets.length) {
    info.append(el('div', { class: 'group' },
      el('h3', { text: 'Parts this animation moves' }),
      el('p', { class: 'note', text: animation.parts.join(', ') || 'None' })));
  }
  await load(targets[0]);
}

async function showModel({ view, info, detail, alive }) {
  getStage(view);
  stageState(view, 'Loading model');
  const scene = await api(`/api/model?game=${state.game}&rel=${encodeURIComponent(detail.rel)}`);
  if (!alive()) return;
  const parts = scene.parts;
  if (parts.length) {
    const rig = await buildRig({ parts, joints: [] }, part => (part.meshRel ? fileUrl(part.meshRel) : null));
    if (!alive()) return;
    stage.add(rig.root);
    rig.reset();
    stage.frameContent();
    stageTools(view);
  } else if (scene.templates.some(t => t.rel)) {
    stage.container.remove();
    view.className = 'view image';
    view.append(el('img', { src: textureUrl(scene.templates.find(t => t.rel).rel), alt: 'Clothing template' }));
  } else {
    stage.container.remove();
    view.className = 'view flat';
    view.append(el('div', { class: 'placeholder' }, icon('Boxes')));
  }
  stageState(view);
  const missing = parts.filter(part => part.missingMesh).length;
  info.append(fileFacts(detail, [['Parts', parts.length || null], ['Missing meshes', missing || null]]));
  const describe = node => el('li', {}, node.name || node.className, ' ', el('small', { text: node.className }),
    node.children.length ? el('ul', {}, ...node.children.map(describe)) : null);
  info.append(el('div', { class: 'group' }, el('h3', { text: 'Contents' }), el('ul', { class: 'tree' }, ...scene.tree.map(describe))));
}

async function showFont({ view, info, detail, alive }) {
  view.className = 'view flat';
  const family = `asset-${detail.uid.replace(/\W/g, '')}`;
  const sample = el('div', { class: 'font-sample' }, el('p', { text: detail.name || 'The quick brown fox' }), el('p', { text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789' }));
  view.append(sample);
  const face = new FontFace(family, `url("${fileUrl(detail.rel)}")`);
  try {
    await face.load();
    if (!alive()) return;
    document.fonts.add(face);
    sample.style.fontFamily = `'${family}'`;
  } catch {
    if (alive()) info.append(el('p', { class: 'note error', text: 'This font file could not be loaded.' }));
  }
  info.append(fileFacts(detail, [['Format', detail.ext.toUpperCase()]]));
}

function showVideo({ view, info, detail }) {
  view.className = 'view flat';
  view.style.padding = '0';
  view.append(el('video', { src: fileUrl(detail.rel), controls: true, style: 'width:100%;height:100%' }));
  info.append(fileFacts(detail, [['Format', detail.ext.toUpperCase()]]));
}

async function showData({ view, info, detail, alive }) {
  view.className = 'view flat';
  view.style.height = 'auto';
  view.style.maxHeight = '52dvh';
  view.style.minHeight = '120px';
  if (detail.ext === 'json') {
    const text = await (await fetch(fileUrl(detail.rel))).text();
    if (!alive()) return;
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    view.append(el('pre', { class: 'text-sample', text: pretty.slice(0, 20000) }));
  } else {
    view.append(el('div', { class: 'placeholder' }, icon('FileCode')));
  }
  info.append(fileFacts(detail, [['Format', detail.ext.toUpperCase()], ['Contains', (detail.classes || []).join(', ') || null]]));
}

document.querySelector('[data-icon="Search"]').append(icon('Search'));

$('game-select').addEventListener('change', event => openGame(event.target.value));
$('search').addEventListener('input', event => {
  state.query = event.target.value;
  applyFilters();
});
$('sort').addEventListener('change', event => {
  state.sort = event.target.value;
  applyFilters();
});
$('only').addEventListener('change', event => {
  state.only = event.target.checked;
  applyFilters();
});

document.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  if (event.target.matches('input, select, textarea, canvas')) return;
  if (!state.selected) return;
  const index = state.visible.findIndex(i => i.uid === state.selected);
  if (index < 0) return;
  const list = $('list');
  let columns = 1;
  if (list.classList.contains('grid')) columns = getComputedStyle(list).gridTemplateColumns.split(' ').length;
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
  const next = state.visible[index + delta];
  if (!next) return;
  event.preventDefault();
  select(next.uid, { scroll: true });
  document.querySelector(`[data-uid="${CSS.escape(next.uid)}"]`)?.focus({ preventScroll: true });
});

showSplashArt(readLastGame());
const splashStarted = performance.now();

loadGames().then(async () => {
  const wait = 450 - (performance.now() - splashStarted);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  hideSplash();
}).catch(err => {
  const status = $('splash-status');
  status.textContent = `The asset list could not be loaded: ${err.message}`;
  status.classList.add('error');
  document.querySelector('.splash .progress').remove();
});
