#!/usr/bin/env node
'use strict';

// Fixes the bundled Cobalt client so it keeps the cookies a site sets. Run it again after replacing public/cobalt/cobalt.js.
//
// Cobalt stores cookies from the Set-Cookie headers of each answer, read with Headers.getSetCookie(). Its Wisp client
// hands back a real Response, and a browser removes Set-Cookie from a Response's headers, so that list is always empty
// and nothing a site sets is ever saved: a sign-in made through Roblox's own page is forgotten at once, and so is every
// session cookie Roblox rotates. The client keeps the untouched headers in `rawHeaders`, so the patch reads them there
// when the filtered list comes back empty.

const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR } = require('../server/config');

const FILE = path.join(PUBLIC_DIR, 'cobalt', 'cobalt.js');
// The statement that collects an answer's cookies. The response and list names differ between builds, so they are captured
const COLLECT = /let ([\w$]+)=([\w$]+)\.headers\.getSetCookie\?\2\.headers\.getSetCookie\(\):\[\2\.headers\.get\("set-cookie"\)\]\.filter\(Boolean\);/g;
const MARK = '.rawHeaders["set-cookie"]';

const source = fs.readFileSync(FILE, 'utf8');
if (source.includes(MARK)) {
  console.log('[cobalt] already patched');
  process.exit(0);
}
let sites = 0;
const patched = source.replace(COLLECT, (statement, list, response) => {
  sites++;
  return `${statement}if(!${list}.length&&${response}.rawHeaders&&${response}${MARK})${list}=[].concat(${response}${MARK});`;
});
if (sites !== 1) {
  console.error(`[cobalt] expected one place that collects cookies and found ${sites}, so nothing was changed`);
  process.exit(1);
}
fs.writeFileSync(FILE, patched);
console.log('[cobalt] cookies set by a site are now saved');
