'use strict';
process.env.PHOTOALBUM_DATA = 'C:/AI/PhotoAlbum/.stressdata';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const N = 20000;

app.whenReady().then(() => {
  const db = require('../main/db');
  db.open();
  const folder = db.addFolder('C:\AI\_tools\testpics');
  const rows = [];
  const base = new Date(2020, 0, 1).getTime();
  for (let i = 0; i < N; i++) {
    const t = base + Math.floor(i * (1900 * 24 * 3600 * 1000) / N);
    rows.push({
      path: 'C:\AI\_tools\testpics\fake\stress_' + i + '.jpg',
      name: 'STRESS_' + String(i).padStart(5, '0') + '.jpg',
      ext: '.jpg',
      size: 100000 + (i % 900) * 1000,
      mtime: t,
      ctime: t,
      takenAt: t,
      takenSrc: 'created',
      width: 800 + (i % 7) * 120,
      height: 600 + (i % 5) * 140
    });
  }
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i += 500) db.upsertPhotos(rows.slice(i, i + 500), folder.id);
  console.log('SEEDED', N, 'rows in', Date.now() - t0, 'ms');

  const t1 = Date.now();
  const q = db.queryPhotos({ sort: 'taken', dir: 'desc' }, 0, 300);
  console.log('QUERY300', Date.now() - t1, 'ms', 'first=' + q[0].name);
  const t2 = Date.now();
  console.log('COUNT', db.countPhotos({}), 'in', Date.now() - t2, 'ms');
  const t3 = Date.now();
  const tl = db.timeline();
  console.log('TIMELINE', tl.length, 'years in', Date.now() - t3, 'ms');
  db.open().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
