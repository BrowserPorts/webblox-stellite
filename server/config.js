const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const BASE = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(BASE, 'public');
const ENGINE_VERSION = process.env.WEBBLOX_ENGINE_VERSION || 'version-db62701aba0b4bcd';

const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');
const ENGINE_DIR = process.env.WEBBLOX_ENGINE_DIR || path.join(PUBLIC_DIR, 'engine');
const GEN_DIR = process.env.WEBBLOX_GEN_DIR || path.join(PUBLIC_DIR, 'gen');
const ENGINE_URL = '/engine/';
const INDEX_FILE = process.env.WEBBLOX_INDEX_FILE || path.join(PUBLIC_DIR, 'index.html');

const PROXY_LOG = process.env.PROXY_LOG === '1';

module.exports = {
  PORT,
  BASE,
  PUBLIC_DIR,
  ENGINE_VERSION,
  ASSETS_DIR,
  ENGINE_DIR,
  GEN_DIR,
  ENGINE_URL,
  INDEX_FILE,
  PROXY_LOG,
};
