import { compact, el, icon, state, thumbnails } from './core.js';
import { drawDither } from './peak.js';

const NAV = [
  ['Home', 'house'],
  ['Charts', 'chart-three-vertical-bars'],
  ['Avatar', 'person-standing'],
  ['Marketplace', 'shopping-basket'],
  ['Chat', 'speech-bubble-round'],
  ['Friends', 'two-people'],
  ['Communities', 'three-people'],
];
const SEARCH_HINT = 'Search games, people and communities';
const GAME_COUNT = 9;
const FRIEND_COUNT = 3;

function previewGames() {
  const ids = [...new Set((state.home?.sorts || []).flatMap(sort => sort.ids))];
  return ids.filter(id => state.games[id] && (state.art[id] || state.icons[id])).slice(0, GAME_COUNT).map(id => state.games[id]);
}

function picture(src) {
  const node = el('img');
  node.alt = '';
  node.decoding = 'async';
  if (src) node.src = src;
  return node;
}

function art(game, square) {
  const frame = el('span', 'tp-art');
  if (!game) return frame;
  const id = game.universeId;
  const node = picture(square ? state.icons[id] || state.art[id] : state.art[id]);
  if (square) node.dataset.previewIcon = id;
  frame.append(node);
  return frame;
}

function tile(game, square, details = true) {
  const node = el('span', 'tp-card');
  node.append(art(game, square));
  if (details) {
    const stats = el('span', 'tp-stats');
    stats.append(icon('two-people', true), compact(game?.playerCount));
    node.append(el('span', 'tp-name', game?.name || ''), stats);
  }
  return node;
}

function tiles(games, square, count, details) {
  const row = el('span', 'tp-row');
  for (let i = 0; i < count; i++) row.append(tile(games.length ? games[i % games.length] : null, square, details));
  return row;
}

function section(title, content) {
  const node = el('span', 'tp-section');
  node.append(el('span', 'tp-title', title), content);
  return node;
}

function face(src) {
  const frame = el('span', 'tp-face');
  if (src) frame.append(picture(src));
  return frame;
}

const friendIds = () => {
  const ids = (state.friends || []).map(friend => friend.id).slice(0, FRIEND_COUNT);
  return ids.length ? ids : Array(FRIEND_COUNT).fill(null);
};

function friendRow(id) {
  const row = el('span', 'tp-friend');
  const text = el('span', 'tp-friend-text');
  text.append(el('span', 'tp-friend-name', state.names[id]?.displayName || 'Friend'), el('span', 'tp-friend-status', 'Online'));
  row.append(face(state.faces[id]), text);
  return row;
}

function friendTile(id) {
  const node = el('span', 'tp-person');
  node.append(face(state.faces[id]), el('span', 'tp-friend-name', state.names[id]?.displayName || 'Friend'));
  return node;
}

function search(text = SEARCH_HINT) {
  const node = el('span', 'tp-search');
  node.append(icon('magnifying-glass'), el('span', '', text));
  return node;
}

function me() {
  const node = el('span', 'tp-me');
  const robux = el('span', 'tp-robux');
  robux.append(icon('robux'), state.robux === undefined ? '' : compact(state.robux));
  node.append(robux, icon('bell'), face(state.me?.face));
  return node;
}

function bar(extra = []) {
  const node = el('span', 'tp-bar');
  node.append(el('span', 'tp-logo'), search(), ...extra, me());
  return node;
}

function nav(names = NAV, labels = true) {
  return names.map(([name, iconName], index) => {
    const item = el('span', `tp-nav${index === 0 ? ' on' : ''}`);
    item.append(icon(iconName));
    if (labels) item.append(el('span', '', name));
    return item;
  });
}

function standard(root, games) {
  const rail = el('span', 'tp-rail');
  rail.append(...nav());
  const main = el('span', 'tp-main');
  const first = tiles(games, false, 3);
  const play = el('span', 'tp-play');
  play.append(icon('play-large', true));
  first.firstElementChild?.append(play);
  main.append(section('Continue', first), section('Recommended For You', tiles(games.slice(3), false, 3)));
  const friends = el('span', 'tp-friends');
  friends.append(el('span', 'tp-title', 'Friends online'), ...friendIds().map(friendRow));
  root.append(bar(), rail, main, friends);
}

function truffled(root, games) {
  const dock = el('span', 'tp-rail');
  dock.append(...nav(NAV, false));
  const main = el('span', 'tp-main');
  const people = el('span', 'tp-people');
  people.append(...friendIds().map(friendTile));
  main.append(people, el('span', 'tp-welcome', 'Welcome to WebBlox'), section('Continue', tiles(games, true, 5)), section('Recommended For You', tiles(games.slice(4), true, 5)));
  root.append(bar(), dock, main);
}

function peak(root) {
  const rail = el('span', 'tp-rail');
  rail.append(...nav(NAV, false));
  const chrome = el('span', 'tp-chrome');
  const tab = el('span', 'tp-tab');
  tab.append(icon('house'), 'Home');
  chrome.append(tab);
  const address = el('span', 'tp-bar');
  address.append(el('span', 'tp-logo'), el('span', 'tp-address', 'webblox://home'), me());
  const hero = el('span', 'tp-hero');
  const canvas = el('canvas', 'tp-dither');
  const hello = el('span', 'tp-hello', state.me?.name ? `hello, ${state.me.name}` : 'hello there');
  const quick = el('span', 'tp-quick');
  quick.append(...NAV.slice(1).map(([, name]) => icon(name)));
  const go = el('span', 'tp-go');
  go.append(icon('arrow-large-up'));
  const find = search('Search');
  find.append(go);
  hero.append(canvas, el('span', 'tp-logo'), hello, find, quick);
  root.append(rail, chrome, address, hero);
  drawDither(canvas);
}

function gnBar() {
  const node = el('span', 'tp-bar');
  node.append(el('span', 'tp-logo', 'webblox'), search(), me());
  return node;
}

function gnMath(root, games) {
  const main = el('span', 'tp-main');
  const apps = el('span', 'tp-apps');
  apps.append(...nav().map(item => {
    const label = item.lastElementChild.textContent.toLowerCase();
    item.lastElementChild.remove();
    const app = el('span', 'tp-app');
    app.append(item, el('span', '', label));
    return app;
  }));
  const people = el('span', 'tp-people');
  people.append(...friendIds().map(friendTile));
  main.append(section('apps', apps), section('friends online', people), section('continue', tiles(games, true, 5)));
  root.append(gnBar(), main);
}

function gnMathTwo(root) {
  const hero = el('span', 'tp-hero');
  const go = el('span', 'tp-go');
  go.append(icon('arrow-large-up'));
  const find = search();
  find.append(go);
  const chips = el('span', 'tp-chips');
  chips.append(...NAV.slice(1, 6).map(([name, iconName]) => {
    const chip = el('span', 'tp-chip');
    chip.append(icon(iconName), name);
    return chip;
  }));
  hero.append(el('span', 'tp-wordmark', 'webblox'), find, chips);
  const dock = el('span', 'tp-rail');
  dock.append(el('span', 'tp-dock-logo', 'wb'), ...nav());
  root.append(gnBar(), hero, dock);
}

function xbox(root, games) {
  const tabs = el('span', 'tp-tabs');
  tabs.append(...NAV.map(([name], index) => el('span', index === 0 ? 'on' : '', name)));
  const side = el('span', 'tp-side');
  const avatar = el('span', 'tp-profile');
  if (state.me?.face) avatar.append(picture(state.me.face));
  side.append(el('span', 'tp-title', state.me?.name || 'Player'), avatar, el('span', 'tp-title', 'Friends online'), ...friendIds().slice(0, 2).map(friendRow));
  const blocks = el('span', 'tp-blocks');
  const block = section('Continue', tiles(games, true, 4, false));
  block.querySelector('.tp-card')?.classList.add('selected');
  blocks.append(block, section('Recommended For You', tiles(games.slice(4), true, 6, false)));
  root.append(bar(), tabs, side, blocks);
}

const LAYOUTS = { truffled, peak, 'gn-math': gnMath, 'gn-math-2': gnMathTwo, xbox };

export function previewKey() {
  const friends = friendIds();
  return JSON.stringify([
    previewGames().map(game => game.universeId),
    friends.map(id => [id, state.faces[id], state.names[id]?.displayName]),
    state.me?.name,
    state.me?.face,
    state.robux,
  ]);
}

export function themePreview(theme) {
  const box = el('span', 'theme-preview');
  box.dataset.theme = theme;
  box.setAttribute('aria-hidden', 'true');
  const root = el('span', 'tp');
  (LAYOUTS[theme] || standard)(root, previewGames());
  box.append(root);
  return box;
}

export async function loadPreviewIcons(group) {
  const nodes = [...group.querySelectorAll('img[data-preview-icon]')];
  const missing = [...new Set(nodes.map(node => node.dataset.previewIcon))].filter(id => !state.icons[id]);
  if (missing.length) {
    try {
      Object.assign(state.icons, await thumbnails(missing.map(id => ({ key: id, request: { targetId: Number(id), type: 'GameIcon', size: '512x512' } }))));
    } catch (err) {
      console.warn('[launcher] preview icons failed:', err.message);
    }
  }
  for (const node of nodes) {
    const src = state.icons[node.dataset.previewIcon];
    if (src && node.src !== src) node.src = src;
  }
}
