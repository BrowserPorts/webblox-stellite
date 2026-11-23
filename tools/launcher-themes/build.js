#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { ramps, themes } = require('./roblox-tokens.json');

const OUTPUT = path.join(__dirname, '..', '..', 'public', 'launcher', 'app-themes.css');
const DEFAULT_SELECTOR = 'Default-dark';
const DARK_ONLY = new Set(['Halloween2026']);
const FONT = "'Builder Sans', system-ui, sans-serif";
const CLASSIC = {
  font: "'Comic Neue', system-ui, sans-serif",
  leading: 1.459,
  action: { dark: '#137f1f', light: '#12891d' },
  sizeAdjust: '95.95%',
};
const MIN_CONTRAST = 4.5;
const DARK_INK = '#121215';
const LIGHT_INK = '#ffffff';
const STAGE_TOP = 0.45;
const STAGE_MIDDLE = 0.2;

const channels = value => [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16));
const hex = values => `#${values.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;

function blend(color, opacity, under) {
  const top = channels(color);
  const bottom = channels(under);
  return hex(top.map((value, index) => value * opacity + bottom[index] * (1 - opacity)));
}

function overlay(token, under) {
  const [color, transparency] = Array.isArray(token) ? token : [token, 0];
  return blend(color, 1 - transparency, under);
}

function arrow(color) {
  return `url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27 width=%2732%27 height=%2732%27%3E%3Cpath fill=%27%23${color.slice(1)}%27 d=%27M15.2929 22.7071C15.6834 23.0976 16.3166 23.0976 16.7071 22.7071L26.7071 12.7071C27.0976 12.3166 27.0976 11.6834 26.7071 11.2929C26.3166 10.9024 25.6834 10.9024 25.2929 11.2929L16 20.5858L6.70711 11.2929C6.31658 10.9024 5.68342 10.9024 5.29289 11.2929C4.90237 11.6834 4.90237 12.3166 5.29289 12.7071L15.2929 22.7071Z%27/%3E%3C/svg%3E")`;
}

function luminance(color) {
  const [r, g, b] = channels(color).map(value => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(one, two) {
  const [high, low] = [luminance(one), luminance(two)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

function readable(color, ramp, layers, mode) {
  const passes = value => layers.every(layer => contrast(value, layer) >= MIN_CONTRAST);
  if (passes(color)) return color;
  const start = ramp.indexOf(color);
  const ordered = mode === 'dark' ? ramp : [...ramp].reverse();
  const nearest = (start >= 0 ? (mode === 'dark' ? ramp.slice(0, start).reverse() : ramp.slice(start + 1)) : ordered.slice().reverse());
  return nearest.find(passes) || ordered.find(passes) || color;
}

function block(name, mode, set) {
  const classic = name === 'Classic';
  const action = classic ? CLASSIC.action[mode] : set['ActionEmphasis.Background'];
  const bg = set['Surface.Surface_0'];
  const raised = set['Surface.Surface_100'];
  const stage = set['Surface.Surface_300'];
  const nav = set['Common.NavigationBar'];
  const hover = overlay(set['State.Hover'], raised);
  const navHover = overlay(set['State.Hover'], nav);
  const navActive = overlay(set['State.Hover'], navHover);
  const layers = [bg, raised, hover, nav, navActive];
  const muted = readable(set['Content.Muted'], [set['Content.Default'], set['Content.Emphasis']], layers, mode) === set['Content.Muted'] ? set['Content.Muted'] : set['Content.Default'];
  const online = readable(set['System.Success'], ramps.green, layers, mode);
  const selector = `[data-theme='${name}-${mode}']`;
  const lines = [
    `color-scheme: ${mode}`,
    `--font: ${classic ? CLASSIC.font : FONT}`,
    `--leading: ${classic ? CLASSIC.leading : 1.4}`,
    `--action: ${action}`,
    `--action-hover: ${overlay(set['State.Hover'], action)}`,
    `--bg: ${bg}`,
    `--nav: ${nav}`,
    `--nav-hover: ${navHover}`,
    `--nav-active: ${navActive}`,
    `--raised: ${raised}`,
    `--hover: ${hover}`,
    `--line: ${overlay(set['Stroke.Default'], bg)}`,
    `--line-strong: ${overlay(set['Stroke.Emphasis'], bg)}`,
    `--text: ${set['Content.Emphasis']}`,
    `--muted: ${muted}`,
    `--blue: ${readable(set['Content.Link'], ramps.blue, layers, mode)}`,
    `--online: ${online}`,
    `--on-online: ${contrast(LIGHT_INK, online) >= contrast(DARK_INK, online) ? LIGHT_INK : DARK_INK}`,
    `--danger: ${readable(set['ActionAlert.Foreground'], ramps.red, layers, mode)}`,
    `--stage-a: ${blend(muted, STAGE_TOP, stage)}`,
    `--stage-b: ${blend(muted, STAGE_MIDDLE, stage)}`,
    `--stage-c: ${stage}`,
    `--select-arrow: ${arrow(muted)}`,
  ];
  const head = `${name}-${mode}` === DEFAULT_SELECTOR ? `:root, ${selector}` : selector;
  return `${head} {\n${lines.map(line => `  ${line};`).join('\n')}\n}\n`;
}

const fontFace = (file, weight) => `@font-face { font-family: 'Comic Neue'; src: url('/assets/classic/${file}') format('truetype'); font-weight: ${weight}; font-display: swap; size-adjust: ${CLASSIC.sizeAdjust}; }\n`;

const blocks = [fontFace('ComicNeue-Regular.ttf', 400) + fontFace('ComicNeue-Bold.ttf', 700)];
const ordered = Object.entries(themes).sort(([one], [two]) => (two === 'Default') - (one === 'Default'));
for (const [name, modes] of ordered) {
  blocks.push(block(name, 'dark', modes.Dark));
  if (!DARK_ONLY.has(name)) blocks.push(block(name, 'light', modes.Light));
}
fs.writeFileSync(OUTPUT, blocks.join('\n'));
console.log(`${blocks.length - 1} theme blocks, ${fs.statSync(OUTPUT).size} bytes`);
