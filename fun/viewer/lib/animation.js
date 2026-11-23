const TICKS_PER_SECOND = 2400;
const EASING_STYLES = ['linear', 'constant', 'elastic', 'cubic', 'bounce'];
const EASING_DIRECTIONS = ['in', 'out', 'inOut'];
const ROTATION_ORDERS = ['XYZ', 'XZY', 'YZX', 'YXZ', 'ZXY', 'ZYX'];
const R15_PARTS = ['LowerTorso', 'UpperTorso', 'LeftUpperArm', 'RightUpperArm', 'LeftUpperLeg', 'RightUpperLeg', 'Head'];
const R6_PARTS = ['Torso', 'Left Arm', 'Right Arm', 'Left Leg', 'Right Leg'];

const multiply = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

function quatFromMatrix(m) {
  const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = m;
  const trace = r00 + r11 + r22;
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4];
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    q = [s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    q = [(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s];
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    q = [(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s];
  }
  const length = Math.hypot(...q) || 1;
  return q.map(v => v / length);
}

function quatFromEuler(x, y, z, order) {
  const axis = {
    X: [Math.sin(x / 2), 0, 0, Math.cos(x / 2)],
    Y: [0, Math.sin(y / 2), 0, Math.cos(y / 2)],
    Z: [0, 0, Math.sin(z / 2), Math.cos(z / 2)],
  };
  return [...order].map(name => axis[name]).reduce(multiply);
}

function readCurve(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 8) return [];
  const count = blob.readUInt32LE(4);
  const keysEnd = 8 + count * 14;
  const timesAt = keysEnd + 8;
  if (blob.length < timesAt + count * 4) return [];
  const keys = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 14;
    keys.push({
      mode: blob[at],
      value: blob.readFloatLE(at + 2),
      left: blob.readFloatLE(at + 6),
      right: blob.readFloatLE(at + 10),
      time: blob.readInt32LE(timesAt + i * 4) / TICKS_PER_SECOND,
    });
  }
  return keys;
}

function sampleCurve(keys, time) {
  if (!keys.length) return 0;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  let hi = 1;
  while (keys[hi].time < time) hi++;
  const a = keys[hi - 1];
  const b = keys[hi];
  const span = b.time - a.time;
  const t = span > 0 ? (time - a.time) / span : 0;
  if (a.mode === 0) return a.value;
  if (a.mode === 1) return a.value + (b.value - a.value) * t;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * span * a.right +
         (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * span * b.left;
}

function fromKeyframes(sequence) {
  const tracks = {};
  let duration = 0;
  const keyframes = sequence.children.filter(c => c.className === 'Keyframe').sort((a, b) => (a.props.Time || 0) - (b.props.Time || 0));
  const visit = (pose, time) => {
    if (pose.className !== 'Pose') return;
    const name = pose.props.Name;
    const cf = pose.props.CFrame;
    if (name && cf && (pose.props.Weight !== 0 || pose.children.length === 0 || !isIdentity(cf))) {
      (tracks[name] ||= []).push({
        t: time,
        p: cf.slice(0, 3),
        q: quatFromMatrix(cf.slice(3)),
        e: EASING_STYLES[pose.props.EasingStyle] || 'linear',
        d: EASING_DIRECTIONS[pose.props.EasingDirection] || 'in',
      });
    }
    for (const child of pose.children) visit(child, time);
  };
  for (const keyframe of keyframes) {
    const time = keyframe.props.Time || 0;
    duration = Math.max(duration, time);
    for (const child of keyframe.children) visit(child, time);
  }
  return { tracks, duration, keyframes: keyframes.length };
}

function isIdentity(cf) {
  const identity = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
  return identity.every((v, i) => Math.abs(cf[i] - v) < 1e-5);
}

function fromCurves(animation) {
  const tracks = {};
  let duration = 0;
  let keyframes = 0;
  const axis = (group, name) => {
    const curve = group && group.children.find(c => c.props.Name === name);
    return curve ? readCurve(curve.props.ValuesAndTimes) : [];
  };
  const visit = folder => {
    if (folder.className !== 'Folder') return;
    const position = folder.children.find(c => c.className === 'Vector3Curve');
    const rotation = folder.children.find(c => c.className === 'EulerRotationCurve');
    const curves = {
      px: axis(position, 'X'), py: axis(position, 'Y'), pz: axis(position, 'Z'),
      rx: axis(rotation, 'X'), ry: axis(rotation, 'Y'), rz: axis(rotation, 'Z'),
    };
    const times = new Set();
    for (const keys of Object.values(curves)) for (const key of keys) times.add(key.time);
    if (times.size) {
      const order = ROTATION_ORDERS[rotation && rotation.props.RotationOrder] || 'XYZ';
      const sorted = [...times].sort((a, b) => a - b);
      duration = Math.max(duration, sorted[sorted.length - 1]);
      keyframes = Math.max(keyframes, sorted.length);
      tracks[folder.props.Name] = sorted.map(time => ({
        t: time,
        p: [sampleCurve(curves.px, time), sampleCurve(curves.py, time), sampleCurve(curves.pz, time)],
        q: quatFromEuler(sampleCurve(curves.rx, time), sampleCurve(curves.ry, time), sampleCurve(curves.rz, time), order),
        e: 'linear',
        d: 'in',
      }));
    }
    for (const child of folder.children) visit(child);
  };
  for (const child of animation.children) visit(child);
  return { tracks, duration, keyframes };
}

function rigOf(tracks) {
  const parts = new Set(Object.keys(tracks));
  const r15 = R15_PARTS.filter(name => parts.has(name)).length;
  const r6 = R6_PARTS.filter(name => parts.has(name)).length;
  if (r15 >= 1 && r15 >= r6) return 'R15';
  if (r6 >= 1) return 'R6';
  return 'custom';
}

function normalizeAnimation(model) {
  const root = model.instances.find(i => i.className === 'KeyframeSequence' || i.className === 'CurveAnimation');
  if (!root) return null;
  const { tracks, duration, keyframes } = root.className === 'CurveAnimation' ? fromCurves(root) : fromKeyframes(root);
  const parts = Object.keys(tracks);
  return {
    name: root.props.Name || 'Animation',
    format: root.className,
    loop: root.props.Loop !== false,
    priority: root.props.Priority ?? null,
    duration,
    keyframes,
    rig: rigOf(tracks),
    parts,
    tracks,
  };
}

module.exports = { normalizeAnimation, quatFromMatrix };
