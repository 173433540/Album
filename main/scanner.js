'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const db = require('./db');
const thumbs = require('./thumbs');
const { readImageInfo, parseExifDate } = require('./exif');
const { VIDEO_EXT } = require('./media');

const IMAGE_EXT = new Set([
  // 常见
  '.jpg', '.jpeg', '.jpe', '.jfif', '.jif', '.png', '.apng', '.gif', '.bmp', '.dib',
  // 现代格式
  '.webp', '.avif', '.heic', '.heif', '.hif', '.jxl',
  // 无损 / 图形
  '.tif', '.tiff', '.svg', '.ico', '.cur',
  // 相机原始格式
  '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.pef', '.srw', '.raw', '.rwl', '.sr2',
  // 设计稿预览
  '.psd', '.ai', '.eps'
]);

const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules']);

async function walk(root, onFound) {
  const files = [];
  const stack = [root];
  const visited = new Set();
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = await fsp.stat(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        let real = full;
        try { real = await fsp.realpath(full); } catch { /* keep */ }
        if (visited.has(real)) continue;
        visited.add(real);
        stack.push(full);
      } else if (isFile) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) continue;
        files.push(full);
        if (onFound) onFound(files.length);
      }
    }
  }
  return files;
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let index = 0;
  const runners = new Array(Math.min(limit, Math.max(1, items.length))).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// 旧版按扩展名解析，个别“扩展名造假”的图存进了离谱的宽高；
// 这类行视为需要重新读取元数据
function saneDims(row) {
  const w = Number(row.width);
  const h = Number(row.height);
  if (!w || !h) return true;
  return w > 0 && h > 0 && w <= 100000 && h <= 100000;
}

async function buildRow(file, known, folderId) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return null;
  }
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  const isVideo = VIDEO_EXT.has(ext);
  const prior = known.get(file);
  let takenAt = null;
  let takenSrc = 'modified';
  let width = null;
  let height = null;

  const unchanged = prior && saneDims(prior) && prior.kind === (isVideo ? 'video' : 'photo')
    && (!isVideo || (Number(prior.width) > 0 && Number(prior.height) > 0))
    && Number(prior.size) === stat.size && Number(prior.mtime) === Math.round(stat.mtimeMs);
  if (unchanged) {
    takenAt = Number(prior.taken_at) || null;
    takenSrc = prior.taken_src || 'modified';
    width = prior.width == null ? null : Number(prior.width);
    height = prior.height == null ? null : Number(prior.height);
  } else if (isVideo) {
    // 视频没有 EXIF：用系统视频缩略图拿到展示方向下的宽高，缩略图同时缓存起来
    try {
      const info = await thumbs.ensureThumbInfo({
        path: file,
        mtime: Math.round(stat.mtimeMs),
        size: stat.size,
        ext
      });
      if (info) {
        width = info.width || null;
        height = info.height || null;
      }
    } catch {
      width = null;
      height = null;
    }
  } else {
    let info = {};
    try {
      info = readImageInfo(file, ext) || {};
    } catch {
      info = {};
    }
    width = info.width || null;
    height = info.height || null;
    const exifMs = parseExifDate(info.exifDate);
    if (exifMs) {
      takenAt = exifMs;
      takenSrc = 'exif';
    }
  }

  if (!takenAt) {
    const created = Number(stat.birthtimeMs) || Number(stat.ctimeMs) || Number(stat.mtimeMs);
    takenAt = Math.round(created);
    takenSrc = 'created';
  }
  if (!takenAt) {
    takenAt = Math.round(stat.mtimeMs);
    takenSrc = 'modified';
  }

  return {
    path: file,
    folderId,
    name,
    ext,
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
    ctime: Math.round(Number(stat.birthtimeMs) || Number(stat.ctimeMs) || stat.mtimeMs),
    takenAt,
    takenSrc,
    kind: isVideo ? 'video' : 'photo',
    width,
    height
  };
}

/**
 * Scan one folder (recursive). Reports progress through `emit(event)`.
 * Events: {phase:'walking'|'indexing'|'done', folderId, found, processed, added}
 */
async function scanFolder(folder, { emit, knownMap } = {}) {
  const started = Date.now();
  emit && emit({ phase: 'walking', folderId: folder.id, found: 0, processed: 0 });

  let walked = 0;
  const files = await walk(folder.path, (n) => {
    walked = n;
    if (n % 200 === 0) emit && emit({ phase: 'walking', folderId: folder.id, found: n, processed: 0 });
  });

  const known = knownMap || db.allRowsMap();
  const seen = [];
  let processed = 0;
  let added = 0;
  let failed = 0;

  const batchSize = 300;
  for (let i = 0; i < files.length; i += batchSize) {
    const slice = files.slice(i, i + batchSize);
    const rows = await mapLimit(slice, 8, async (file) => {
      try {
        return await buildRow(file, known, folder.id);
      } catch {
        return null;
      }
    });
    const clean = [];
    for (const row of rows) {
      if (!row) { failed++; continue; }
      seen.push(row.path);
      clean.push(row);
    }
    if (clean.length) {
      db.upsertPhotos(clean, folder.id);
      added += clean.length;
    }
    processed += slice.length;
    emit && emit({ phase: 'indexing', folderId: folder.id, found: files.length, processed, added, failed });
  }

  const removed = db.pruneFolder(folder.id, seen);
  db.touchFolder(folder.id, started);
  emit && emit({
    phase: 'done',
    folderId: folder.id,
    found: files.length,
    processed,
    added,
    failed,
    removed,
    ms: Date.now() - started
  });

  return { folderId: folder.id, found: files.length, indexed: added, failed, removed, ms: Date.now() - started };
}

/**
 * 旧版本按扩展名解析时，把少数“扩展名造假”的图存成了离谱宽高。
 * 启动时对这批行重新读一次元数据，避免照片墙里出现细长条。
 */
async function repairDimensions() {
  const rows = db.open().prepare(
    'SELECT path, ext, width, height FROM photos WHERE width > 100000 OR height > 100000 OR width < 0 OR height < 0 LIMIT 500'
  ).all();
  if (!rows.length) return 0;
  const fixed = [];
  for (const row of rows) {
    try {
      const info = readImageInfo(row.path, row.ext) || {};
      if (info.width > 0 && info.height > 0 && info.width <= 100000 && info.height <= 100000) {
        fixed.push({ path: row.path, width: info.width, height: info.height });
      }
    } catch {
      /* 读不到就保持原样 */
    }
  }
  return db.updateDimensions(fixed);
}

async function scanAll({ emit } = {}) {
  const folders = db.listFolders();
  const results = [];
  const knownRows = db.open().prepare('SELECT * FROM photos').all();
  const knownMap = new Map(knownRows.map((r) => [r.path, r]));
  for (const folder of folders) {
    results.push(await scanFolder(folder, { emit, knownMap }));
  }
  return results;
}

function detectExt(name) {
  return path.extname(name).toLowerCase();
}

module.exports = { scanFolder, scanAll, walk, repairDimensions, IMAGE_EXT, detectExt };