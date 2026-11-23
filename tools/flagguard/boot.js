'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep, findChrome, freePort, getJson, waitFor, cdp, startServer, launchChrome } = require('../headless');
const { effective, sameValue } = require('./flags');

const IXP_KEY = 'rbxIxpSettings.v1';
const SERVER_SECONDS = 20;
const BROWSER_SECONDS = 20;
const ISOLATION_SECONDS = 30;
const LOAD_SECONDS = 120;
const ENGINE_SECONDS = 30;
const IXP_SECONDS = 60;
const MAX_CONSOLE = 4000;
const MAX_TEXT = 500;
const THUMB_WIDTH = 64;
const THUMB_HEIGHT = 40;
const LOADED = "(() => { const o = document.getElementById('loading-overlay'); return !o || o.hidden || o.classList.contains('loading-exiting'); })()";
const ENGINE_READY = '(() => { const M = window.Module; return Boolean(M && M.HEAPU8 && M.HEAPU8.length); })()';

function memoryRows(table) {
  return Object.entries(table.keys)
    .filter(([, entry]) => entry.type === 'Flag' || entry.type === 'Int')
    .map(([key, entry]) => [key, entry.address, entry.type === 'Flag' ? 1 : 4]);
}

function memoryExpression(rows) {
  return `(() => { const M = window.Module; const H = M && M.HEAPU8; if (!H) return null; const view = new DataView(H.buffer); const rows = ${JSON.stringify(rows)}; const out = {}; for (const [key, address, size] of rows) out[key] = size === 1 ? H[address] : view.getInt32(address, true); return out; })()`;
}

function colorCountExpression(png) {
  return `new Promise(resolve => { const image = new Image(); image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = ${THUMB_WIDTH}; canvas.height = ${THUMB_HEIGHT}; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, ${THUMB_WIDTH}, ${THUMB_HEIGHT}); const pixels = context.getImageData(0, 0, ${THUMB_WIDTH}, ${THUMB_HEIGHT}).data; const seen = new Set(); for (let i = 0; i < pixels.length; i += 4) seen.add(((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4)); resolve(seen.size); }; image.onerror = () => resolve(null); image.src = 'data:image/png;base64,${png}'; })`;
}

function parseJson(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function boot({ base, env = {}, query = 'launcher=roblox', flagSet = null, settleSeconds = 10, captureIxp = false, readMemory = [], screenshot = null, log = () => {} }) {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chromium browser was found. Set CHROME_PATH to one.');
  const port = await freePort();
  const debugPort = await freePort();
  const server = startServer(base, { port, env: { WEBBLOX_NO_LAUNCHER_UPDATES: '1', WEBBLOX_NO_FLAG_WATCH: '1', ...env } });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-flags-'));
  const result = { steps: {}, console: [], errors: [], signedIn: false, flags: null, flagSet: null, ixpAtBoot: null, memory: null, ixp: null, screenshot: null };
  let browser = null;
  let tab = null;
  try {
    const up = await waitFor(() => getJson(`http://127.0.0.1:${port}/__stats`), SERVER_SECONDS);
    result.steps.server = Boolean(up);
    if (!up) throw new Error('The WebBlox server did not start.');
    result.signedIn = /Loaded Roblox session/.test(server.log());
    browser = launchChrome(chrome, { profile, debugPort });
    const targets = await waitFor(() => getJson(`http://127.0.0.1:${debugPort}/json`), BROWSER_SECONDS);
    const page = targets && targets.find(target => target.type === 'page');
    result.steps.browser = Boolean(page);
    if (!page) throw new Error('The browser did not start.');
    tab = cdp(page.webSocketDebuggerUrl);
    await tab.opened;
    tab.on('Runtime.consoleAPICalled', params => {
      if (result.console.length >= MAX_CONSOLE) return;
      result.console.push({ type: params.type, text: (params.args || []).map(arg => (arg.value !== undefined ? arg.value : arg.description || '')).join(' ').slice(0, MAX_TEXT) });
    });
    tab.on('Runtime.exceptionThrown', params => {
      const details = params.exceptionDetails || {};
      result.errors.push(String((details.exception && details.exception.description) || details.text || 'an exception').slice(0, MAX_TEXT));
    });
    if (flagSet) {
      const body = Buffer.from(JSON.stringify(flagSet)).toString('base64');
      tab.on('Fetch.requestPaused', params => {
        tab.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body });
      });
      await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/engine/PinnedFlags.json*' }] });
    }
    await tab.send('Runtime.enable');
    await tab.send('Page.enable');
    log(`Booting the engine headless (${query})`);
    await tab.send('Page.navigate', { url: `http://localhost:${port}/?${query}` });
    result.steps.isolated = Boolean(await waitFor(() => tab.evaluate('window.crossOriginIsolated === true'), ISOLATION_SECONDS));
    result.steps.loaded = Boolean(await waitFor(() => tab.evaluate(LOADED), LOAD_SECONDS));
    result.steps.engine = Boolean(await waitFor(() => tab.evaluate(ENGINE_READY), ENGINE_SECONDS));
    result.flagSet = (await tab.evaluate('window.__webbloxFlagSet || null')) || null;
    result.flags = (await tab.evaluate('window.__webbloxFlags || null')) || null;
    result.ixpAtBoot = parseJson(await tab.evaluate('window.__webbloxIxpAtBoot || null'));
    await sleep(settleSeconds * 1000);
    if (readMemory.length && result.steps.engine) result.memory = await tab.evaluate(memoryExpression(readMemory));
    if (captureIxp) result.ixp = parseJson(await waitFor(() => tab.evaluate(`localStorage.getItem('${IXP_KEY}')`), IXP_SECONDS, 1000));
    if (screenshot !== false) {
      const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
      const png = shot.result && shot.result.data;
      if (png) {
        if (screenshot) {
          fs.mkdirSync(path.dirname(screenshot), { recursive: true });
          fs.writeFileSync(screenshot, Buffer.from(png, 'base64'));
        }
        result.screenshot = { file: screenshot || null, colors: await tab.evaluate(colorCountExpression(png)) };
      }
    }
  } finally {
    if (tab) tab.close();
    if (browser) browser.kill();
    server.stop();
    await sleep(500);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
  return result;
}

function memoryValue(entry, actual) {
  return entry.type === 'Flag' ? actual !== 0 : String(actual);
}

function expectedValue(entry, value) {
  if (value === null || value === undefined) return null;
  if (entry.type === 'Flag') return value;
  return BigInt.asIntN(32, BigInt(value)).toString();
}

function verifyMemory(table, flags, ixp, memory) {
  const set = { applicationSettings: flags || {}, ixp: ixp || {} };
  const outcome = { checked: 0, matched: 0, staged: 0, notApplied: [], engineWrites: [] };
  for (const [key, actual] of Object.entries(memory || {})) {
    const entry = table.keys[key];
    if (!entry) continue;
    const state = effective(table, set, key);
    if (state.source === 'staged') {
      outcome.staged++;
      continue;
    }
    outcome.checked++;
    const expected = expectedValue(entry, state.value);
    const got = memoryValue(entry, actual);
    if (expected !== null && sameValue(expected, got)) outcome.matched++;
    else if (state.source === 'default') outcome.engineWrites.push({ key, expected, actual: got });
    else outcome.notApplied.push({ key, expected, actual: got, raw: state.raw, source: state.source });
  }
  return outcome;
}

module.exports = { boot, verifyMemory, memoryRows, IXP_KEY };
