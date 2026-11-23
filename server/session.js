const crypto = require('crypto');
const { readCookie } = require('./shared');

const PREFIX = 'rbx_';
const SESSION_COOKIE = `${PREFIX}.ROBLOSECURITY`;

function cookieHeader(req) {
  const out = [];
  for (const part of String(req?.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    const name = part.slice(0, eq).trim();
    if (eq > 0 && name.startsWith(PREFIX)) out.push(`${name.slice(PREFIX.length)}=${part.slice(eq + 1).trim()}`);
  }
  return out.join('; ');
}

function sessionKey(req) {
  const value = readCookie(req, SESSION_COOKIE);
  return value ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 32) : 'guest';
}

function storeCookies(res, setCookies) {
  const out = [];
  for (const sc of setCookies) {
    const [pair, ...attrs] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let maxAge = null;
    for (const attr of attrs) {
      const [k, v] = attr.split('=').map(s => s && s.trim());
      const key = (k || '').toLowerCase();
      if (key === 'max-age') maxAge = Number(v);
      else if (key === 'expires' && maxAge === null && !Number.isNaN(Date.parse(v))) maxAge = Math.floor((Date.parse(v) - Date.now()) / 1000);
    }
    if (value === '') maxAge = 0;
    const lifetime = maxAge === null || Number.isNaN(maxAge) ? '' : `; Max-Age=${Math.max(0, maxAge)}`;
    out.push(`${PREFIX}${name}=${value}; Path=/; HttpOnly; SameSite=Strict${lifetime}`);
  }
  if (out.length && !res.headersSent) res.appendHeader('Set-Cookie', out);
}

module.exports = {
  storeCookies,
  cookieHeader,
  sessionKey,
};
