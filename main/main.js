'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, clipboard, nativeImage, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const config = require('./config');
const db = require('./db');
const thumbs = require('./thumbs');
const scanner = require('./scanner');
const media = require('./media');

protocol.registerSchemesAsPrivileged([
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  { scheme: 'photo', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  { scheme: 'preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  { scheme: 'video', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  { scheme: 'probe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

/** 浏览器本身能直接渲染的格式；缩略图失败时可以直接回退到原文件 */
const WEB_RENDERABLE = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif', '.jif', '.png', '.apng', '.gif',
  '.webp', '.avif', '.bmp', '.svg', '.ico'
]);

let mainWindow = null;
let splashPending = false;
let scanRunning = false;
let cacheBusy = false;

function applyWindowTheme(theme) {
  if (!mainWindow) return false;
  const light = theme === 'light';
  const bg = light ? '#ffffff' : '#000000';
  try {
    mainWindow.setBackgroundColor(bg);
    mainWindow.setTitleBarOverlay({
      color: bg,
      symbolColor: light ? '#333333' : '#d8d8d8',
      height: 52
    });
  } catch {
    /* 旧版 Windows 不支持自定义标题栏颜色时忽略 */
  }
  return true;
}

function createWindow() {
  const settings = config.load();
  const w = settings.window || {};
  const bounds = {};
  if (Number.isFinite(w.width)) bounds.width = Math.max(760, Math.round(w.width));
  if (Number.isFinite(w.height)) bounds.height = Math.max(560, Math.round(w.height));
  if (Number.isFinite(w.x) && Number.isFinite(w.y)) {
    bounds.x = Math.round(w.x);
    bounds.y = Math.round(w.y);
  }

  mainWindow = new BrowserWindow(Object.assign({
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    title: 'Album',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#000000',
      symbolColor: '#d8d8d8',
      height: 52
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  }, bounds));

  splashPending = true;
  windowShown = false;
  pendingMaximize = !!w.maximized;
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', revealWindow);
  mainWindow.webContents.once('did-finish-load', revealWindow);
  // 兜底：个别显卡/合成器环境下 ready-to-show 可能不触发
  setTimeout(revealWindow, 3000);

  mainWindow.on('close', persistWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });
}

let windowShown = false;
let pendingMaximize = false;

function revealWindow() {
  if (windowShown || !mainWindow || mainWindow.isDestroyed()) return;
  windowShown = true;
  if (pendingMaximize) mainWindow.maximize();
  mainWindow.show();
}

function persistWindowState() {
  if (!mainWindow) return;
  const settings = config.load();
  const state = Object.assign({}, settings.window);
  if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
    const b = mainWindow.getBounds();
    state.width = b.width;
    state.height = b.height;
    state.x = b.x;
    state.y = b.y;
  }
  state.maximized = mainWindow.isMaximized();
  config.setWindow(state);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function resolvePhoto(id) {
  const row = db.getPhotoRow(id);
  if (!row) return null;
  return row;
}

/* ------------------- 文件浏览器 ------------------- */

const BROWSE_SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information']);

function sameFolder(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** 枚举当前系统存在的盘符，并给出「图片」作为默认起始位置 */
function browseRoots() {
  const roots = [];
  const seen = new Set();
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const p = letter + ':\\';
    try {
      if (!fs.statSync(p).isDirectory()) continue;
      const key = fs.realpathSync(p).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ name: letter + ':', path: p });
    } catch {
      /* 盘符不存在 */
    }
  }
  let start = null;
  try {
    const pics = app.getPath('pictures');
    if (pics && fs.statSync(pics).isDirectory()) start = pics;
  } catch {
    /* 没有图片库 */
  }
  return { roots, start };
}

/** 列出某个目录下的子文件夹和可预览的照片/视频（只看当前层） */
async function browseList(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('无效路径');
  const resolved = path.resolve(input);
  const st = await fsp.stat(resolved);
  if (!st.isDirectory()) throw new Error('不是文件夹');
  const entries = await fsp.readdir(resolved, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    const full = path.join(resolved, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const s = await fsp.stat(full);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      if (entry.name.startsWith('.') || BROWSE_SKIP_DIRS.has(entry.name)) continue;
      dirs.push({ name: entry.name, path: full });
    } else if (isFile) {
      const ext = path.extname(entry.name).toLowerCase();
      const video = media.VIDEO_EXT.has(ext);
      if (!scanner.IMAGE_EXT.has(ext) && !video) continue;
      files.push({ name: entry.name, path: full, ext, kind: video ? 'video' : 'photo' });
    }
  }
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  dirs.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent && parent !== resolved ? parent : null,
    dirs: dirs.slice(0, 800),
    files: files.slice(0, 1200),
    totalDirs: dirs.length,
    totalFiles: files.length
  };
}

function registerProtocols() {
  protocol.handle('thumb', async (request) => {
    let row = null;
    try {
      const url = new URL(request.url);
      const id = Number(String(url.pathname).replace(/^\//, ''));
      row = resolvePhoto(id);
      if (!row) return new Response('not found', { status: 404 });
      // SVG 交给浏览器自己渲染，比转成位图更清晰
      if ((row.ext || '').toLowerCase() === '.svg' && fs.existsSync(row.path)) {
        return net.fetch(pathToFileURL(row.path).toString(), { bypassCustomProtocolHandlers: true });
      }
      const file = await thumbs.ensureThumb(row);
      return net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
    } catch {
      try {
        if (row && WEB_RENDERABLE.has((row.ext || '').toLowerCase()) && fs.existsSync(row.path)) {
          return net.fetch(pathToFileURL(row.path).toString(), { bypassCustomProtocolHandlers: true });
        }
      } catch {
        /* fall through */
      }
      return new Response('thumb error', { status: 500 });
    }
  });

  protocol.handle('photo', async (request) => {
    try {
      const url = new URL(request.url);
      const id = Number(String(url.pathname).replace(/^\//, ''));
      const row = resolvePhoto(id);
      if (!row || !fs.existsSync(row.path)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(row.path).toString(), { bypassCustomProtocolHandlers: true });
    } catch {
      return new Response('photo error', { status: 500 });
    }
  });

  // 浏览器无法解码的格式（HEIC / TIFF / RAW / PSD 等）用系统解码器转成 JPEG 预览
  protocol.handle('preview', async (request) => {
    try {
      const url = new URL(request.url);
      const id = Number(String(url.pathname).replace(/^\//, ''));
      const row = resolvePhoto(id);
      if (!row || !fs.existsSync(row.path)) return new Response('not found', { status: 404 });
      const file = await thumbs.ensurePreview(row);
      return net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
    } catch {
      return new Response('preview error', { status: 500 });
    }
  });

  // 视频流：支持 Range，播放器才能拖动进度条
  protocol.handle('video', async (request) => {
    try {
      const url = new URL(request.url);
      const id = Number(String(url.pathname).replace(/^\//, ''));
      const row = resolvePhoto(id);
      if (!row || !fs.existsSync(row.path)) return new Response('not found', { status: 404 });
      const stat = await fsp.stat(row.path);
      const type = media.mimeFor(row.ext);
      const range = request.headers.get('range');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m) {
          let start = m[1] ? Number(m[1]) : 0;
          let end = m[2] ? Number(m[2]) : stat.size - 1;
          if (start >= stat.size) {
            return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + stat.size } });
          }
          end = Math.min(end, stat.size - 1);
          const stream = fs.createReadStream(row.path, { start, end });
          return new Response(Readable.toWeb(stream), {
            status: 206,
            headers: {
              'Content-Type': type,
              'Content-Length': String(end - start + 1),
              'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
              'Accept-Ranges': 'bytes'
            }
          });
        }
      }
      return new Response(Readable.toWeb(fs.createReadStream(row.path)), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes'
        }
      });
    } catch {
      return new Response('video error', { status: 500 });
    }
  });

  // 添加文件夹时的浏览预览：按绝对路径临时取缩略图 / 大图，不写入索引。
  // URL 形式：probe://thumb/<base64url(path)> 或 probe://preview/<base64url(path)>
  protocol.handle('probe', async (request) => {
    try {
      const url = new URL(request.url);
      const mode = url.hostname === 'preview' ? 'preview' : 'thumb';
      const encoded = String(url.pathname).replace(/^\//, '');
      const file = Buffer.from(encoded, 'base64url').toString('utf8');
      const ext = path.extname(file).toLowerCase();
      if (!scanner.IMAGE_EXT.has(ext) && !media.VIDEO_EXT.has(ext)) {
        return new Response('unsupported', { status: 415 });
      }
      const st = await fsp.stat(file);
      if (!st.isFile()) return new Response('not found', { status: 404 });

      // 浏览器能直接解码的格式，大图直接用原文件，保留原始画质
      if (mode === 'preview' && WEB_RENDERABLE.has(ext)) {
        return net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
      }
      const row = { path: file, mtime: Math.round(st.mtimeMs), size: st.size, ext };
      try {
        const target = mode === 'preview' ? await thumbs.ensurePreview(row) : await thumbs.ensureThumb(row);
        return net.fetch(pathToFileURL(target).toString(), { bypassCustomProtocolHandlers: true });
      } catch {
        if (WEB_RENDERABLE.has(ext)) {
          return net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
        }
        return new Response('decode failed', { status: 415 });
      }
    } catch {
      return new Response('probe error', { status: 500 });
    }
  });
}

/* ------------------------- IPC ------------------------- */

ipcMain.handle('app:init', async () => {
  const settings = config.load();
  try {
    await scanner.repairDimensions();
  } catch {
    /* 修复失败不影响启动 */
  }
  const folders = db.listFoldersWithCounts();
  return {
    folders,
    albums: db.listAlbums(),
    settings: {
      sort: settings.sort,
      dir: settings.dir,
      theme: settings.theme === 'light' ? 'light' : 'dark',
      viewerInfo: settings.viewerInfo
    },
    stats: db.stats(),
    timeline: db.timeline(),
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome
    }
  };
});

ipcMain.handle('folders:list', () => db.listFoldersWithCounts());

ipcMain.handle('browse:roots', () => browseRoots());

ipcMain.handle('browse:list', (_e, dirPath) => browseList(dirPath));

ipcMain.handle('folders:add-path', async (_e, folderPath) => {
  const folders = db.listFoldersWithCounts();
  if (typeof folderPath !== 'string' || !folderPath.trim()) return { added: [], folders };
  let resolved;
  try {
    resolved = await fsp.realpath(folderPath);
  } catch {
    resolved = path.resolve(folderPath);
  }
  const st = await fsp.stat(resolved);
  if (!st.isDirectory()) throw new Error('选择的不是文件夹');
  const existing = folders.find((f) => sameFolder(f.path, resolved));
  if (existing) return { added: [], existing: true, folder: existing, folders };
  const row = db.addFolder(resolved);
  if (!row) return { added: [], folders: db.listFoldersWithCounts() };
  const settings = config.load();
  settings.folders = Array.from(new Set([...(settings.folders || []), row.path]));
  config.save();
  return { added: [row], existing: false, folder: row, folders: db.listFoldersWithCounts() };
});

ipcMain.handle('folders:add', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图片文件夹',
    properties: ['openDirectory', 'multiSelections']
  });
  if (result.canceled || !result.filePaths.length) return { added: [], folders: db.listFoldersWithCounts() };
  const added = [];
  for (const folderPath of result.filePaths) {
    const row = db.addFolder(folderPath);
    if (row) added.push(row);
  }
  const settings = config.load();
  const paths = added.map((f) => f.path);
  settings.folders = Array.from(new Set([...(settings.folders || []), ...paths]));
  config.save();
  return { added, folders: db.listFoldersWithCounts() };
});

ipcMain.handle('folders:remove', async (_e, id) => {
  const folders = db.listFolders();
  const target = folders.find((f) => Number(f.id) === Number(id));
  db.removeFolder(Number(id));
  if (target) {
    const settings = config.load();
    settings.folders = (settings.folders || []).filter((p) => p !== target.path);
    config.save();
  }
  return db.listFoldersWithCounts();
});

ipcMain.handle('photos:scan', async (_e, folderId) => {
  if (scanRunning) return { busy: true };
  scanRunning = true;
  try {
    const folders = db.listFolders();
    const targets = folderId == null ? folders : folders.filter((f) => Number(f.id) === Number(folderId));
    const results = [];
    const knownMap = db.allRowsMap ? db.allRowsMap() : null;
    for (const folder of targets) {
      try {
        results.push(await scanner.scanFolder(folder, {
          knownMap,
          emit: (ev) => send('scan:progress', ev)
        }));
      } catch (err) {
        results.push({
          folderId: folder.id,
          found: 0,
          indexed: 0,
          failed: 0,
          removed: 0,
          error: String(err && err.message ? err.message : err)
        });
      }
    }
    send('scan:progress', { phase: 'all-done', folders: targets.length });
    return { results, stats: db.stats(), timeline: db.timeline() };
  } finally {
    scanRunning = false;
  }
});

ipcMain.handle('photos:query', (_e, filter, offset, limit) => {
  return { items: db.queryPhotos(filter, offset, limit), offset: Number(offset) || 0 };
});

ipcMain.handle('photos:count', (_e, filter) => db.countPhotos(filter));
ipcMain.handle('photos:timeline', () => db.timeline());
ipcMain.handle('photos:stats', () => db.stats());
ipcMain.handle('photos:get', (_e, id) => db.getPhoto(id));
ipcMain.handle('photos:meta', (_e, id, meta) => db.setMediaMeta(id, meta || {}));

/* 相册分类 */
ipcMain.handle('albums:list', () => db.listAlbums());
ipcMain.handle('albums:create', (_e, name, coverId) => db.createAlbum(name, coverId));
ipcMain.handle('albums:update', (_e, id, patch) => db.updateAlbum(id, patch || {}));
ipcMain.handle('albums:delete', (_e, id) => {
  db.deleteAlbum(id);
  return db.listAlbums();
});
ipcMain.handle('albums:add', (_e, albumId, ids) => db.addToAlbum(albumId, ids || []));
ipcMain.handle('albums:remove', (_e, albumId, ids) => db.removeFromAlbum(albumId, ids || []));
ipcMain.handle('albums:of-photo', (_e, photoId) => db.albumsForPhoto(photoId));
ipcMain.handle('photos:broken', (_e, id) => { db.markBroken(id); return true; });

ipcMain.handle('photos:delete', async (_e, ids, deleteFile) => {
  let trashed = 0;
  const failed = [];
  for (const id of ids) {
    const row = db.getPhotoRow(id);
    if (!row) continue;
    if (deleteFile) {
      try {
        await shell.trashItem(row.path);
        trashed++;
      } catch (err) {
        failed.push({ id, path: row.path, error: String(err && err.message ? err.message : err) });
        continue;
      }
    }
  }
  const removedIds = ids.filter((id) => !failed.some((f) => f.id === id));
  db.deleteByIds(removedIds);
  return { removed: removedIds.length, trashed, failed, stats: db.stats() };
});

ipcMain.handle('shell:open', async (_e, id) => {
  const row = resolvePhoto(id);
  if (!row) return { ok: false };
  const err = await shell.openPath(row.path);
  return { ok: !err, error: err };
});

ipcMain.handle('shell:reveal', async (_e, id) => {
  const row = resolvePhoto(id);
  if (!row) return { ok: false };
  shell.showItemInFolder(row.path);
  return { ok: true };
});

ipcMain.handle('shell:copypath', (_e, id) => {
  const row = resolvePhoto(id);
  if (!row) return { ok: false };
  clipboard.writeText(row.path);
  return { ok: true, path: row.path };
});

ipcMain.handle('shell:copyimage', (_e, id) => {
  const row = resolvePhoto(id);
  if (!row) return { ok: false };
  try {
    const img = nativeImage.createFromPath(row.path);
    if (img.isEmpty()) return { ok: false };
    clipboard.writeImage(img);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('settings:save', (_e, patch) => {
  config.set(patch);
  return config.load();
});

ipcMain.handle('window:state', (_e, state) => {
  if (!mainWindow) return false;
  if (state.maximized === true && !mainWindow.isMaximized()) mainWindow.maximize();
  if (state.maximized === false && mainWindow.isMaximized()) mainWindow.unmaximize();
  return mainWindow.isMaximized();
});

ipcMain.handle('window:theme', (_e, theme) => {
  if (!mainWindow) return false;
  // 启动动画期间窗口保持纯黑，结束后再切回主题色
  if (splashPending) return true;
  return applyWindowTheme(theme);
});

ipcMain.on('splash:done', (_e, theme) => {
  splashPending = false;
  applyWindowTheme(theme);
});

ipcMain.handle('cache:info', () => thumbs.cacheInfo());
ipcMain.handle('cache:clear', () => ({ removed: thumbs.clearCache() }));

/* ---------------------- lifecycle ---------------------- */

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  db.open();
  registerProtocols();
  createWindow();

  const info = thumbs.cacheInfo();
  if (!cacheBusy && info.bytes > 2.2 * 1024 * 1024 * 1024) {
    cacheBusy = true;
    thumbs.cleanup().finally(() => { cacheBusy = false; });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  persistWindowState();
  db.close();
});