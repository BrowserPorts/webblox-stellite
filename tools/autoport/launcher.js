'use strict';

const { readPlans } = require('./pipeline');
const { portModels } = require('./patches/models');
const Sources = require('./sources');

async function portLauncherProfile({ hash, newModels, engineDir, planDir, log }) {
  const { profile } = readPlans(planDir);
  const oldWindows = await Sources.currentWindows(profile, engineDir, log);
  const { models: oldModels } = await Sources.windowsModels(oldWindows, log);
  const { next, results } = portModels({ oldModels, newModels, profile, bundles: null });
  const failed = results.filter(result => result.status === 'failed');
  if (failed.length) return { ok: false, reason: failed.map(result => `${result.title}: ${result.reason}`).join('; ') };
  if (JSON.stringify(next.wordmarkBoxes) !== JSON.stringify(profile.wordmarkBoxes)) return { ok: false, reason: 'the wordmark moved on the sprite sheets, which come with the web client' };
  return {
    ok: true,
    profile: {
      ...profile,
      windows: hash,
      rectEdits: next.rectEdits,
      aspect: next.aspect,
      bytecodeEdits: next.bytecodeEdits,
      bytecodeVersion: next.bytecodeVersion === undefined ? profile.bytecodeVersion : next.bytecodeVersion,
    },
  };
}

module.exports = { portLauncherProfile };
