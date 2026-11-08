'use strict';

const { nativeImage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { thumbsDir, previewsDir } = require('./config');

const THUMB_SIZE = 480;
const PREVIEW_SIZE = 2048;
const MAX_PARALLEL = 4;
const CACHE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;

let active = 0;
const queue = [];

function keyFor(row) {
  return crypto.createHash('sha1')
    .update(String(row.path) + '|' + row.mtime + '|' + row.size)
    .digest('hex');
}

function cachePathFor(row) {
  const key = keyFor(row);
  return path.join(thumbsDir, key.slice(0, 2), key + '.jpg');
}

function previewPathFor(row) {
  const key = keyFor(row);
  return path.join(previewsDir, key.slice(0, 2), key + '.jpg');
}

/** Windows 的 Shell 缩略图接口只接受反斜杠路径 */
function nativePath(file) {
  return process.platform === 'win32' ? path.win32.normalize(file) : file;
}

async function shellThumb(row, size) {
  try {
    const image = await nativeImage.createThumbnailFromPath(nativePath(row.path), { width: size, height: size });
    if (image && !image.isEmpty()) return image;
  } catch {
    /* try next decoder */
  }
  try {
    const loaded = nativeImage.createFromPath(nativePath(row.path));
    if (loaded && !loaded.isEmpty()) {
      const dims = loaded.getSize();
      const scale = Math.min(size / Math.max(1, dims.width), size / Math.max(1, dims.height), 1);
      return loaded.resize({
        width: Math.max(1, Math.round(dims.width * scale)),
        height: Math.max(1, Math.round(dims.height * scale)),
        quality: 'good'
      });
    }
  } catch {
    /* no decoder */
  }
  return null;
}

async function render(row) {
  const image = await shellThumb(row, THUMB_SIZE);
  if (!image) throw new Error('thumbnail failed');
  const buf = image.toJPEG(82);
  const target = cachePathFor(row);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buf);
  return target;
}

async function renderPreview(row) {
  const image = await shellThumb(row, PREVIEW_SIZE);
  if (!image) throw new Error('preview failed');
  const buf = image.toJPEG(88);
  const target = previewPathFor(row);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buf);
  return target;
}

function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    active++;
    job.fn()
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function ensureThumb(row, { force } = {}) {
  const target = cachePathFor(row);
  if (!force) {
    try {
      const st = await fsp.stat(target);
      if (st.size > 32) {
        const now = Date.now();
        // touch mtime for LRU bookkeeping, at most once an hour per file
        if (now - st.mtimeMs > 3600 * 1000) fsp.utimes(target, new Date(now), new Date(now)).catch(() => {});
        return target;
      }
    } catch {
      /* regenerate */
    }
  }
  return schedule(() => render(row));
}

/** 生成（或复用）缩略图并返回它的像素尺寸：视频靠它拿到展示方向的宽高比 */
async function ensureThumbInfo(row) {
  const file = await ensureThumb(row);
  try {
    const img = nativeImage.createFromPath(nativePath(file));
    if (!img.isEmpty()) {
      const s = img.getSize();
      if (s.width > 0 && s.height > 0) return { file, width: s.width, height: s.height };
    }
  } catch {
    /* ignore */
  }
  return { file, width: 0, height: 0 };
}

async function ensurePreview(row) {
  const target = previewPathFor(row);
  try {
    const st = await fsp.stat(target);
    if (st.size > 32) return target;
  } catch {
    /* generate */
  }
  return schedule(() => renderPreview(row));
}

const CACHE_DIRS = () => [thumbsDir, previewsDir];

async function cleanup(limitBytes) {
  const limit = limitBytes || CACHE_LIMIT_BYTES;
  const files = [];
  let total = 0;
  for (const root of CACHE_DIRS()) {
    let entries;
    try {
      entries = await fsp.readdir(root);
    } catch {
      continue;
    }
    for (const sub of entries) {
      const dir = path.join(root, sub);
      let list;
      try {
        const st = await fsp.stat(dir);
        if (!st.isDirectory()) continue;
        list = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of list) {
        const full = path.join(dir, name);
        try {
          const st = await fsp.stat(full);
          files.push({ full, size: st.size, atime: st.atimeMs });
          total += st.size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (total <= limit) return { removed: 0, bytes: total };
  files.sort((a, b) => a.atime - b.atime);
  let removed = 0;
  for (const f of files) {
    if (total <= limit) break;
    try {
      await fsp.unlink(f.full);
      total -= f.size;
      removed++;
    } catch {
      /* ignore */
    }
  }
  return { removed, bytes: total };
}

function clearCache() {
  let removed = 0;
  for (const root of CACHE_DIRS()) {
    try {
      for (const sub of fs.readdirSync(root)) {
        const dir = path.join(root, sub);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
          for (const name of fs.readdirSync(dir)) {
            try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return removed;
}

function cacheInfo() {
  let bytes = 0;
  let count = 0;
  for (const root of CACHE_DIRS()) {
    try {
      for (const sub of fs.readdirSync(root)) {
        const dir = path.join(root, sub);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
          for (const name of fs.readdirSync(dir)) {
            try {
              bytes += fs.statSync(path.join(dir, name)).size;
              count++;
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return { bytes, count, dir: thumbsDir };
}

module.exports = { ensureThumb, ensureThumbInfo, ensurePreview, cachePathFor, cleanup, clearCache, cacheInfo, THUMB_SIZE };