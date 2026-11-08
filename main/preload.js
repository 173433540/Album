'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('album', {
  init: () => ipcRenderer.invoke('app:init'),

  chooseFolder: () => ipcRenderer.invoke('folders:add'),
  addFolderPath: (folderPath) => ipcRenderer.invoke('folders:add-path', String(folderPath || '')),
  removeFolder: (id) => ipcRenderer.invoke('folders:remove', id),
  listFolders: () => ipcRenderer.invoke('folders:list'),
  browseRoots: () => ipcRenderer.invoke('browse:roots'),
  browseList: (dirPath) => ipcRenderer.invoke('browse:list', String(dirPath || '')),

  listAlbums: () => ipcRenderer.invoke('albums:list'),
  createAlbum: (name, coverId) => ipcRenderer.invoke('albums:create', String(name || ''), coverId == null ? null : Number(coverId)),
  updateAlbum: (id, patch) => ipcRenderer.invoke('albums:update', Number(id), patch || {}),
  deleteAlbum: (id) => ipcRenderer.invoke('albums:delete', Number(id)),
  addToAlbum: (albumId, ids) => ipcRenderer.invoke('albums:add', Number(albumId), (ids || []).map(Number)),
  removeFromAlbum: (albumId, ids) => ipcRenderer.invoke('albums:remove', Number(albumId), (ids || []).map(Number)),
  albumsForPhoto: (photoId) => ipcRenderer.invoke('albums:of-photo', Number(photoId)),

  scan: (folderId) => ipcRenderer.invoke('photos:scan', folderId == null ? null : Number(folderId)),

  query: (filter, offset, limit) => ipcRenderer.invoke('photos:query', filter || {}, Number(offset) || 0, Number(limit) || 200),
  count: (filter) => ipcRenderer.invoke('photos:count', filter || {}),
  timeline: () => ipcRenderer.invoke('photos:timeline'),
  stats: () => ipcRenderer.invoke('photos:stats'),
  getPhoto: (id) => ipcRenderer.invoke('photos:get', Number(id)),
  deletePhotos: (ids, deleteFile) => ipcRenderer.invoke('photos:delete', ids.map(Number), !!deleteFile),
  markBroken: (id) => ipcRenderer.invoke('photos:broken', Number(id)),
  setMediaMeta: (id, meta) => ipcRenderer.invoke('photos:meta', Number(id), meta || {}),

  openOriginal: (id) => ipcRenderer.invoke('shell:open', Number(id)),
  reveal: (id) => ipcRenderer.invoke('shell:reveal', Number(id)),
  copyPath: (id) => ipcRenderer.invoke('shell:copypath', Number(id)),
  copyImage: (id) => ipcRenderer.invoke('shell:copyimage', Number(id)),

  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch || {}),
  windowState: (state) => ipcRenderer.invoke('window:state', state || {}),
  windowTheme: (theme) => ipcRenderer.invoke('window:theme', theme),
  splashDone: (theme) => ipcRenderer.send('splash:done', theme),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),

  onScanProgress: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  }
});