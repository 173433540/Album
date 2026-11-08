'use strict';

process.env.PHOTOALBUM_DATA = 'C:\\AI\\PhotoAlbum\\.testdata';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = 'C:\\AI\\_tools\\testpics';

app.whenReady().then(async () => {
  const db = require('../main/db');
  const scanner = require('../main/scanner');
  const thumbs = require('../main/thumbs');

  db.open();
  const folder = db.addFolder(TEST_DIR);
  console.log('folder', folder.id, folder.path);

  const events = [];
  const t0 = Date.now();
  const result = await scanner.scanFolder(folder, {
    emit: (ev) => {
      events.push(ev.phase);
      if (ev.phase === 'done') console.log('SCAN_DONE', JSON.stringify(ev));
    }
  });
  console.log('scan result', JSON.stringify(result), 'in', Date.now() - t0, 'ms');
  console.log('event phases', Array.from(new Set(events)).join(','));

  const stats = db.stats();
  console.log('STATS', JSON.stringify(stats));

  const timeline = db.timeline();
  console.log('TIMELINE', JSON.stringify(timeline));

  const first = db.queryPhotos({ sort: 'taken', dir: 'desc' }, 0, 3);
  console.log('NEWEST', first.map((p) => p.name + ' / ' + new Date(p.takenAt).toISOString().slice(0, 10) + ' / ' + p.width + 'x' + p.height).join(' | '));

  const last = db.queryPhotos({ sort: 'taken', dir: 'asc' }, 0, 3);
  console.log('OLDEST', last.map((p) => p.name + ' / ' + new Date(p.takenAt).toISOString().slice(0, 10) + ' / ' + p.takenSrc).join(' | '));

  const exifPhoto = db.queryPhotos({ q: 'EXIF_2021' }, 0, 5);
  console.log('EXIF_PHOTO', exifPhoto.length ? exifPhoto[0].name + ' taken=' + new Date(exifPhoto[0].takenAt).toISOString() + ' src=' + exifPhoto[0].takenSrc : 'missing');

  const countAll = db.countPhotos({});
  const count2025 = db.countPhotos({ year: 2025 });
  const countMonth = db.countPhotos({ year: 2025, month: 8 });
  const countBig = db.countPhotos({ minSize: 100 * 1024 });
  console.log('COUNTS all=' + countAll + ' y2025=' + count2025 + ' 2025-08=' + countMonth + ' min100k=' + countBig);

  // thumbnails
  let ok = 0;
  for (const item of db.queryPhotos({}, 0, 6)) {
    const row = db.getPhotoRow(item.id);
    try {
      const file = await thumbs.ensureThumb(row);
      ok++;
      if (ok === 1) console.log('THUMB', file, fs.statSync(file).size, 'bytes');
    } catch (e) {
      console.log('THUMB_FAIL', item.name, e.message);
    }
  }
  console.log('THUMBS_OK', ok, '/6', 'cache=', JSON.stringify(thumbs.cacheInfo()));

  // rescan should hit the "unchanged" fast path
  const t1 = Date.now();
  const again = await scanner.scanFolder(folder);
  console.log('RESCAN', JSON.stringify(again), 'in', Date.now() - t1, 'ms');

  db.close();
  app.quit();
}).catch((err) => {
  console.error('TEST_ERROR', err && err.stack ? err.stack : err);
  app.quit();
});