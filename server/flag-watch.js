const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BASE } = require('./config');
const { ISOLATION_HEADERS } = require('./shared');

const TOOL = path.join(BASE, 'tools', 'flagguard', 'cli.js');
const SETS_DIR = path.join(BASE, '.cache', 'flagguard', 'sets');
const FIRST_CHECK_MS = 2 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;
const FLAG_SET_URL = /^\/__flagset\/([a-z0-9][a-z0-9-]{0,40})\.json$/;

let running = false;

function check() {
  if (running) return;
  running = true;
  const child = spawn(process.execPath, [TOOL, 'check'], { stdio: 'inherit' });
  child.on('error', err => {
    console.error(`[flags] could not start the flag check: ${err.message}`);
    running = false;
  });
  child.on('close', () => {
    running = false;
  });
}

function startFlagWatch() {
  if (process.env.WEBBLOX_NO_FLAG_WATCH || process.env.WEBBLOX_NO_LAUNCHER_UPDATES) return;
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_MS).unref();
}

function flagSetName(urlPath) {
  const match = FLAG_SET_URL.exec(urlPath);
  return match ? match[1] : null;
}

function serveFlagSet(res, name) {
  fs.readFile(path.join(SETS_DIR, `${name}.json`), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
      res.end(`There is no flag set called ${name}.`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
    res.end(data);
  });
}

module.exports = { startFlagWatch, flagSetName, serveFlagSet };
