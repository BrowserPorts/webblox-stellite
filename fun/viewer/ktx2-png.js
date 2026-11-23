const fs = require('fs');
const path = require('path');
const { encodePng } = require('../../tools/png');
const { readLevel, decode } = require('./lib/ktx2');

function findFiles(target, out = []) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (target.endsWith('.ktx2')) out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target)) findFiles(path.join(target, entry), out);
  return out;
}

function convert(file) {
  const level = readLevel(fs.readFileSync(file));
  fs.writeFileSync(`${file}.png`, encodePng(level.width, level.height, decode(level)));
}

const target = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'game-cache'));
const done = new Map();
let converted = 0;
let skipped = 0;
const failures = new Map();
for (const file of findFiles(target)) {
  const out = `${file}.png`;
  const stat = fs.statSync(file);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= stat.mtimeMs) {
    skipped++;
    continue;
  }
  try {
    const twin = done.get(stat.ino);
    if (twin) {
      fs.rmSync(out, { force: true });
      fs.copyFileSync(twin, out);
    } else {
      convert(file);
      done.set(stat.ino, out);
    }
    converted++;
  } catch (err) {
    failures.set(err.message, (failures.get(err.message) || 0) + 1);
  }
}
console.log(`${converted} converted, ${skipped} already done`);
for (const [message, count] of failures) console.log(`${count} failed: ${message}`);
if (failures.size) process.exitCode = 1;
