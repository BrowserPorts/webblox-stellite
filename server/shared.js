const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PORT, BASE } = require('./config');

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function isTrustedRequest(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
  return true;
}

async function readBody(req, limit = Infinity) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'set-cookie', 'access-control-allow-origin',
  'access-control-allow-credentials', 'access-control-allow-headers',
  'access-control-allow-methods', 'access-control-expose-headers',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'strict-transport-security',
]);

const TOKEN_FILE = path.join(BASE, '.cache', 'proxy-token');
const TOKEN_COOKIE = 'webblox_token';
function loadToken() {
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(saved)) return saved;
  } catch {}
  const fresh = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 });
  } catch {}
  return fresh;
}
const TOKEN = loadToken();
const tokenCookie = () => `${TOKEN_COOKIE}=${TOKEN}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly`;

function hasToken(req) {
  const value = readCookie(req, TOKEN_COOKIE);
  if (!value || value.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(TOKEN));
}

const ROBLOX_HOST = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/i;
const COOKIE_HOST = /(^|\.)roblox\.com$/i;
const CDN_ASSET_HOST = /(^|\.)(rbxcdn\.com|contentdelivery\.roblox\.com)$/i;

module.exports = {
  ROBLOX_HOST,
  COOKIE_HOST,
  CDN_ASSET_HOST,
  readCookie,
  hasToken,
  tokenCookie,
  ISOLATION_HEADERS,
  ALLOWED_HOSTS,
  isTrustedRequest,
  readBody,
  SKIP_RESPONSE_HEADERS,
};
