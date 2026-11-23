#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { sleep, findChrome, freePort, getJson, waitFor, cdp, startServer, launchChrome } = require('./headless');

const BASE = path.join(__dirname, '..');
const args = process.argv.slice(2);
const has = name => args.includes(`--${name}`);
const HEADED = has('headed');
const TIMEOUT_S = 90;
const valueOf = name => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : null;
};
const STAGE = valueOf('stage') ? path.resolve(valueOf('stage')) : null;
const PLANS = STAGE ? path.join(STAGE, 'plans') : path.join(__dirname, 'backport');
const PROFILE = JSON.parse(fs.readFileSync(path.join(PLANS, 'profile.json'), 'utf8'));
const THEME_ADDRESS = PROFILE.themeAddress;
const OUT = STAGE ? path.join(STAGE, 'smoke.png') : path.join(BASE, '.cache', 'smoke.png');
const CONSOLE_OUT = OUT.replace(/\.png$/, '-console.log');
const CONSOLE_TAIL = 20;
const STAGE_ENV = STAGE ? {
  WEBBLOX_ENGINE_DIR: path.join(STAGE, 'public', 'engine'),
  WEBBLOX_GEN_DIR: path.join(STAGE, 'public', 'gen'),
  WEBBLOX_INDEX_FILE: path.join(STAGE, 'public', 'index.html'),
  WEBBLOX_ENGINE_VERSION: PROFILE.version,
  WEBBLOX_NO_LAUNCHER_UPDATES: '1',
} : {};
const PATCH_ARGS = STAGE ? ['--bundle', path.join(STAGE, 'public', 'engine'), '--plans', PLANS] : [];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
async function main() {
  console.log('WebBlox smoke test\n');

  let patchOutput = '';
  try {
    patchOutput = execFileSync(process.execPath, [path.join(__dirname, 'patch-engine.js'), '--check', ...PATCH_ARGS], { encoding: 'utf8' });
  } catch (err) {
    patchOutput = String(err.stdout || err.message);
  }
  const failed = patchOutput.split('\n').filter(l => /FAILED|needed/.test(l));
  check('engine patches are applied', failed.length === 0, failed.map(l => l.trim()).join('; '));

  const chrome = findChrome();
  if (!chrome) {
    check('a Chromium browser is installed', false, 'set CHROME_PATH');
    return;
  }

  const port = await freePort();
  const server = startServer(BASE, { port, env: { ...STAGE_ENV, WEBBLOX_NO_FLAG_WATCH: '1' } });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-smoke-'));
  const debugPort = await freePort();
  let browser = null;
  try {
    const up = await waitFor(() => getJson(`http://127.0.0.1:${port}/__stats`), 20);
    check('server starts', Boolean(up));
    if (!up) return;
    const signedIn = /Loaded Roblox session/.test(server.log());

    browser = launchChrome(chrome, { profile, debugPort, headed: HEADED });
    const targets = await waitFor(() => getJson(`http://127.0.0.1:${debugPort}/json`), 20);
    const page = targets && targets.find(t => t.type === 'page');
    check('browser starts', Boolean(page));
    if (!page) return;

    const tab = cdp(page.webSocketDebuggerUrl);
    await tab.opened;
    const consoleLines = [];
    const valueText = item => (item.value !== undefined ? String(item.value) : item.description || item.type);
    tab.on('Runtime.consoleAPICalled', ({ type, args: items = [] }) => consoleLines.push(`${type}: ${items.map(valueText).join(' ')}`));
    tab.on('Runtime.exceptionThrown', ({ exceptionDetails = {} }) => consoleLines.push(`exception: ${exceptionDetails.exception ? exceptionDetails.exception.description || exceptionDetails.exception.value : exceptionDetails.text}`));
    await tab.send('Runtime.enable');
    await tab.send('Page.enable');
    const saveConsole = () => {
      fs.mkdirSync(path.dirname(CONSOLE_OUT), { recursive: true });
      fs.writeFileSync(CONSOLE_OUT, `${consoleLines.join('\n')}\n`);
    };
    process.on('exit', saveConsole);
    tab.consoleLines = consoleLines;
    await tab.send('Page.navigate', { url: `http://localhost:${port}/?launcher=roblox` });

    const isolated = await waitFor(() => tab.evaluate('window.crossOriginIsolated === true'), 20);
    check('page is cross-origin isolated', Boolean(isolated));

    const loaded = await waitFor(() => tab.evaluate("(() => { const o = document.getElementById('loading-overlay'); return !o || o.hidden || o.classList.contains('loading-exiting'); })()"), TIMEOUT_S);
    check('loader finishes and the launcher starts', Boolean(loaded));
    if (!loaded) {
      const problems = consoleLines.filter(line => /^(error|exception|warning|assert)|abort|RuntimeError|unreachable|Aborted/i.test(line));
      console.log(`\n  last console problems (all output in ${path.relative(BASE, CONSOLE_OUT)}):`);
      for (const line of problems.slice(-CONSOLE_TAIL)) console.log(`    ${line.slice(0, 400)}`);
      console.log('');
    }

    const theme = await waitFor(() => tab.evaluate(`(() => { const M = window.Module; const H = M && (M.HEAP32 || (M.wasmMemory && new Int32Array(M.wasmMemory.buffer))); return H ? H[${THEME_ADDRESS} >> 2] : null; })()`), 30);
    check('device theme reaches the engine', theme === 1 || theme === 2, theme === 1 ? 'light' : theme === 2 ? 'dark' : String(theme));

    if (signedIn) {
      const policy = await tab.evaluate("fetch('/__proxy__/https://apis.roblox.com/guac-v2/v1/bundles/app-policy').then(r => r.json()).then(p => p.EnableWebViewSupport === true).catch(() => false)");
      check('app policy enables web views', policy === true);
      const token = fs.readFileSync(path.join(BASE, '.cache', 'proxy-token'), 'utf8').trim();
      const html = await new Promise(resolve => {
        http.get({ host: '127.0.0.1', port, path: '/__proxy__/https://www.roblox.com/my/account', headers: { Host: `localhost:${port}`, 'Sec-Fetch-Dest': 'iframe', Cookie: `webblox_token=${token}`, 'User-Agent': 'Mozilla/5.0 Chrome/141' } }, res => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => resolve(data));
        }).on('error', () => resolve(''));
      });
      check('web views render in the in-app layout', /data-is-in-app="true"/.test(html));
    } else {
      console.log('  skip  signed-in checks (no .roblosecurity)');
    }

    await sleep(3000);
    const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
      console.log(`\n  screenshot: ${path.relative(BASE, OUT)}`);
    }
    tab.close();
  } finally {
    if (browser) browser.kill();
    server.stop();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  check('smoke test ran', false, err.message);
}).finally(() => {
  const failures = results.filter(r => !r.ok).length;
  console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
  process.exitCode = failures ? 1 : 0;
});
