#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const forward = args.includes('--download') ? args.filter(arg => arg !== '--download') : ['--status', ...args];
const run = spawnSync(process.execPath, [path.join(__dirname, 'autoport', 'cli.js'), ...forward], { stdio: 'inherit' });
process.exitCode = run.status === null ? 1 : run.status;
