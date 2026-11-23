const fs = require('fs');
const path = require('path');
const { ISOLATION_HEADERS } = require('./shared');

const ENABLED = process.env.GL_TRACE === '1';
const TRACES = path.join(__dirname, '..', '.cache', 'gl-traces');
const ROUTE = /^\/__gltrace\/(chunk|done)\/([\w.-]+)(?:\/(\d+))?$/;

function handleGlTrace(req, res, urlPath) {
  const match = ENABLED && req.method === 'POST' && ROUTE.exec(urlPath);
  if (!match) return false;
  const [, kind, name, index] = match;
  if (kind === 'chunk' && index === undefined) return false;
  const dir = path.join(TRACES, name);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, kind === 'chunk' ? `chunk-${index}.bin` : 'info.json');
  const partial = `${target}.part`;
  const out = fs.createWriteStream(partial);
  const fail = err => {
    console.error('[gltrace] write failed:', err.message);
    if (!res.headersSent) res.writeHead(500, ISOLATION_HEADERS);
    res.end();
  };
  out.on('error', fail);
  req.on('error', fail);
  req.pipe(out);
  out.on('finish', () => {
    fs.renameSync(partial, target);
    if (kind === 'done') console.log(`[gltrace] finished ${name}`);
    res.writeHead(204, ISOLATION_HEADERS);
    res.end();
  });
  return true;
}

module.exports = { handleGlTrace };
