const { search } = require('../server/place-cache');

const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const json = args.includes('--json');
if (json) args.splice(args.indexOf('--json'), 1);
const placeId = option('place');
const type = option('type');
const limit = option('limit');
const q = args.join(' ') || undefined;

const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
const date = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '-');

const result = search({ place: placeId, q, type, limit });
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.error) {
  console.error(result.error);
  process.exitCode = 1;
} else if (result.assets) {
  console.log(`${result.name || '(unnamed)'}  place ${result.placeId}  universe ${result.universeId || '-'}`);
  console.log(`${result.joins} join(s), last ${date(result.lastJoin)}, ${result.assetCount} assets, ${mb(result.bytes)}`);
  if (result.folder) console.log(`${result.saved} saved in ${result.folder}`);
  console.log(`${result.matched} matching asset(s)\n`);
  console.table(result.assets.map(a => ({ assetId: a.id || '-', type: a.type || '-', format: a.format || '-', KB: a.bytes ? Math.round(a.bytes / 1024) : '-', file: a.file || '-' })));
} else if (!result.places.length) {
  console.log('No places match.');
} else {
  console.table(result.places.map(p => ({ placeId: p.placeId, universe: p.universeId || '-', name: p.name || '-', joins: p.joins, lastJoin: date(p.lastJoin), assets: p.assetCount, size: mb(p.bytes), matches: p.assetMatches ? p.assetMatches.length : '' })));
}
