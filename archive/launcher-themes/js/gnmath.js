import { el, icon, link } from './core.js';

const TRAIL_MS = 420;
const TRAIL_POINTS = 64;
const TRAIL_ALPHA = 0.45;
const TINT = '#fc2651';

const theme = () => document.documentElement.dataset.theme;
const active = () => theme() === 'gn-math';
const CLOCK_THEMES = new Set(['gn-math', 'gn-math-2']);
const HOME_CHIPS = [['Charts', 'chart-three-vertical-bars', '#/charts'], ['Avatar', 'person-standing', '#/avatar'], ['Marketplace', 'shopping-basket', '#/marketplace'], ['Chat', 'speech-bubble-round', '#/chat'], ['Friends', 'two-people', '#/friends']];

function mountTrail() {
  const canvas = document.createElement('canvas');
  canvas.className = 'gn-trail';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const context = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const points = [];
  let frame = 0;
  let ratio = 1;
  const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const resize = () => {
    ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(innerWidth * ratio);
    const height = Math.round(innerHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };
  const paint = now => {
    frame = 0;
    while (points.length && now - points[0].t > TRAIL_MS) points.shift();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, innerWidth, innerHeight);
    if (points.length > 1) {
      context.strokeStyle = TINT;
      context.lineCap = 'butt';
      for (let i = 1; i < points.length; i++) {
        const start = i === 1 ? points[0] : middle(points[i - 2], points[i - 1]);
        const end = i === points.length - 1 ? points[i] : middle(points[i - 1], points[i]);
        const life = Math.max(0, 1 - (now - points[i].t) / TRAIL_MS) ** 2;
        for (const [width, strength] of [[7 * life + 2, 0.15], [2 * life + 0.5, 1]]) {
          context.globalAlpha = TRAIL_ALPHA * strength * life;
          context.lineWidth = width;
          context.beginPath();
          context.moveTo(start.x, start.y);
          context.quadraticCurveTo(points[i - 1].x, points[i - 1].y, end.x, end.y);
          context.stroke();
        }
      }
    }
    if (points.length) frame = requestAnimationFrame(paint);
  };
  window.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || document.hidden || reduced.matches || !active()) return;
    if (!frame) {
      resize();
      frame = requestAnimationFrame(paint);
    }
    points.push({ x: event.clientX, y: event.clientY, t: performance.now() });
    if (points.length > TRAIL_POINTS) points.shift();
  }, { passive: true });
}

export const dockTime = () => {
  const now = new Date();
  return `${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}\n${now.toLocaleDateString()}`;
};

function mountClock() {
  const clock = document.getElementById('shell-clock');
  const update = () => {
    if (!CLOCK_THEMES.has(theme()) || document.hidden) return;
    const now = new Date();
    clock.textContent = `${now.toLocaleTimeString()}\n${now.toLocaleDateString()}`;
    const dock = document.querySelector('.rail-time');
    if (dock) dock.textContent = dockTime();
  };
  update();
  setInterval(update, 1000);
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

let home = null;

export function gnHome(onSearch) {
  if (home) return home;
  home = el('section', 'gn-home');
  home.setAttribute('aria-label', 'Welcome');
  const inner = el('div', 'gn-home-inner');
  const form = el('form', 'gn-home-search');
  form.setAttribute('role', 'search');
  const glass = el('span');
  glass.append(icon('magnifying-glass'));
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Search games, people and communities';
  input.setAttribute('aria-label', 'Search');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const go = el('button');
  go.type = 'submit';
  go.setAttribute('aria-label', 'Search');
  go.append(icon('arrow-large-up'));
  form.append(glass, input, go);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (input.value.trim()) onSearch(input.value.trim());
  });
  const chips = el('nav', 'gn-home-chips');
  chips.setAttribute('aria-label', 'Shortcuts');
  chips.append(...HOME_CHIPS.map(([name, iconName, href]) => {
    const chip = link('gn-home-chip', href);
    chip.append(icon(iconName), name);
    return chip;
  }));
  inner.append(el('h1', 'gn-home-title', 'webblox'), form, chips);
  home.append(inner);
  return home;
}

export function mountGnMath() {
  mountTrail();
  mountClock();
}
