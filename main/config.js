'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = process.env.PHOTOALBUM_DATA || path.join(app.getPath('appData'), 'PhotoAlbum');
const thumbsDir = path.join(dataDir, 'thumbs');
const previewsDir = path.join(dataDir, 'previews');
const settingsFile = path.join(dataDir, 'settings.json');
const dbFile = path.join(dataDir, 'library.db');

fs.mkdirSync(thumbsDir, { recursive: true });
fs.mkdirSync(previewsDir, { recursive: true });

const DEFAULTS = {
  folders: [],
  window: { width: 1200, height: 830, x: null, y: null, maximized: false },
  sort: 'taken',
  dir: 'desc',
  favoritesOnly: false,
  theme: 'dark',
  lastYear: null,
  viewerInfo: true
};

let cache = null;

function load() {
  if (cache) return cache;
  let loaded = {};
  try {
    loaded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    loaded = {};
  }
  cache = Object.assign({}, DEFAULTS, loaded, {
    window: Object.assign({}, DEFAULTS.window, loaded.window || {})
  });
  if (!Array.isArray(cache.folders)) cache.folders = [];
  return cache;
}

function save() {
  const data = load();
  const tmp = settingsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, settingsFile);
}

function set(patch) {
  const data = load();
  Object.assign(data, patch);
  save();
  return data;
}

function setWindow(win) {
  const data = load();
  data.window = Object.assign({}, data.window, win);
  save();
}

module.exports = { dataDir, thumbsDir, previewsDir, settingsFile, dbFile, load, save, set, setWindow, DEFAULTS };