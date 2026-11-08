'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { dbFile } = require('./config');
const { VIDEO_EXTS } = require('./media');

let db = null;

function open() {
  if (db) return db;
  db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      added_at INTEGER NOT NULL,
      last_scan INTEGER
    );
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      folder_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      ctime INTEGER NOT NULL,
      taken_at INTEGER NOT NULL,
      taken_src TEXT,
      kind TEXT NOT NULL DEFAULT 'photo',
      width INTEGER,
      height INTEGER,
      duration INTEGER,
      favorite INTEGER NOT NULL DEFAULT 0,
      broken INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at, id);
    CREATE INDEX IF NOT EXISTS idx_photos_mtime ON photos(mtime, id);
    CREATE INDEX IF NOT EXISTS idx_photos_ctime ON photos(ctime, id);
    CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id);
    CREATE INDEX IF NOT EXISTS idx_photos_name ON photos(name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cover_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS album_items (
      album_id INTEGER NOT NULL,
      photo_id INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (album_id, photo_id)
    );
    CREATE INDEX IF NOT EXISTS idx_album_items_photo ON album_items(photo_id);
  `);
  migrate(db);
  return db;
}

/** 给旧版数据库补上视频相关字段，并把已有视频扩展名的行标成 video */
function migrate(d) {
  const version = Number(d.prepare('PRAGMA user_version').get().user_version) || 0;
  const cols = d.prepare('PRAGMA table_info(photos)').all().map((c) => c.name);
  const addedKind = !cols.includes('kind');
  if (addedKind) d.exec("ALTER TABLE photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo'");
  if (!cols.includes('duration')) d.exec('ALTER TABLE photos ADD COLUMN duration INTEGER');
  if (version < 2 && addedKind) {
    const exts = [...VIDEO_EXTS];
    const marks = exts.map(() => '?').join(',');
    d.prepare(`UPDATE photos SET kind = 'video' WHERE lower(ext) IN (${marks})`).run(...exts);
  }
  if (version < 2) d.exec('PRAGMA user_version = 2');
}

function nowMs() {
  return Date.now();
}

/* ---------------- folders ---------------- */

function listFolders() {
  return open().prepare('SELECT * FROM folders ORDER BY added_at ASC').all();
}

/** 文件夹列表附带条目统计，供文件夹面板展示 */
function listFoldersWithCounts() {
  const rows = open().prepare(`
    SELECT f.*,
           COUNT(p.id) AS total,
           SUM(CASE WHEN p.kind = 'video' THEN 1 ELSE 0 END) AS videos
    FROM folders f
    LEFT JOIN photos p ON p.folder_id = f.id AND p.broken = 0
    GROUP BY f.id
    ORDER BY f.added_at ASC
  `).all();
  return rows.map((r) => ({
    ...r,
    total: Number(r.total) || 0,
    videos: Number(r.videos) || 0
  }));
}

function addFolder(folderPath) {
  const d = open();
  const existing = d.prepare('SELECT * FROM folders WHERE path = ?').get(folderPath);
  if (existing) return existing;
  d.prepare('INSERT INTO folders (path, added_at) VALUES (?, ?)').run(folderPath, nowMs());
  return d.prepare('SELECT * FROM folders WHERE path = ?').get(folderPath);
}

function removeFolder(id) {
  const d = open();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM photos WHERE folder_id = ?').run(id);
    d.prepare('DELETE FROM folders WHERE id = ?').run(id);
    purgeAlbumItems();
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function touchFolder(id, when) {
  open().prepare('UPDATE folders SET last_scan = ? WHERE id = ?').run(when, id);
}

/* ---------------- albums（自定义分类相册） ---------------- */

/** 照片被删除后清掉指向它们的分类关系，避免留下孤儿行 */
function purgeAlbumItems() {
  open().exec('DELETE FROM album_items WHERE photo_id NOT IN (SELECT id FROM photos)');
}

function albumPreviews(albumId) {
  return open().prepare(`
    SELECT ai.photo_id
    FROM album_items ai
    JOIN photos p ON p.id = ai.photo_id AND p.broken = 0
    WHERE ai.album_id = ?
    ORDER BY p.taken_at DESC, p.id DESC
    LIMIT 4
  `).all(albumId).map((r) => Number(r.photo_id));
}

function listAlbums() {
  const d = open();
  const rows = d.prepare(`
    SELECT a.*, (
      SELECT COUNT(*)
      FROM album_items ai
      JOIN photos p ON p.id = ai.photo_id AND p.broken = 0
      WHERE ai.album_id = a.id
    ) AS cnt
    FROM albums a
    ORDER BY a.created_at DESC, a.id DESC
  `).all();
  const coverOk = d.prepare('SELECT 1 AS ok FROM photos WHERE id = ? AND broken = 0');
  return rows.map((a) => {
    const previews = albumPreviews(a.id);
    let cover = a.cover_id == null ? null : Number(a.cover_id);
    if (cover != null && !coverOk.get(cover)) cover = null;
    if (cover == null && previews.length) cover = previews[0];
    return {
      id: Number(a.id),
      name: a.name,
      coverId: cover,
      previews,
      count: Number(a.cnt) || 0,
      createdAt: Number(a.created_at),
      updatedAt: Number(a.updated_at)
    };
  });
}

function findAlbum(id) {
  const list = listAlbums();
  return list.find((a) => a.id === Number(id)) || null;
}

function createAlbum(name, coverId) {
  const clean = String(name == null ? '' : name).trim().slice(0, 60);
  if (!clean) throw new Error('相册名称不能为空');
  const d = open();
  const at = nowMs();
  const res = d.prepare('INSERT INTO albums (name, cover_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(clean, coverId == null ? null : Number(coverId), at, at);
  return findAlbum(Number(res.lastInsertRowid));
}

function updateAlbum(id, patch) {
  const d = open();
  const cur = d.prepare('SELECT * FROM albums WHERE id = ?').get(Number(id));
  if (!cur) return null;
  let name = cur.name;
  if (patch && typeof patch.name === 'string') {
    const clean = patch.name.trim().slice(0, 60);
    if (clean) name = clean;
  }
  let cover = cur.cover_id;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'coverId')) {
    cover = patch.coverId == null ? null : Number(patch.coverId);
    if (cover != null && !d.prepare('SELECT 1 AS ok FROM photos WHERE id = ?').get(cover)) cover = null;
  }
  d.prepare('UPDATE albums SET name = ?, cover_id = ?, updated_at = ? WHERE id = ?')
    .run(name, cover, nowMs(), Number(id));
  return findAlbum(id);
}

/** 只删分类关系和相册本身，绝不碰原始媒体文件 */
function deleteAlbum(id) {
  const d = open();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM album_items WHERE album_id = ?').run(Number(id));
    d.prepare('DELETE FROM albums WHERE id = ?').run(Number(id));
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return true;
}

function addToAlbum(albumId, photoIds) {
  const aid = Number(albumId);
  const d = open();
  if (!d.prepare('SELECT 1 AS ok FROM albums WHERE id = ?').get(aid)) throw new Error('相册不存在');
  const stmt = d.prepare('INSERT OR IGNORE INTO album_items (album_id, photo_id, added_at) VALUES (?, ?, ?)');
  const exists = d.prepare('SELECT 1 AS ok FROM photos WHERE id = ? AND broken = 0');
  const at = nowMs();
  let added = 0;
  d.exec('BEGIN');
  try {
    for (const raw of photoIds || []) {
      const pid = Number(raw);
      if (!Number.isFinite(pid) || !exists.get(pid)) continue;
      const r = stmt.run(aid, pid, at);
      if (Number(r.changes)) added++;
    }
    d.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(at, aid);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { added, album: findAlbum(aid) };
}

function removeFromAlbum(albumId, photoIds) {
  const aid = Number(albumId);
  const d = open();
  const stmt = d.prepare('DELETE FROM album_items WHERE album_id = ? AND photo_id = ?');
  let removed = 0;
  d.exec('BEGIN');
  try {
    for (const raw of photoIds || []) {
      const pid = Number(raw);
      if (!Number.isFinite(pid)) continue;
      const r = stmt.run(aid, pid);
      removed += Number(r.changes) || 0;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { removed, album: findAlbum(aid) };
}

function albumsForPhoto(photoId) {
  return open().prepare('SELECT album_id FROM album_items WHERE photo_id = ? ORDER BY added_at DESC')
    .all(Number(photoId)).map((r) => Number(r.album_id));
}

/* ---------------- photos write ---------------- */

function upsertPhotos(rows, folderId) {
  if (!rows.length) return 0;
  const d = open();
  const stmt = d.prepare(`
    INSERT INTO photos (path, folder_id, name, ext, size, mtime, ctime, taken_at, taken_src, kind, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      folder_id = excluded.folder_id,
      name = excluded.name,
      ext = excluded.ext,
      size = excluded.size,
      mtime = excluded.mtime,
      ctime = excluded.ctime,
      taken_at = excluded.taken_at,
      taken_src = excluded.taken_src,
      kind = excluded.kind,
      width = excluded.width,
      height = excluded.height,
      broken = 0
  `);
  d.exec('BEGIN');
  let n = 0;
  try {
    for (const r of rows) {
      stmt.run(r.path, folderId, r.name, r.ext, r.size, r.mtime, r.ctime, r.takenAt, r.takenSrc,
        r.kind === 'video' ? 'video' : 'photo',
        r.width == null ? null : r.width, r.height == null ? null : r.height);
      n++;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return n;
}

function pruneFolder(folderId, seenPaths) {
  const d = open();
  const rows = d.prepare('SELECT id, path FROM photos WHERE folder_id = ?').all(folderId);
  const seen = new Set(seenPaths);
  const gone = rows.filter((r) => !seen.has(r.path));
  if (!gone.length) return 0;
  const stmt = d.prepare('DELETE FROM photos WHERE id = ?');
  d.exec('BEGIN');
  try {
    for (const r of gone) stmt.run(r.id);
    purgeAlbumItems();
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return gone.length;
}

function markBroken(id) {
  open().prepare('UPDATE photos SET broken = 1 WHERE id = ?').run(Number(id));
}

function deleteByIds(ids) {
  const d = open();
  const stmt = d.prepare('DELETE FROM photos WHERE id = ?');
  d.exec('BEGIN');
  try {
    for (const id of ids) stmt.run(id);
    purgeAlbumItems();
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/* ---------------- photos read ---------------- */

function dayStart(y, m) { // m: 1-12
  return new Date(y, m - 1, 1, 0, 0, 0, 0).getTime();
}

function monthEnd(y, m) {
  return dayStart(y, m + 1);
}

function buildFilter(f) {
  const where = ['broken = 0'];
  const params = [];

  if (f.q) {
    where.push('name LIKE ? COLLATE NOCASE');
    params.push('%' + String(f.q) + '%');
  }
  if (f.ext) {
    where.push('ext = ?');
    params.push(String(f.ext).toLowerCase());
  }
  if (f.media === 'video') where.push("kind = 'video'");
  else if (f.media === 'photo') where.push("kind = 'photo'");
  else if (f.media === 'gif') where.push("kind = 'photo' AND lower(ext) IN ('.gif', '.apng')");
  if (f.albumId) {
    where.push('id IN (SELECT photo_id FROM album_items WHERE album_id = ?)');
    params.push(Number(f.albumId));
  }
  if (f.folderId) { where.push('folder_id = ?'); params.push(f.folderId); }
  if (f.minSize) { where.push('size >= ?'); params.push(Number(f.minSize)); }
  if (f.maxSize) { where.push('size <= ?'); params.push(Number(f.maxSize)); }

  if (f.year && f.month) {
    where.push('taken_at >= ? AND taken_at < ?');
    params.push(dayStart(Number(f.year), Number(f.month)), monthEnd(Number(f.year), Number(f.month)));
  } else if (f.year) {
    where.push('taken_at >= ? AND taken_at < ?');
    params.push(dayStart(Number(f.year), 1), dayStart(Number(f.year) + 1, 1));
  } else if (f.beforeTs) {
    where.push('taken_at <= ?');
    params.push(Number(f.beforeTs));
  }
  if (f.afterTs) { where.push('taken_at >= ?'); params.push(Number(f.afterTs)); }

  return { sql: where.join(' AND '), params };
}

const SORT_COLUMNS = {
  taken: 'taken_at',
  created: 'ctime',
  modified: 'mtime',
  name: 'name COLLATE NOCASE',
  size: 'size'
};

function queryPhotos(filter, offset, limit) {
  const d = open();
  const f = buildFilter(filter || {});
  const col = SORT_COLUMNS[filter && filter.sort] || SORT_COLUMNS.taken;
  const dir = filter && String(filter.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sql = `SELECT * FROM photos WHERE ${f.sql} ORDER BY ${col} ${dir}, id ${dir} LIMIT ? OFFSET ?`;
  const rows = d.prepare(sql).all(...f.params, Number(limit) || 200, Number(offset) || 0);
  return rows.map(toItem);
}

function countPhotos(filter) {
  const f = buildFilter(filter || {});
  const row = open().prepare(`SELECT COUNT(*) AS c FROM photos WHERE ${f.sql}`).get(...f.params);
  return row ? Number(row.c) : 0;
}

function getPhoto(id) {
  const row = open().prepare('SELECT * FROM photos WHERE id = ?').get(Number(id));
  return row ? toItem(row) : null;
}

function getPhotoRow(id) {
  return open().prepare('SELECT * FROM photos WHERE id = ?').get(Number(id)) || null;
}

function toItem(r) {
  const ext = String(r.ext || '').replace('.', '').toUpperCase();
  return {
    id: Number(r.id),
    path: r.path,
    folderId: Number(r.folder_id),
    name: r.name,
    ext,
    size: Number(r.size),
    mtime: Number(r.mtime),
    ctime: Number(r.ctime),
    takenAt: Number(r.taken_at),
    takenSrc: r.taken_src,
    kind: r.kind === 'video' ? 'video' : 'photo',
    duration: r.duration == null ? null : Number(r.duration),
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    favorite: !!r.favorite
  };
}

function timeline() {
  const rows = open().prepare(`
    SELECT CAST(strftime('%Y', taken_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS y,
           CAST(strftime('%m', taken_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS m,
           COUNT(*) AS c
    FROM photos
    WHERE broken = 0
    GROUP BY y, m
    ORDER BY y DESC, m DESC
  `).all();
  const years = [];
  let current = null;
  for (const r of rows) {
    if (!r.y || !r.m) continue;
    if (!current || current.year !== Number(r.y)) {
      current = { year: Number(r.y), count: 0, months: [] };
      years.push(current);
    }
    current.months.push({ month: Number(r.m), count: Number(r.c) });
    current.count += Number(r.c);
  }
  return years;
}

function stats() {
  const d = open();
  const total = d.prepare('SELECT COUNT(*) AS c FROM photos WHERE broken = 0').get();
  const fav = d.prepare('SELECT COUNT(*) AS c FROM photos WHERE favorite = 1 AND broken = 0').get();
  const bytes = d.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM photos WHERE broken = 0').get();
  const exts = d.prepare('SELECT ext, COUNT(*) AS c FROM photos WHERE broken = 0 GROUP BY ext ORDER BY c DESC').all();
  const kinds = d.prepare("SELECT kind, COUNT(*) AS c FROM photos WHERE broken = 0 GROUP BY kind").all();
  const byKind = { photo: 0, video: 0 };
  for (const k of kinds) {
    const key = k.kind === 'video' ? 'video' : 'photo';
    byKind[key] += Number(k.c);
  }
  const gif = d.prepare("SELECT COUNT(*) AS c FROM photos WHERE broken = 0 AND kind = 'photo' AND lower(ext) IN ('.gif', '.apng')").get();
  return {
    total: Number(total.c),
    photos: byKind.photo,
    videos: byKind.video,
    gifs: Number(gif.c),
    favorites: Number(fav.c),
    bytes: Number(bytes.s),
    formats: exts.map((e) => ({ ext: String(e.ext).replace('.', '').toUpperCase(), count: Number(e.c) }))
  };
}

/** 视频时长等在播放器里量出来后回写 */
function setMediaMeta(id, meta) {
  const d = open();
  if (meta && Number.isFinite(meta.duration) && meta.duration > 0) {
    d.prepare('UPDATE photos SET duration = ? WHERE id = ?').run(Math.round(meta.duration), Number(id));
  }
  if (meta && meta.width > 0 && meta.height > 0) {
    d.prepare('UPDATE photos SET width = ?, height = ? WHERE id = ?').run(Math.round(meta.width), Math.round(meta.height), Number(id));
  }
  return getPhoto(id);
}

function allPaths() {
  return new Set(open().prepare('SELECT path FROM photos').all().map((r) => r.path));
}

function allRowsMap() {
  const map = new Map();
  for (const row of open().prepare('SELECT * FROM photos').all()) map.set(row.path, row);
  return map;
}

function updateDimensions(rows) {
  if (!rows.length) return 0;
  const d = open();
  const stmt = d.prepare('UPDATE photos SET width = ?, height = ? WHERE path = ?');
  d.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(r.width, r.height, r.path);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

function close() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}

module.exports = {
  open, close, listFolders, listFoldersWithCounts, addFolder, removeFolder, touchFolder,
  listAlbums, createAlbum, updateAlbum, deleteAlbum, addToAlbum, removeFromAlbum, albumsForPhoto,
  upsertPhotos, pruneFolder, markBroken, deleteByIds, updateDimensions, setMediaMeta,
  queryPhotos, countPhotos, getPhoto, getPhotoRow, timeline, stats, allPaths, allRowsMap,
  SORT_COLUMNS, monthEnd, dayStart, path
};