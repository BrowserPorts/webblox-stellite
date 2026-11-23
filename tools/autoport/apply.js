'use strict';

const fs = require('fs');
const path = require('path');
const { readPlans, stagePaths, replaceOnce, indexHtmlFor, PLAN_FILES, RECOVERY_FILE, ROOT } = require('./pipeline');
const { sha } = require('./delta');

const CONFIG_VERSION = /(process\.env\.WEBBLOX_ENGINE_VERSION \|\| ')version-[0-9a-z-]+(')/;
const TODO_HEADING = /(engine build `)version-[0-9a-z-]+(`)/;

function plansFiles() {
  return [...Object.values(PLAN_FILES), RECOVERY_FILE];
}

function layout(root) {
  const backup = path.join(root, '.cache', 'autoport', 'backup');
  return {
    backup,
    journal: path.join(backup, 'journal.json'),
    publicDir: path.join(root, 'public'),
    planDir: path.join(root, 'tools', 'backport'),
    updates: path.join(root, '.cache', 'engine-update'),
    config: path.join(root, 'server', 'config.js'),
    todo: path.join(root, 'TODO.md'),
  };
}

function preflight(stage, version) {
  const report = JSON.parse(fs.readFileSync(stage.reportJson, 'utf8'));
  if (report.to.version !== version) throw new Error(`the stage report is for ${report.to.version}`);
  for (const file of [stage.engine, stage.gen, stage.index]) {
    if (!fs.existsSync(file)) throw new Error(`the stage has no ${path.basename(file)}. Run npm run autoport again without --skip-shaders`);
  }
  const threads = JSON.parse(fs.readFileSync(path.join(stage.plans, PLAN_FILES.threads), 'utf8'));
  const wasm = fs.readFileSync(path.join(stage.engine, 'WebClient.wasm'));
  if (sha(wasm) !== threads.patchedSha256) throw new Error('the stage engine no longer matches its plan. Run npm run autoport again');
  return report;
}

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

function runJournal(moves, writes) {
  const done = [];
  const written = [];
  try {
    for (const entry of moves) {
      move(entry.from, entry.to);
      done.push(entry);
    }
    for (const entry of writes) {
      written.push(entry);
      fs.mkdirSync(path.dirname(entry.file), { recursive: true });
      fs.writeFileSync(entry.file, entry.data);
    }
  } catch (error) {
    for (const entry of done.reverse()) move(entry.to, entry.from);
    for (const entry of written) {
      if (entry.previous === null) fs.rmSync(entry.file, { force: true });
      else fs.writeFileSync(entry.file, entry.previous);
    }
    throw error;
  }
}

function apply(version, { allowPartial = false, log = () => {}, root = ROOT, testFailure = null } = {}) {
  const paths = layout(root);
  const stage = stagePaths(path.join(paths.updates, version));
  if (!fs.existsSync(stage.reportJson)) throw new Error(`no stage for ${version}. Run npm run autoport first`);
  const report = preflight(stage, version);
  const reportName = path.relative(root, stage.reportMarkdown);
  if (report.outcome === 'failed') throw new Error(`the stage failed its checks. Read ${reportName}`);
  if (report.outcome === 'partial' && !allowPartial) throw new Error(`the stage is missing optional patches. Read ${reportName}, then pass --allow-partial to install it anyway`);

  const current = readPlans(paths.planDir);
  const nextProfile = JSON.parse(fs.readFileSync(path.join(stage.plans, PLAN_FILES.profile), 'utf8'));

  fs.rmSync(paths.backup, { recursive: true, force: true });
  fs.mkdirSync(paths.backup, { recursive: true });

  const moves = [
    { from: path.join(paths.publicDir, 'engine'), to: path.join(paths.backup, 'engine') },
    { from: stage.engine, to: path.join(paths.publicDir, 'engine') },
    { from: path.join(paths.publicDir, 'gen'), to: path.join(paths.backup, 'gen') },
    { from: stage.gen, to: path.join(paths.publicDir, 'gen') },
  ];

  const writes = [];
  const saved = {};
  const addWrite = (file, data) => {
    const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
    saved[path.relative(root, file).split(path.sep).join('/')] = previous === null ? null : previous.toString('base64');
    writes.push({ file, data, previous });
  };
  const indexFile = path.join(paths.publicDir, 'index.html');
  addWrite(indexFile, indexHtmlFor(fs.readFileSync(indexFile, 'utf8'), version, nextProfile.themeAddress));
  addWrite(paths.config, replaceOnce(fs.readFileSync(paths.config, 'utf8'), CONFIG_VERSION, `$1${version}$2`, 'the engine version in server/config.js'));
  if (fs.existsSync(paths.todo)) {
    const todo = fs.readFileSync(paths.todo, 'utf8');
    if (TODO_HEADING.test(todo)) addWrite(paths.todo, todo.replace(TODO_HEADING, `$1${version}$2`));
  }
  for (const name of plansFiles()) {
    const source = path.join(stage.plans, name);
    if (fs.existsSync(source)) addWrite(path.join(paths.planDir, name), fs.readFileSync(source));
  }
  if (testFailure) writes.push(testFailure);

  fs.writeFileSync(paths.journal, JSON.stringify({ from: current.profile.version, to: version, saved, stage: path.relative(root, stage.root) }, null, 1));
  try {
    runJournal(moves, writes);
  } catch (error) {
    fs.rmSync(paths.journal, { force: true });
    throw new Error(`could not install the stage, and public/ is back as it was: ${error.message}. If the server is running on Windows, stop it first`);
  }
  log(`Installed ${version}. Restart the server so it reads the new engine version.`);
  log(`The old engine is in ${path.relative(root, paths.backup)}. Run npm run autoport -- --rollback to put it back.`);
  return { from: current.profile.version, to: version };
}

function rollback({ log = () => {}, root = ROOT } = {}) {
  const paths = layout(root);
  if (!fs.existsSync(paths.journal)) throw new Error('nothing to roll back');
  const journal = JSON.parse(fs.readFileSync(paths.journal, 'utf8'));
  const stage = stagePaths(path.join(root, journal.stage));
  move(path.join(paths.publicDir, 'engine'), stage.engine);
  move(path.join(paths.backup, 'engine'), path.join(paths.publicDir, 'engine'));
  move(path.join(paths.publicDir, 'gen'), stage.gen);
  move(path.join(paths.backup, 'gen'), path.join(paths.publicDir, 'gen'));
  for (const [rel, contents] of Object.entries(journal.saved)) {
    const file = path.join(root, ...rel.split('/'));
    if (contents === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, Buffer.from(contents, 'base64'));
  }
  fs.rmSync(paths.journal, { force: true });
  log(`Back on ${journal.from}. Restart the server so it reads the old engine version.`);
  return journal;
}

module.exports = { apply, rollback };
