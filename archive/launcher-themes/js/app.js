import { ROBLOX_LAUNCHER, api, refreshArt, button, card, clearJoin, compact, el, faces, gameArt, icon, image, link, loadFailure, personTile, rememberGame, rowSection, section, sessionId, skeleton, state, thumbnails, userNames } from './core.js';
import { showGame } from './game.js';
import { showFriends, showGroup, showCommunities, showUser } from './people.js';
import { showAvatar } from './avatar.js';
import { showItem, showMarket } from './market.js';
import { showChat, showNotifications } from './social.js';
import { showAccount, showRobux, showSettings, showWeb, signOut } from './account.js';
import { refreshThemePreviews, watchTheme } from './themes.js';
import { peakHero } from './peak.js';
import { dockTime, gnHome, mountGnMath } from './gnmath.js';
import { mountXbox, renderXboxProfile } from './xbox.js';

const ENGINE_FILES = '/038e4bd621bee962e64ed84fac16608407267adc/assets/webclient/';
const HOME_KEY = 'webblox.launcher.home.v4';
const CHARTS_KEY = 'webblox.launcher.charts.v2';
const HIDDEN_KEY = 'webblox.launcher.hidden';
const TREATMENTS = ['Carousel', 'SortlessGrid', 'FriendCarousel', 'SearchGameGrid'];
const PAGE_SIZE = 30;
const ROW_SIZE = 24;
const IN_GAME = 2;
const PRESENCE_MS = 30000;
const COUNTS_MS = 60000;
const NAV = [
  ['home', 'Home', 'house', '#/'],
  ['charts', 'Charts', 'chart-three-vertical-bars', '#/charts'],
  ['avatar', 'Avatar', 'person-standing', '#/avatar'],
  ['market', 'Marketplace', 'shopping-basket', '#/marketplace'],
  ['chat', 'Chat', 'speech-bubble-round', '#/chat'],
  ['friends', 'Friends', 'two-people', '#/friends'],
  ['communities', 'Communities', 'three-people', '#/communities'],
];

const SEARCH_HINT = 'Search games, people and communities';
const PAGE_TITLES = { home: 'Home', charts: 'Charts', chart: 'Charts', search: 'Search', game: 'Game', avatar: 'Avatar', market: 'Marketplace', item: 'Item', chat: 'Chat', friends: 'Friends', user: 'Profile', communities: 'Communities', group: 'Community', notifications: 'Notifications', settings: 'Settings', robux: 'Robux', account: 'Account', web: 'Roblox' };
const PAGE_ICONS = { home: 'house', charts: 'chart-three-vertical-bars', chart: 'chart-three-vertical-bars', search: 'magnifying-glass', game: 'play-large', avatar: 'person-standing', market: 'shopping-basket', item: 'shopping-basket', chat: 'speech-bubble-round', friends: 'two-people', user: 'person', communities: 'three-people', group: 'three-people', notifications: 'bell', settings: 'gear', robux: 'robux', account: 'person', web: 'chain-link' };
const content = document.getElementById('content');
const layout = document.getElementById('layout');
const input = document.getElementById('query');
const suggestions = document.getElementById('suggestions');
let routeToken = 0;
let suggestTimer = null;
let suggestToken = 0;
let suggestIndex = -1;
let shown = PAGE_SIZE;
const scrollByRoute = {};
let lastRoute = location.hash;

const hiddenGames = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY)) || []);
  } catch {
    return new Set();
  }
};

async function loadFriends() {
  const { data } = await api(`https://friends.roblox.com/v1/users/${state.me.id}/friends/online`);
  const friends = (data || []).map(row => ({
    id: row.id,
    presence: row.userPresence?.UserPresenceType,
    game: row.userPresence?.lastLocation,
    universeId: row.userPresence?.universeId,
    rootPlaceId: row.userPresence?.rootPlaceId,
    placeId: row.userPresence?.placeId,
    serverId: row.userPresence?.gameInstanceId,
    sortScore: row.sortScore || 0,
  })).sort((a, b) => (b.presence === IN_GAME) - (a.presence === IN_GAME) || b.sortScore - a.sortScore).slice(0, 40);
  const ids = friends.map(f => f.id);
  await Promise.all([faces(ids), userNames(ids)]);
  state.friends = friends;
  renderFriends();
}

function renderPeakFriends(root = document.querySelector('.peak-friends')) {
  if (!root) return;
  root.replaceChildren(...(state.friends.length ? [rowSection('Friends online', '', state.friends.map(friend => personTile(friend.id)), null, 'row people-row')] : []));
}

function renderFriends() {
  renderPeakFriends();
  const online = document.getElementById('shell-online');
  online.hidden = !state.friends.length;
  online.textContent = state.friends.length ? `${state.friends.length} online` : '';
  const column = document.getElementById('friends');
  const visible = currentRoute().page === 'home' && state.friends.length > 0;
  column.hidden = !visible;
  layout.classList.toggle('no-friends', !visible);
  if (!state.friends.length) {
    column.replaceChildren();
    return;
  }
  const list = el('div', 'friend-list');
  for (const friend of state.friends) {
    const inGame = friend.presence === IN_GAME && friend.universeId;
    const row = link('friend', inGame ? `#/game/${friend.universeId}/friend/${friend.id}` : `#/user/${friend.id}`);
    const face = el('span', 'friend-face');
    face.append(image(state.faces[friend.id]), el('span', `friend-dot ${inGame ? 'playing' : 'online'}`));
    const text = el('span', 'friend-text');
    text.append(el('span', 'friend-name', state.names[friend.id]?.displayName || 'Friend'), el('span', `friend-game${inGame ? ' playing' : ''}`, inGame ? friend.game || 'Playing' : 'Online'));
    row.append(face, text);
    list.append(row);
  }
  const heading = el('h2', '', 'Friends online');
  heading.append(el('small', '', String(state.friends.length)));
  column.replaceChildren(heading, list);
  refreshThemePreviews();
}

function renderShell(current) {
  const peak = document.documentElement.dataset.theme === 'peak';
  document.getElementById('shell-title').textContent = PAGE_TITLES[current.page] || 'Home';
  document.getElementById('shell-icon').replaceChildren(icon(PAGE_ICONS[current.page] || 'house'));
  const path = location.hash.replace(/^#\/?/, '') || 'home';
  input.placeholder = peak ? `webblox://${path}` : SEARCH_HINT;
}

function renderRail() {
  const rail = document.getElementById('rail');
  const current = currentRoute().nav;
  rail.replaceChildren(...NAV.map(([id, label, name, href]) => {
    const item = link('rail-item', href);
    item.dataset.nav = id;
    item.title = label;
    if (id === current) item.setAttribute('aria-current', 'page');
    const glyph = el('span', 'rail-icon');
    glyph.append(icon(name, id === current));
    const count = state.counts[id];
    if (count) glyph.append(el('span', 'badge', count > 99 ? '99+' : String(count)));
    item.append(glyph, el('span', 'rail-label', label));
    return item;
  }));
  const extra = [['robux', 'Robux', 'robux', '#/robux', 'rail-extra-gn'], ['settings', 'Settings', 'gear', '#/settings', 'rail-extra'], ['account', 'Account', 'person', '#/account', 'rail-extra']].map(([id, label, name, href, kind]) => {
    const item = link(`rail-item ${kind}`, href);
    item.title = label;
    if (id === current) item.setAttribute('aria-current', 'page');
    const glyph = el('span', 'rail-icon');
    glyph.append(icon(name));
    item.append(glyph, el('span', 'rail-label', label));
    return item;
  });
  const dockLogo = link('rail-dock-logo', '#/');
  dockLogo.setAttribute('aria-label', 'Home');
  rail.prepend(dockLogo, el('span', 'rail-dock-sep'));
  rail.append(el('span', 'rail-spacer'), el('span', 'rail-sep'), ...extra, el('time', 'rail-time', dockTime()));
}

function renderMe() {
  const area = document.getElementById('me');
  if (!state.me) return;
  renderXboxProfile();
  refreshThemePreviews();
  const robux = link('robux', '#/robux');
  robux.setAttribute('aria-label', state.robux === undefined ? 'Robux' : `${compact(state.robux)} Robux`);
  robux.append(icon('robux'));
  if (state.robux !== undefined) robux.append(compact(state.robux));
  const bell = link('icon-button', '#/notifications');
  bell.setAttribute('aria-label', state.counts.notifications ? `Notifications, ${state.counts.notifications} unread` : 'Notifications');
  bell.append(icon('bell'));
  if (state.counts.notifications) bell.append(el('span', 'badge', state.counts.notifications > 99 ? '99+' : String(state.counts.notifications)));
  const menu = el('details', 'profile-menu');
  const summary = el('summary');
  summary.setAttribute('aria-label', 'Account menu');
  const face = image(state.me.face);
  face.className = 'face';
  summary.append(face);
  const panel = el('div', 'menu-panel');
  const heading = link('menu-head', `#/user/${state.me.id}`);
  const headingText = el('span', 'menu-head-text');
  headingText.append(el('strong', '', state.me.name), el('span', '', 'View profile'));
  heading.append(image(state.me.face), headingText);
  panel.append(heading);
  for (const [label, name, href, phoneOnly] of [
    ['Messages', 'envelope', '#/notifications/messages'],
    ['Marketplace', 'shopping-basket', '#/marketplace', true],
    ['Communities', 'three-people', '#/communities', true],
    ['Robux', 'robux', '#/robux'],
    ['Settings', 'gear', '#/settings'],
    ['Account', 'person', '#/account'],
  ]) {
    const item = link(`menu-item${phoneOnly ? ' phone-only' : ''}`, href);
    item.append(icon(name), label);
    panel.append(item);
  }
  const classic = link('menu-item', ROBLOX_LAUNCHER);
  classic.append(icon('tilt', true), 'Roblox launcher');
  panel.append(classic);
  const out = button('menu-item menu-sign-out', '');
  out.append(icon('door-open-arrow-to-bottom-right'), 'Sign out');
  out.addEventListener('click', signOut);
  panel.append(out);
  panel.addEventListener('click', () => {
    menu.open = false;
  });
  menu.append(summary, panel);
  area.replaceChildren(robux, bell, menu);
}

async function refreshCounts() {
  if (!state.me || document.visibilityState === 'hidden') return;
  const [notifications, requests, chat, messages] = await Promise.all([
    api('https://notifications.roblox.com/v2/stream-notifications/unread-count').catch(() => ({})),
    api('https://friends.roblox.com/v1/user/friend-requests/count').catch(() => ({})),
    api('https://apis.roblox.com/platform-chat-api/v1/get-conversation-metadata').catch(() => ({})),
    api('https://privatemessages.roblox.com/v1/messages/unread/count').catch(() => ({})),
  ]);
  state.counts = { notifications: (notifications.unreadNotifications || 0) + (messages.count || 0), friends: requests.count || 0, chat: chat.global_unread_message_count || 0 };
  renderRail();
  renderMe();
}

async function loadHome() {
  const me = await api('https://users.roblox.com/v1/users/authenticated');
  const previousFace = state.me?.face || null;
  state.me = { id: me.id, name: me.displayName || me.name, face: previousFace };
  const [feed, robux, own] = await Promise.all([
    api('https://apis.roblox.com/discovery-api/omni-recommendation', { pageType: 'Home', sessionId, supportedTreatmentTypes: TREATMENTS, requestIntent: 'logIn' }),
    api(`https://economy.roblox.com/v1/users/${me.id}/currency`).catch(() => ({})),
    thumbnails([{ key: 'me', request: { targetId: me.id, type: 'AvatarHeadShot', size: '150x150' } }]).catch(() => ({})),
  ]);
  state.me.face = own.me || previousFace;
  state.robux = robux.robux;
  const metadata = feed.contentMetadata?.Game || {};
  const sorts = [];
  const seen = new Set();
  for (const sort of feed.sorts || []) {
    const items = (sort.recommendationList || []).filter(r => r.contentType === 'Game' && metadata[r.contentId]);
    if (!items.length || seen.has(sort.topicId)) continue;
    seen.add(sort.topicId);
    const grid = sort.treatmentType === 'SortlessGrid';
    const ids = items.map(r => r.contentId);
    for (const id of ids) {
      const game = metadata[id];
      rememberGame({ universeId: game.universeId, rootPlaceId: game.rootPlaceId, name: game.name, playerCount: game.playerCount, totalUpVotes: game.totalUpVotes, totalDownVotes: game.totalDownVotes, layoutDataBySort: game.layoutDataBySort, primaryMediaAsset: game.primaryMediaAsset });
    }
    sorts.push({ id: sort.topicId, title: sort.topic, subtitle: sort.subtitle || '', grid, ids });
  }
  sorts.sort((a, b) => /continue/i.test(b.title) - /continue/i.test(a.title));
  await gameArt(sorts.flatMap(s => s.ids.slice(0, s.grid ? PAGE_SIZE : ROW_SIZE)).map(id => state.games[id]));
  const recs = await api(`https://friends.roblox.com/v1/users/${me.id}/friends/recommendations`).catch(() => ({}));
  const suggested = (recs.data || []).map(r => r.id).filter(Boolean).slice(0, 20);
  await Promise.all([faces(suggested), userNames(suggested)]);
  return { sorts, suggested };
}

function renderHome() {
  const home = state.home;
  if (!home) return;
  const hidden = hiddenGames();
  const parts = [];
  for (const sort of home.sorts) {
    const games = sort.ids.map(id => state.games[id]).filter(g => g && !hidden.has(String(g.universeId)));
    if (!sort.grid) {
      parts.push(rowSection(sort.title, sort.subtitle, games.slice(0, ROW_SIZE).map(card)));
      continue;
    }
    const grid = el('div', 'grid');
    grid.append(...games.slice(0, shown).map(card));
    const sentinel = el('div', 'sentinel');
    parts.push(section(sort.title, sort.subtitle, grid), sentinel);
    if (games.length > shown) {
      const token = routeToken;
      const watcher = new IntersectionObserver(async ([entry]) => {
        if (!entry.isIntersecting || token !== routeToken) return;
        watcher.disconnect();
        const next = games.slice(shown, shown + PAGE_SIZE);
        shown += PAGE_SIZE;
        await gameArt(next);
        if (token !== routeToken) return;
        grid.append(...next.map(card));
        if (games.length > shown) watcher.observe(sentinel);
      }, { rootMargin: '600px' });
      watcher.observe(sentinel);
    }
  }
  if (home.suggested?.length) parts.splice(1, 0, rowSection('People you may know', '', home.suggested.map(id => personTile(id)), null, 'row people-row'));
  parts.unshift(el('h1', 'home-welcome', 'Welcome to WebBlox'));
  const nearby = el('div', 'peak-friends');
  parts.splice(1, 0, nearby);
  parts.unshift(peakHero(runSearch));
  parts.unshift(gnHome(runSearch));
  renderPeakFriends(nearby);
  content.replaceChildren(...parts);
}

async function refreshHome() {
  try {
    const home = await loadHome();
    state.home = home;
    renderMe();
    renderRail();
    loadFriends().catch(() => {});
    refreshCounts();
    try {
      const games = {};
      for (const sort of home.sorts) for (const id of sort.ids) games[id] = state.games[id];
      localStorage.setItem(HOME_KEY, JSON.stringify({ home, games, art: state.art, icons: state.icons, me: state.me, robux: state.robux, faces: state.faces, names: state.names }));
    } catch {}
    if (currentRoute().page === 'home') renderHome();
  } catch (err) {
    if (currentRoute().page === 'home' && !state.home) loadFailure(content, err, refreshHome);
    else console.warn('[launcher] refresh failed:', err.message);
  }
}

function chartsFrom(response) {
  const sorts = [];
  let filters = null;
  for (const sort of response.sorts || []) {
    if (sort.filters) filters = sort.filters;
    if (sort.games?.length) sorts.push({ id: sort.sortId, title: sort.sortDisplayName, games: sort.games });
  }
  return { sorts, filters, next: response.nextSortsPageToken || null };
}

const chartQuery = () => {
  const query = state.chartFilters || {};
  return Object.entries(query).filter(([, v]) => v && v !== 'all').map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
};

function chartFilters(filters, alive) {
  const bar = el('div', 'filters');
  for (const filter of filters || []) {
    const label = el('label', 'filter');
    label.append(el('span', '', filter.filterDisplayName));
    const select = el('select');
    for (const option of filter.filterOptions || []) {
      const item = el('option', '', option.optionDisplayName);
      item.value = option.optionId;
      select.append(item);
    }
    select.value = state.chartFilters?.[filter.filterType] || filter.selectedOptionId || filter.defaultOptionId || 'all';
    select.addEventListener('change', () => {
      state.chartFilters = { ...state.chartFilters, [filter.filterType]: select.value };
      state.charts = null;
      showCharts(content, {}, alive);
    });
    label.append(select);
    bar.append(label);
  }
  return bar;
}

function renderCharts(alive) {
  const charts = state.charts;
  const parts = [chartFilters(charts.filters, alive)];
  for (const sort of charts.sorts) parts.push(rowSection(sort.title, '', sort.games.slice(0, ROW_SIZE).map(card), `#/charts/${sort.id}`));
  if (charts.next) {
    const row = el('div', 'center');
    const more = button('more', 'Show more charts');
    more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = 'Loading…';
      try {
        const page = chartsFrom(await api(`https://apis.roblox.com/charts-api/v1/get-sorts?sessionId=${sessionId}${chartQuery()}&sortsPageToken=${encodeURIComponent(charts.next)}`));
        await gameArt(page.sorts.flatMap(s => s.games.slice(0, ROW_SIZE)));
        charts.sorts.push(...page.sorts);
        charts.next = page.next;
        const scroll = window.scrollY;
        if (alive()) renderCharts(alive);
        window.scrollTo(0, scroll);
      } catch (err) {
        more.disabled = false;
        more.textContent = 'Show more charts';
        console.warn('[launcher] charts failed:', err.message);
      }
    });
    row.append(more);
    parts.push(row);
  }
  content.replaceChildren(...parts);
}

async function showCharts(root, params, alive) {
  if (state.charts) renderCharts(alive);
  else skeleton(root);
  try {
    const charts = chartsFrom(await api(`https://apis.roblox.com/charts-api/v1/get-sorts?sessionId=${sessionId}${chartQuery()}`));
    await gameArt(charts.sorts.flatMap(s => s.games.slice(0, ROW_SIZE)));
    if (!alive()) return;
    if (!state.charts || state.charts.sorts.length <= charts.sorts.length) {
      state.charts = charts;
      renderCharts(alive);
    }
    try {
      if (!chartQuery()) localStorage.setItem(CHARTS_KEY, JSON.stringify({ ...charts, filters: charts.filters }));
    } catch {}
  } catch (err) {
    if (alive() && !state.charts) loadFailure(root, err, () => showCharts(root, params, alive));
  }
}

async function showChart(root, { sortId }, alive) {
  skeleton(root);
  try {
    const sort = await api(`https://apis.roblox.com/charts-api/v1/get-sort-content?sessionId=${sessionId}&sortId=${encodeURIComponent(sortId)}&pageSize=100${chartQuery()}`);
    const games = sort.games || [];
    await gameArt(games);
    if (!alive()) return;
    const grid = el('div', 'grid');
    grid.append(...games.map(card));
    root.replaceChildren(section(sort.sortDisplayName || 'Chart', sort.topicLayoutData?.infoText || '', grid));
  } catch (err) {
    if (alive()) loadFailure(root, err, () => showChart(root, { sortId }, alive));
  }
}

function searchTabs(kind, query) {
  const nav = el('div', 'tab-bar search-kinds');
  for (const [id, label] of [['games', 'Games'], ['people', 'People'], ['communities', 'Communities']]) {
    const tab = link('tab', `#/search/${id}/${encodeURIComponent(query)}`, label);
    if (id === kind) tab.setAttribute('aria-current', 'page');
    nav.append(tab);
  }
  return nav;
}

async function showSearch(root, { kind, query }, alive) {
  input.value = query;
  const head = () => [el('h1', 'search-title', `Results for "${query}"`), searchTabs(kind, query)];
  root.replaceChildren(...head());
  try {
    let body;
    if (kind === 'people') {
      const result = await api(`https://apis.roblox.com/search-api/omni-search?verticalType=user&searchQuery=${encodeURIComponent(query)}&sessionId=${sessionId}&pageType=all`);
      const people = (result.searchResults || []).flatMap(g => g.contents || []);
      for (const p of people) state.names[p.contentId] = { displayName: p.displayName, name: p.username, verified: p.hasVerifiedBadge };
      await faces(people.map(p => p.contentId));
      body = el('div', 'people-grid');
      body.append(...people.map(p => personTile(p.contentId, `@${p.username}`)));
      if (!people.length) body = el('p', 'section-note', 'No people match that search.');
    } else if (kind === 'communities') {
      const { data = [] } = await api(`https://groups.roblox.com/v1/groups/search?keyword=${encodeURIComponent(query)}&limit=25&prioritizeExactMatch=true`);
      const icons = await thumbnails(data.map(g => ({ key: String(g.id), request: { targetId: g.id, type: 'GroupIcon', size: '150x150' } }))).catch(() => ({}));
      body = el('div', 'list-rows');
      for (const group of data) {
        const row = link('list-row', `#/group/${group.id}`);
        const text = el('span', 'list-text');
        text.append(el('strong', '', group.name), el('span', '', `${compact(group.memberCount)} members`));
        row.append(image(icons[group.id], '', true), text);
        body.append(row);
      }
      if (!data.length) body = el('p', 'section-note', 'No communities match that search.');
    } else {
      const result = await api(`https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${sessionId}&pageType=all`);
      const games = (result.searchResults || []).filter(g => g.contentGroupType === 'Game').flatMap(g => g.contents || []).filter(g => g.universeId && g.rootPlaceId).slice(0, 60);
      await gameArt(games);
      body = el('div', 'grid');
      body.append(...games.map(card));
      if (!games.length) body = el('p', 'section-note', 'No games match that search. Try a different name.');
    }
    if (alive()) root.replaceChildren(...head(), body);
  } catch (err) {
    if (alive()) root.replaceChildren(...head(), el('p', 'section-note', "Search didn't load. Try again in a moment."));
    console.warn('[launcher] search failed:', err.message);
  }
}

function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const [first, second, third, fourth] = parts;
  switch (first) {
    case 'charts': return second ? { page: 'chart', nav: 'charts', run: showChart, params: { sortId: second } } : { page: 'charts', nav: 'charts', run: showCharts, params: {} };
    case 'search': return third ? { page: 'search', run: showSearch, params: { kind: second, query: parts.slice(2).join('/') } } : { page: 'search', run: showSearch, params: { kind: 'games', query: second || '' } };
    case 'game': return { page: 'game', run: showGame, params: { id: second, friend: third === 'friend' ? fourth : null } };
    case 'avatar': return { page: 'avatar', nav: 'avatar', run: showAvatar, params: {} };
    case 'marketplace': return { page: 'market', nav: 'market', run: showMarket, params: {} };
    case 'item': return { page: 'item', nav: 'market', run: showItem, params: { type: second, id: third } };
    case 'chat': return { page: 'chat', nav: 'chat', run: showChat, params: { id: second } };
    case 'friends': return { page: 'friends', nav: 'friends', run: showFriends, params: { tab: second } };
    case 'user': return { page: 'user', run: showUser, params: { id: second } };
    case 'communities': return { page: 'communities', nav: 'communities', run: showCommunities, params: {} };
    case 'group': return { page: 'group', nav: 'communities', run: showGroup, params: { id: second } };
    case 'notifications': return { page: 'notifications', run: showNotifications, params: { tab: second } };
    case 'settings': return { page: 'settings', nav: 'settings', run: showSettings, params: {} };
    case 'robux': return { page: 'robux', nav: 'robux', run: showRobux, params: {} };
    case 'account': return { page: 'account', nav: 'account', run: showAccount, params: {} };
    case 'web': return { page: 'web', run: showWeb, params: { key: second } };
    default: return { page: 'home', nav: 'home' };
  }
}

function route() {
  scrollByRoute[lastRoute] = window.scrollY;
  lastRoute = location.hash;
  const token = ++routeToken;
  const alive = () => token === routeToken;
  const current = currentRoute();
  closeSuggestions();
  if (current.page !== 'search') input.value = '';
  renderFriends();
  document.body.dataset.page = current.page;
  renderRail();
  renderShell(current);
  if (current.page === 'home') {
    if (state.home) renderHome();
    else skeleton(content);
  } else {
    current.run(content, current.params, alive);
  }
  const saved = current.page === 'game' ? 0 : scrollByRoute[location.hash] || 0;
  requestAnimationFrame(() => window.scrollTo(0, saved));
}

function closeSuggestions() {
  suggestToken++;
  suggestIndex = -1;
  suggestions.hidden = true;
  suggestions.replaceChildren();
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function runSearch(query) {
  closeSuggestions();
  if (!query) return;
  const target = `#/search/games/${encodeURIComponent(query)}`;
  if (location.hash === target) route();
  else location.hash = target;
}

function highlight(index) {
  const items = [...suggestions.children];
  suggestIndex = index;
  items.forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
  if (items[index]) input.setAttribute('aria-activedescendant', items[index].id);
  else input.removeAttribute('aria-activedescendant');
}

async function loadSuggestions(prefix) {
  const token = ++suggestToken;
  try {
    const { entries = [] } = await api(`https://apis.rbxcdn.com/games-autocomplete/v1/get-suggestion/${encodeURIComponent(prefix)}`);
    if (token !== suggestToken || input.value.trim() !== prefix) return;
    const unique = [...new Set(entries.map(e => e.searchQuery).filter(Boolean))].slice(0, 8);
    suggestions.replaceChildren(...unique.map((query, index) => {
      const item = el('li', 'suggestion');
      item.id = `suggestion-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.append(icon('magnifying-glass'), query);
      item.addEventListener('mousedown', event => {
        event.preventDefault();
        runSearch(query);
      });
      return item;
    }));
    suggestIndex = -1;
    suggestions.hidden = !unique.length;
    input.setAttribute('aria-expanded', String(Boolean(unique.length)));
  } catch (err) {
    console.warn('[launcher] suggestions failed:', err.message);
  }
}

input.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const prefix = input.value.trim();
  if (!prefix) return closeSuggestions();
  suggestTimer = setTimeout(() => loadSuggestions(prefix), 110);
});
input.addEventListener('keydown', event => {
  if (suggestions.hidden) return;
  const count = suggestions.children.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    highlight(suggestIndex === -1 && step === -1 ? count - 1 : (suggestIndex + step + count) % count);
  } else if (event.key === 'Escape') {
    closeSuggestions();
  }
});
input.addEventListener('blur', () => setTimeout(closeSuggestions, 120));
document.getElementById('find').addEventListener('submit', event => {
  event.preventDefault();
  clearTimeout(suggestTimer);
  const picked = suggestions.children[suggestIndex];
  runSearch(picked ? picked.textContent : input.value.trim());
});
document.addEventListener('click', event => {
  document.querySelectorAll('details.profile-menu[open]').forEach(menu => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});

function warmEngine() {
  const load = () => {
    for (const file of ['WebClient.wasm', 'WebClient.js', 'WasmPlayer.js', 'WasmLoader.js']) {
      const prefetch = el('link');
      prefetch.rel = 'prefetch';
      prefetch.as = 'fetch';
      prefetch.crossOrigin = 'anonymous';
      prefetch.href = `${ENGINE_FILES}${file}`;
      document.head.append(prefetch);
    }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 3000 });
  else setTimeout(load, 1500);
}

watchTheme();
mountGnMath();
mountXbox();
clearJoin();
document.querySelectorAll('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon)));

try {
  const saved = JSON.parse(localStorage.getItem(HOME_KEY));
  if (saved) {
    state.home = saved.home;
    state.me = saved.me;
    state.robux = saved.robux;
    Object.assign(state.art, saved.art);
    Object.assign(state.icons, saved.icons);
    Object.assign(state.faces, saved.faces);
    Object.assign(state.names, saved.names);
    Object.values(saved.games || {}).forEach(rememberGame);
    renderMe();
  }
  const charts = JSON.parse(localStorage.getItem(CHARTS_KEY));
  if (charts) state.charts = charts;
} catch {}

document.getElementById('shell-back').addEventListener('click', () => history.back());
document.getElementById('shell-forward').addEventListener('click', () => history.forward());
document.getElementById('shell-reload').addEventListener('click', () => location.reload());
new MutationObserver(() => {
  renderShell(currentRoute());
  refreshArt();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
window.addEventListener('hashchange', route);
if (!state.me) {
  try {
    const me = await api('https://users.roblox.com/v1/users/authenticated');
    state.me = { id: me.id, name: me.displayName || me.name };
  } catch {}
}
route();
performance.mark('launcher-first-content');

warmEngine();
refreshHome().then(() => performance.mark('launcher-fresh-content'));
setInterval(() => {
  if (state.me && document.visibilityState === 'visible') loadFriends().catch(() => {});
}, PRESENCE_MS);
setInterval(refreshCounts, COUNTS_MS);
