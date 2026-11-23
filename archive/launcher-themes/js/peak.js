import { el, icon, link, state } from './core.js';

const PIXEL = 3;
const FRAME_MS = 33;
const SPEED = 0.035;
const PALETTE = ['#0b0b0c', '#26262a', '#4d4d54', '#8a8a92', '#c9c9d0', '#ffffff'];
const QUICK = [
  ['Charts', 'chart-three-vertical-bars', '#/charts'],
  ['Avatar', 'person-standing', '#/avatar'],
  ['Marketplace', 'shopping-basket', '#/marketplace'],
  ['Chat', 'speech-bubble-round', '#/chat'],
  ['Friends', 'two-people', '#/friends'],
  ['Communities', 'three-people', '#/communities'],
];
const QUICK_MORE = [
  ['Robux', 'robux', '#/robux'],
  ['Settings', 'gear', '#/settings'],
];

const VERTEX = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 cells;
uniform float time;
uniform vec3 pointer;
uniform vec3 palette[6];
out vec4 color;

vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 invSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec2 fade(vec2 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

float perlin(vec2 p) {
  vec4 pi = mod289(floor(p.xyxy) + vec4(0.0, 0.0, 1.0, 1.0));
  vec4 pf = fract(p.xyxy) - vec4(0.0, 0.0, 1.0, 1.0);
  vec4 i = permute(permute(pi.xzxz) + pi.yyww);
  vec4 gx = fract(i * (1.0 / 41.0)) * 2.0 - 1.0;
  vec4 gy = abs(gx) - 0.5;
  gx -= floor(gx + 0.5);
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = invSqrt(vec4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11)));
  g00 *= norm.x;
  g01 *= norm.y;
  g10 *= norm.z;
  g11 *= norm.w;
  vec2 f = fade(pf.xy);
  vec2 x = mix(vec2(dot(g00, pf.xy), dot(g01, vec2(pf.x, pf.w))), vec2(dot(g10, vec2(pf.z, pf.y)), dot(g11, pf.zw)), f.x);
  return 2.3 * mix(x.x, x.y, f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 1.0;
  for (int i = 0; i < 4; i++) {
    value += amp * abs(perlin(p));
    p *= 3.0;
    amp *= 0.35;
  }
  return value;
}

float bayer(ivec2 p) {
  int value = 0;
  for (int i = 0; i < 3; i++) {
    int x = (p.x >> i) & 1;
    int y = (p.y >> i) & 1;
    value |= ((x ^ y) << (2 * (2 - i) + 1)) | (y << (2 * (2 - i)));
  }
  return (float(value) + 0.5) / 64.0;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5) / cells - 0.5;
  uv.x *= cells.x / cells.y;
  vec2 delta = uv - pointer.xy;
  float dist = length(delta);
  float touch = pointer.z * (1.0 - smoothstep(0.0, 0.22, dist));
  vec2 warp = (dist > 0.0001 ? delta / dist : vec2(0.0)) * sin(dist / 0.22 * 16.0 - time * 7.0) * 0.04 * touch;
  vec2 p = uv + warp;
  float f = fbm(p + fbm(p - time * ${SPEED.toFixed(3)}));
  float v = clamp((f - 0.5) * 1.1 + 0.5, 0.0, 1.0);
  int index = clamp(int(floor(v * 5.0 + bayer(ivec2(gl_FragCoord.xy) % 8))), 0, 5);
  color = vec4(palette[index], 1.0);
}`;

const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

function createDither(canvas, pixel = PIXEL) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) return null;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.warn('[launcher] dither shader failed:', gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(gl.getAttribLocation(program, 'position'));
  gl.vertexAttribPointer(gl.getAttribLocation(program, 'position'), 2, gl.FLOAT, false, 0, 0);
  gl.uniform3fv(gl.getUniformLocation(program, 'palette'), PALETTE.flatMap(channels));
  const uniforms = { cells: gl.getUniformLocation(program, 'cells'), time: gl.getUniformLocation(program, 'time'), pointer: gl.getUniformLocation(program, 'pointer') };
  return (time, pointer) => {
    const width = Math.max(1, Math.ceil(canvas.clientWidth / pixel));
    const height = Math.max(1, Math.ceil(canvas.clientHeight / pixel));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.uniform2f(uniforms.cells, width, height);
    gl.uniform1f(uniforms.time, time);
    gl.uniform3f(uniforms.pointer, pointer.x, pointer.y, pointer.strength);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

export function drawDither(canvas) {
  const paint = () => {
    if (!canvas.isConnected || !canvas.clientWidth) {
      requestAnimationFrame(paint);
      return;
    }
    createDither(canvas, 1.25)?.(12, { x: 0, y: 0, strength: 0 });
  };
  requestAnimationFrame(paint);
}

function runDither(canvas, host) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: 0, y: 0, strength: 0 };
  let draw = null;
  let failed = false;
  let last = 0;
  let visible = true;
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  }).observe(host);
  host.addEventListener('pointermove', event => {
    const box = canvas.getBoundingClientRect();
    if (!box.height) return;
    pointer.x = ((event.clientX - box.left) / box.width - 0.5) * (box.width / box.height);
    pointer.y = 0.5 - (event.clientY - box.top) / box.height;
    pointer.strength = reduced.matches ? 0 : 1;
  });
  const tick = now => {
    requestAnimationFrame(tick);
    const active = document.documentElement.dataset.theme === 'peak' && canvas.isConnected && visible && document.visibilityState === 'visible';
    if (!active || failed || now - last < FRAME_MS || !canvas.clientWidth) return;
    if (reduced.matches && last) return;
    last = now;
    draw = draw || createDither(canvas);
    if (!draw) {
      failed = true;
      return;
    }
    pointer.strength *= 0.96;
    draw(reduced.matches ? 12 : now / 1000, pointer);
  };
  requestAnimationFrame(tick);
}

function quickLink([name, iconName, href]) {
  const item = link('peak-quick-link', href);
  item.dataset.name = name;
  item.setAttribute('aria-label', name);
  item.append(icon(iconName));
  return item;
}

let hero = null;
let greeting = null;

export function peakHero(onSearch) {
  if (!hero) {
    hero = el('section', 'peak-home');
    hero.setAttribute('aria-label', 'Welcome');
    const canvas = el('canvas', 'peak-dither');
    canvas.setAttribute('aria-hidden', 'true');
    const logo = document.querySelector('.top .logo').cloneNode(true);
    logo.classList.add('peak-logo');
    greeting = el('p', 'peak-tagline');
    const form = el('form', 'peak-search');
    form.setAttribute('role', 'search');
    const glass = el('span', 'peak-search-icon');
    glass.append(icon('magnifying-glass'));
    const input = el('input');
    input.type = 'search';
    input.placeholder = 'Search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Search');
    const go = el('button');
    go.type = 'submit';
    go.setAttribute('aria-label', 'Search');
    go.append(icon('arrow-large-up'));
    form.append(glass, input, go);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (input.value.trim()) onSearch(input.value.trim());
    });
    const quick = el('nav', 'peak-quick');
    quick.setAttribute('aria-label', 'Shortcuts');
    quick.append(...QUICK.map(quickLink), el('span', 'peak-quick-sep'), ...QUICK_MORE.map(quickLink));
    hero.append(canvas, logo, greeting, form, quick);
    runDither(canvas, hero);
  }
  greeting.textContent = state.me?.name ? `hello, ${state.me.name}` : 'hello there';
  return hero;
}
