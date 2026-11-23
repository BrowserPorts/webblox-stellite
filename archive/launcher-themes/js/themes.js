import { el } from './core.js';
import { loadPreviewIcons, previewKey, themePreview } from './previews.js';

const THEME_KEY = 'webblox.launcher.theme';
const DEFAULT_THEME = 'dark';
const THEMES = [
  ['system', 'Match system'],
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['midnight', 'Midnight'],
  ['ocean', 'Ocean'],
  ['grape', 'Grape'],
  ['emerald', 'Emerald'],
  ['rose', 'Rose'],
  ['truffled', 'Truffled'],
  ['peak', 'Peak'],
  ['gn-math', 'gn-math 1'],
  ['gn-math-2', 'gn-math 2'],
  ['xbox', 'Xbox'],
];
const systemLight = matchMedia('(prefers-color-scheme: light)');
const resolve = theme => (theme === 'system' ? (systemLight.matches ? 'light' : 'dark') : theme);

function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return THEMES.some(([id]) => id === value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = resolve(savedTheme());
}

export function watchTheme() {
  applyTheme();
  systemLight.addEventListener('change', applyTheme);
  window.addEventListener('storage', event => {
    if (event.key === THEME_KEY) applyTheme();
  });
}

let shownPreviews = '';

export function refreshThemePreviews() {
  const group = document.querySelector('.theme-grid');
  if (!group || previewKey() === shownPreviews) return;
  shownPreviews = previewKey();
  group.querySelectorAll('.theme-card').forEach(card => {
    card.querySelector('.theme-preview').replaceWith(themePreview(resolve(card.querySelector('input').value)));
  });
  loadPreviewIcons(group);
}

export function themePicker() {
  const group = el('div', 'theme-grid');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Theme');
  const current = savedTheme();
  for (const [id, name] of THEMES) {
    const card = el('label', 'theme-card');
    const input = el('input');
    input.type = 'radio';
    input.name = 'launcher-theme';
    input.value = id;
    input.checked = id === current;
    input.addEventListener('change', () => {
      try {
        localStorage.setItem(THEME_KEY, id);
      } catch {}
      applyTheme();
    });
    card.append(input, themePreview(resolve(id)), el('span', 'theme-name', name));
    group.append(card);
  }
  shownPreviews = previewKey();
  loadPreviewIcons(group);
  return group;
}
