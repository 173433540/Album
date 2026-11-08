'use strict';

// 给真实 JPEG 注入 APP1/EXIF（DateTimeOriginal），用于验证「EXIF 优先于文件时间」。
const fs = require('node:fs');
const path = require('node:path');

function tiff(dateStr) {
  const buf = Buffer.alloc(128);
  let off = 0;
  buf.write('II', 0, 'latin1'); off = 2;
  buf.writeUInt16LE(0x2a, off); off += 2;
  buf.writeUInt32LE(8, off); off += 4;           // IFD0 at 8

  const ifd0 = 8;
  const dateTimeOff = 38;
  const exifIfd = 58;
  const dateOriginalOff = 76;

  buf.writeUInt16LE(2, ifd0);
  // 0x8769 Exif IFD pointer
  buf.writeUInt16LE(0x8769, ifd0 + 2);
  buf.writeUInt16LE(4, ifd0 + 4);
  buf.writeUInt32LE(1, ifd0 + 6);
  buf.writeUInt32LE(exifIfd, ifd0 + 10);
  // 0x0132 DateTime
  buf.writeUInt16LE(0x0132, ifd0 + 14);
  buf.writeUInt16LE(2, ifd0 + 16);
  buf.writeUInt32LE(20, ifd0 + 18);
  buf.writeUInt32LE(dateTimeOff, ifd0 + 22);
  buf.writeUInt32LE(0, ifd0 + 26);

  buf.write(dateStr, dateTimeOff, 'latin1');

  buf.writeUInt16LE(1, exifIfd);
  buf.writeUInt16LE(0x9003, exifIfd + 2);
  buf.writeUInt16LE(2, exifIfd + 4);
  buf.writeUInt32LE(20, exifIfd + 6);
  buf.writeUInt32LE(dateOriginalOff, exifIfd + 10);
  buf.writeUInt32LE(0, exifIfd + 14);

  buf.write(dateStr, dateOriginalOff, 'latin1');
  return buf.subarray(0, 96);
}

function inject(src, dst, dateStr) {
  const jpg = fs.readFileSync(src);
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) throw new Error('not a jpeg');
  const t = tiff(dateStr);
  const header = Buffer.from('Exif\0\0', 'latin1');
  const bodyLen = header.length + t.length;
  const app1 = Buffer.alloc(4 + bodyLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(bodyLen + 2, 2);
  header.copy(app1, 4);
  t.copy(app1, 4 + header.length);

  const out = Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
  fs.writeFileSync(dst, out);
  return out.length;
}

const src = process.argv[2];
const dst = process.argv[3];
const date = process.argv[4] || '2019:07:04 15:30:00';
if (!src || !dst) {
  console.error('usage: node make-exif.js <src.jpg> <dst.jpg> [date]');
  process.exit(1);
}
const size = inject(src, dst, date);
console.log('wrote', dst, size, 'bytes, EXIF date =', date);