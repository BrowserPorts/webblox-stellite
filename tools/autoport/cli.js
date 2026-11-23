#!/usr/bin/env node
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pipeline, readPlans, RECOVERY_FILE, ROOT } = require('./pipeline');
const { printSummary } = require('./report');
const { apply, rollback } = require('./apply');
const { writeRecovery, sha } = require('./delta');
const Sources = require('./sources');

const MIN_NODE = [22, 15];
const LOW_PRIORITY = 10;
const VERSION_NAME = /^version-[0-9a-z-]+$/;

const HELP = `Ports every WebBlox patch onto a new Roblox web client build.

Usage: npm run autoport -- [options]

With no options, it checks the live web client. If a new build exists, it
downloads the build, ports the patches, builds a stage in .cache/engine-update
and writes a report. public/ stays untouched until you pass --apply.

Options:
  --status            Print the current and live builds, then stop.
  --apply [version]   Install a finished stage. The default is the live build.
  --rollback          Put back the engine that --apply replaced.
  --selftest          Rebuild the current engine from its pristine download and
                      compare every file. Run this after changing the tool.
  --to <version>      Port to this web client hash instead of the live one.
  --bundle <dir>      Port to a pristine build already on disk.
  --windows <hash>    Use the models and shaders of this Windows build.
  --force             Run even when the current build is already live.
  --allow-partial     Let --apply install a stage without some optional patches.
  --smoke             Boot the stage in a headless browser as a final check.
  --skip-shaders      Skip the shader port. The stage cannot be applied.
  --no-cache          Match the builds again instead of using the saved result.
  --write-recovery    Rewrite tools/backport/pristine.delta for the current build.
  --verbose           Show the output of the tools this one runs.
  --help              Print this text.

Exit codes: 0 ready or up to date, 1 failed, 2 ready without optional patches.`;

function parse(argv) {
  const flags = new Set(['--status', '--rollback', '--selftest', '--force', '--allow-partial', '--smoke', '--skip-shaders', '--no-cache', '--write-recovery', '--verbose', '--help', '--apply']);
  const values = new Set(['--to', '--bundle', '--windows']);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const key = arg.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (values.has(arg)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[key] = argv[++i];
    } else if (flags.has(arg)) {
      options[key] = true;
      if (arg === '--apply' && argv[i + 1] && !argv[i + 1].startsWith('--')) options.applyVersion = argv[++i];
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) throw new Error(`needs Node ${MIN_NODE.join('.')} or newer for zstd, and this is ${process.versions.node}`);
}

function lowerPriority() {
  try {
    os.setPriority(0, LOW_PRIORITY);
  } catch {}
}

function reportTools() {
  const missing = [];
  const probe = (name, args = ['--version']) => {
    const run = spawnSync(name, args, { stdio: 'ignore' });
    if (run.error && run.error.code === 'ENOENT') missing.push(name);
  };
  probe('spirv-cross');
  probe('luau-compile');
  return missing;
}

async function status() {
  const plans = readPlans(path.join(ROOT, 'tools', 'backport'));
  console.log(`WebBlox engine: ${plans.profile.version}`);
  console.log(`Windows models: ${plans.profile.windows}`);
  const recovery = path.join(ROOT, 'tools', 'backport', RECOVERY_FILE);
  console.log(`Recovery file: ${fs.existsSync(recovery) ? 'present' : 'missing'}`);
  const live = await Sources.latest();
  console.log(`Live web client: ${live.web.hash} (${live.web.version})`);
  console.log(`Live Windows: ${live.windows.hash} (${live.windows.version})`);
  if (live.web.hash === plans.profile.version) {
    console.log('Up to date.');
    return 0;
  }
  console.log('A new web client build is out. Run npm run autoport.');
  return 2;
}

function writeRecoveryFile() {
  const planDir = path.join(ROOT, 'tools', 'backport');
  const plans = readPlans(planDir);
  const pristine = fs.readFileSync(path.join(Sources.BUILDS, plans.profile.version, 'WebClient.wasm'));
  if (sha(pristine) !== plans.home.sourceSha256) throw new Error('the cached pristine engine does not match the plan');
  const patched = fs.readFileSync(path.join(ROOT, 'public', 'engine', 'WebClient.wasm'));
  if (sha(patched) !== plans.threads.patchedSha256) throw new Error('public/engine/WebClient.wasm does not match the plan');
  const { bytes } = writeRecovery(path.join(planDir, RECOVERY_FILE), { version: plans.profile.version, source: patched, target: pristine });
  console.log(`Wrote tools/backport/${RECOVERY_FILE}, ${bytes} bytes`);
  return 0;
}

function checkVersionName(name, label) {
  if (name !== undefined && !VERSION_NAME.test(name)) throw new Error(`${label} must look like version-0123abcd, and this is ${name}`);
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  checkNode();
  checkVersionName(options.to, '--to');
  checkVersionName(options.windows, '--windows');
  checkVersionName(options.applyVersion, '--apply');
  if (options.status) return status();
  if (options.writeRecovery) return writeRecoveryFile();
  const log = message => console.log(`[autoport] ${message}`);
  if (options.rollback) {
    rollback({ log });
    return 0;
  }
  if (options.apply) {
    const version = options.applyVersion || options.to || (await Sources.latest()).web.hash;
    apply(version, { allowPartial: options.allowPartial, log });
    return 0;
  }
  const missingTools = options.skipShaders ? [] : reportTools();
  if (missingTools.length) throw new Error(`install these tools first: ${missingTools.join(', ')}`);
  lowerPriority();
  const pipeline = new Pipeline({ ...options, toVersion: options.to, log });
  const { report, exitCode } = await pipeline.run();
  printSummary(report);
  return exitCode;
}

main().then(code => {
  process.exitCode = code;
}).catch(error => {
  console.error(`[autoport] ${error.message}`);
  if (process.env.AUTOPORT_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
