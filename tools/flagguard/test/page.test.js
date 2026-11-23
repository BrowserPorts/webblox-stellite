'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = path.join(__dirname, '..', '..', '..', 'public', 'index.html');
const START = 'const fetchWithoutSettings = window.fetch;';
const END = 'const RENDER_SCALE_KEY';
const SETTINGS_URL = 'https://clientsettingscdn.roblox.com/v2/settings/application/WebClientApp';
const ENGINE = 'version-test';

function pageCode() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const start = html.indexOf(START);
  const end = html.indexOf(END, start);
  assert.ok(start > 0 && end > start, 'the flag code is where the test expects it in public/index.html');
  return html.slice(start, end);
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makePage({ search = '', files = {}, live = { applicationSettings: { LiveOnly: '1', Shared: 'live' } }, liveStatus = 200, storage = {} }) {
  const store = new Map(Object.entries(storage));
  const requests = [];
  const logs = [];
  const window = {
    __webbloxEngineVersion: ENGINE,
    fetch: async (url, init) => {
      requests.push(String(url));
      if (String(url).startsWith('https://')) {
        if (liveStatus instanceof Error) throw liveStatus;
        return response(liveStatus, live);
      }
      const file = files[String(url)];
      return file === undefined ? response(404, {}) : response(200, file);
    },
  };
  const sandbox = {
    window,
    // The folder the site is served from, which the page works out before this code runs
    WEBBLOX_BASE: '/',
    location: { search, href: `http://localhost:3000/${search}` },
    localStorage: { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) },
    URL,
    URLSearchParams,
    Response: class {
      constructor(body, init) {
        this.body = body;
        this.status = init.status;
        this.ok = true;
      }
      async json() {
        return JSON.parse(this.body);
      }
    },
    console: { log: line => logs.push(line), warn: line => logs.push(line) },
    settingsFlags: () => ({ FromSettings: 'yes' }),
    loadSettings: () => ({}),
  };
  vm.runInNewContext(pageCode(), sandbox);
  return { window, store, requests, logs, fetchFlags: async url => (await window.fetch(url || SETTINGS_URL)).json() };
}

const pinned = (settings, extra = {}) => ({ format: 1, engine: ENGINE, pinnedAt: '2026-01-01T00:00:00.000Z', applicationSettings: settings, ixp: {}, ...extra });

test('the page gives the engine the pinned set without asking Roblox', async () => {
  const page = makePage({ files: { '/engine/PinnedFlags.json': pinned({ Shared: 'pinned', PinOnly: '1' }), '/engine/WebFlags.json': { applicationSettings: { Override: 'webblox' } } } });
  const data = await page.fetchFlags();
  assert.deepEqual(data.applicationSettings, { Shared: 'pinned', PinOnly: '1', Override: 'webblox', FromSettings: 'yes' });
  assert.equal(page.requests.some(url => url.startsWith('https://')), false);
  assert.equal(page.window.__webbloxFlagSet.name, 'pinned');
  assert.equal(page.window.__webbloxFlags.PinOnly, '1');
});

test('overrides win over the pin, and URL flags win over everything', async () => {
  const page = makePage({
    search: '?flag=Shared=url&flag=Broken',
    files: { '/engine/PinnedFlags.json': pinned({ Shared: 'pinned', Override: 'pinned' }), '/engine/WebFlags.json': { applicationSettings: { Override: 'webblox' } } },
  });
  const data = await page.fetchFlags();
  assert.equal(data.applicationSettings.Shared, 'url');
  assert.equal(data.applicationSettings.Override, 'webblox');
  assert.equal('Broken' in data.applicationSettings, false);
});

test('a pin made for another engine is skipped', async () => {
  const page = makePage({ files: { '/engine/PinnedFlags.json': pinned({ Shared: 'pinned' }, { engine: 'version-other' }) } });
  const data = await page.fetchFlags();
  assert.equal(data.applicationSettings.Shared, 'live');
  assert.equal(page.window.__webbloxFlagSet.name, 'live');
  assert.match(page.logs.join('\n'), /made for version-other/);
});

test('flagset=live asks Roblox even when a pin exists', async () => {
  const page = makePage({ search: '?flagset=live', files: { '/engine/PinnedFlags.json': pinned({ Shared: 'pinned' }) }, storage: { 'rbxIxpSettings.v1': '{"keep":"me"}' } });
  const data = await page.fetchFlags();
  assert.equal(data.applicationSettings.Shared, 'live');
  assert.equal(page.requests.includes('/engine/PinnedFlags.json'), false);
  assert.equal(page.store.get('rbxIxpSettings.v1'), '{"keep":"me"}');
});

test('a missing named set falls back to the pin, not to live flags', async () => {
  const page = makePage({ search: '?flagset=bisect', files: { '/engine/PinnedFlags.json': pinned({ Shared: 'pinned' }) } });
  const data = await page.fetchFlags();
  assert.equal(data.applicationSettings.Shared, 'pinned');
  assert.ok(page.requests.includes('/__flagset/bisect.json'));
  assert.equal(page.window.__webbloxFlagSet.name, 'pinned');
});

test('a named set is used when the server has it', async () => {
  const page = makePage({ search: '?flagset=parity', files: { '/__flagset/parity.json': pinned({ Shared: 'parity' }), '/engine/PinnedFlags.json': pinned({ Shared: 'pinned' }) } });
  assert.equal((await page.fetchFlags()).applicationSettings.Shared, 'parity');
  assert.equal(page.window.__webbloxFlagSet.name, 'parity');
});

test('bad set names are ignored', async () => {
  const page = makePage({ search: '?flagset=../../etc', files: { '/engine/PinnedFlags.json': pinned({ Shared: 'pinned' }) } });
  assert.equal((await page.fetchFlags()).applicationSettings.Shared, 'pinned');
  assert.equal(page.requests.some(url => url.includes('etc')), false);
});

test('the pin writes its experiment values before the engine reads them', async () => {
  const page = makePage({ files: { '/engine/PinnedFlags.json': pinned({}, { ixp: { FFlagA_IXPValue: 'true;1' } }) }, storage: { 'rbxIxpSettings.v1': '{"stale":"x"}' } });
  await page.fetchFlags();
  assert.deepEqual(JSON.parse(page.store.get('rbxIxpSettings.v1')), { FFlagA_IXPValue: 'true;1' });
  assert.equal(page.window.__webbloxIxpAtBoot, page.store.get('rbxIxpSettings.v1'));
  const empty = makePage({ files: { '/engine/PinnedFlags.json': pinned({}) }, storage: { 'rbxIxpSettings.v1': '{"stale":"x"}' } });
  await empty.fetchFlags();
  assert.equal(empty.store.has('rbxIxpSettings.v1'), false);
});

test("when Roblox's flag server fails, WebBlox's own flags still apply", async () => {
  for (const liveStatus of [503, new Error('offline')]) {
    const page = makePage({ search: '?flagset=live', liveStatus, files: { '/engine/WebFlags.json': { applicationSettings: { Override: 'webblox' } } } });
    const data = await page.fetchFlags();
    assert.deepEqual(data.applicationSettings, { Override: 'webblox', FromSettings: 'yes' });
  }
});

test('other requests and channel buckets are handled correctly', async () => {
  const page = makePage({ files: { '/engine/PinnedFlags.json': pinned({ Shared: 'pinned' }), '/other.json': { untouched: true } } });
  assert.deepEqual(await (await page.window.fetch('/other.json')).json(), { untouched: true });
  const bucket = await page.fetchFlags(`${SETTINGS_URL}/bucket/zbeta`);
  assert.equal(bucket.applicationSettings.Shared, 'pinned');
});
