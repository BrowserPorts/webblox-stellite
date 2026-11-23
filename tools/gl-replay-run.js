'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('=');
  return at > 0 ? [arg.slice(0, at).replace(/^--/, ''), arg.slice(at + 1)] : [arg.replace(/^--/, ''), true];
}));

const browserPath = process.env.CHROME || args.chrome;
if (!browserPath) {
  console.error('Set CHROME to a Chromium executable.');
  process.exit(1);
}
const PORT = Number(process.env.GL_TRACE_PORT) || 3300;
const out = args.out || path.join('.cache', 'gl-traces', args.trace, `replay-${args.backend || 'webgl'}`);

const summarize = frames => {
  const pick = key => frames.map(frame => frame[key]).sort((a, b) => a - b);
  const stat = key => {
    const list = pick(key);
    if (!list.length) return null;
    return { p50: list[list.length >> 1], p95: list[Math.floor(list.length * 0.95)], max: list[list.length - 1] };
  };
  return { frames: frames.length, calls: stat('calls'), draws: stat('draws'), glMs: stat('glMs'), loopMs: stat('loopMs'), gpuWaitMs: stat('gpuWaitMs') };
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    defaultViewport: null,
    protocolTimeout: 1800000,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--window-size=1700,1100', '--force-device-scale-factor=2', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const page = await browser.newPage();
  const log = [];
  page.on('console', message => log.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', error => log.push(`pageerror: ${error.message}`));
  const query = new URLSearchParams({ trace: args.trace, backend: args.backend || 'webgl', start: args.start || 0 });
  if (args.end) query.set('end', args.end);
  if (args.shots) query.set('shots', args.shots);
  if (args.timing) query.set('timing', '1');
  if (args.skip) query.set('skip', args.skip);
  await page.goto(`http://localhost:${PORT}/replay.html?${query}`);
  const limitMs = Number(args.timeout || 1200) * 1000;
  const begun = Date.now();
  while (Date.now() - begun < limitMs) {
    const done = await page.evaluate(() => window.__replay && window.__replay.done);
    if (done) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const report = await page.evaluate(() => window.__replay);
  fs.mkdirSync(out, { recursive: true });
  for (const [frame, url] of Object.entries(report.shots || {})) {
    fs.writeFileSync(path.join(out, `frame-${frame}.png`), Buffer.from(url.split(',')[1], 'base64'));
  }
  delete report.shots;
  report.summary = summarize(report.frames);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report));
  fs.writeFileSync(path.join(out, 'console.log'), log.join('\n'));
  console.log(JSON.stringify({ done: report.done, summary: report.summary, errors: report.errors.slice(0, 10), failures: report.frames.reduce((n, f) => n + f.failures, 0), webgpu: report.webgpu }, null, 1));
  console.log(log.filter(line => /error|warn/i.test(line)).slice(0, 12).join('\n').slice(0, 2400));
  await browser.close();
})().catch(error => {
  console.error(String(error.stack || error).slice(0, 800));
  process.exit(1);
});
