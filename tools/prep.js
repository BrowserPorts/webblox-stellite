const fs = require('fs');
const path = require('path');

const publicArg = process.argv.indexOf('--public');
const BASE = publicArg >= 0 ? path.resolve(process.argv[publicArg + 1]) : path.join(__dirname, '..', 'public');
const ENGINE_DIR = path.join(BASE, 'engine');

const files = new Map();
const byName = new Map();

function walk(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(full, rel); continue; }
    if (!e.isFile()) continue;
    files.set(rel, { full, size: fs.statSync(full).size });
    const k = e.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(rel);
  }
}
walk(ENGINE_DIR, '');

function findBySuffix(rel) {
  const wanted = rel.split('/').filter(Boolean).map(s => s.toLowerCase());
  const candidates = byName.get(wanted[wanted.length - 1]);
  if (!candidates) return null;
  let best = null, bestScore = -1;
  for (const c of candidates) {
    const have = c.split('/').map(s => s.toLowerCase());
    let score = 0;
    while (score < have.length && score < wanted.length &&
           have[have.length - 1 - score] === wanted[wanted.length - 1 - score]) score++;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return (bestScore >= 2 || (bestScore >= 1 && candidates.size === 1)) ? best : null;
}

const served = rel => '/' + path.relative(BASE, files.get(rel).full).split(path.sep).join('/');

const routes = {};
for (const rel of files.keys()) routes[rel] = served(rel);

const metaFile = files.get('WebClient.metadata.json').full;
const list = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
let corrected = 0, added = 0, aliased = 0;
const known = new Set();
for (const entry of list) {
  const rel = String(entry.path || '').replace(/^\//, '');
  known.add(rel.toLowerCase());
  const f = files.get(rel);
  if (f && f.size !== entry.size) { entry.size = f.size; corrected++; }
  if (!f) {
    const alt = findBySuffix(rel);
    if (alt) { routes[rel] = served(alt); aliased++; }
  }
}
for (const [rel, f] of files) {
  if (!/^(content|ExtraContent|PlatformContent|shaders)\//i.test(rel) || known.has(rel.toLowerCase())) continue;
  list.push({ path: `/${rel}`, size: f.size });
  added++;
}
routes['WebClient.metadata.json'] = '/gen/WebClient.metadata.json';

fs.mkdirSync(path.join(BASE, 'gen'), { recursive: true });
fs.writeFileSync(path.join(BASE, 'gen', 'WebClient.metadata.json'), JSON.stringify(list));
fs.writeFileSync(path.join(BASE, 'gen', 'routes.json'), JSON.stringify(routes));
console.log(`routes: ${Object.keys(routes).length}, metadata: ${corrected} size(s) corrected, ${added} added, ${aliased} aliased`);
