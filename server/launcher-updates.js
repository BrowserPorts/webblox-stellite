const path = require('path');
const { spawn } = require('child_process');
const { BASE } = require('./config');

const TOOL = path.join(BASE, 'tools', 'update-launcher.js');
const CHECK_MS = 60 * 60 * 1000;

let running = false;

function check() {
  if (running) return;
  running = true;
  const child = spawn(process.execPath, [TOOL, '--quiet'], { stdio: 'inherit' });
  const done = () => {
    running = false;
  };
  child.on('error', err => {
    console.error(`[launcher] could not start the update check: ${err.message}`);
    done();
  });
  child.on('close', done);
}

function startLauncherUpdates() {
  if (process.env.WEBBLOX_NO_LAUNCHER_UPDATES) return;
  check();
  setInterval(check, CHECK_MS).unref();
}

module.exports = { startLauncherUpdates };
