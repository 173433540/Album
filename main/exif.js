'use strict';

const fs = require('node:fs');

const HEAD_BYTES = 256 * 1024;

function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes || HEAD_BYTES, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseExifDate(str) {
  if (!str) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6]));
  const t = dt.getTime();
  return Number.isFinite(t) ? t : null;
}

function readString(buf, start, count) {
  const raw = buf.subarray(start, start + count);
  const end = raw.indexOf(0);
  return (end >= 0 ? raw.subarray(0, end) : raw).toString('latin1').trim();
}

function parseTiff(buf, start, out) {
  if (buf.length < start + 8) return;
  const order = buf.toString('latin1', start, start + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return;

  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  const ifd0 = start + u32(start + 4);
  if (ifd0 + 2 > buf.length) return;

  function readIfd(offset, visit) {
    if (offset + 2 > buf.length) return 0;
    const count = u16(offset);
    let exifPtr = 0;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > buf.length) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const num = u32(entry + 4);
      const valueOffset = entry + 8;
      visit(tag, type, num, valueOffset);
      if (tag === 0x8769 && type === 4) exifPtr = u32(valueOffset);
    }
    return exifPtr;
  }

  let dateTime = null;
  const exifPtr = readIfd(ifd0, (tag, type, num, valueOffset) => {
    if (tag === 0x0132 && type === 2) {
      const ptr = num > 4 ? start + u32(valueOffset) : valueOffset;
      dateTime = readString(buf, ptr, 19);
    }
    if ((tag === 0x0100 || tag === 0x0101) && (type === 3 || type === 4)) {
      const v = type === 3 ? u16(valueOffset) : u32(valueOffset);
      if (tag === 0x0100) out.width = v;
      else out.height = v;
    }
  });

  if (exifPtr) {
    readIfd(start + exifPtr, (tag, type, num, valueOffset) => {
      if (tag === 0x9003 && type === 2) {
        const ptr = num > 4 ? start + u32(valueOffset) : valueOffset;
        const s = readString(buf, ptr, 19);
        if (s) out.exifDate = s;
      } else if (tag === 0x9004 && type === 2 && !out.exifDate) {
        const ptr = num > 4 ? start + u32(valueOffset) : valueOffset;
        const s = readString(buf, ptr, 19);
        if (s) out.exifDate = s;
      } else if (tag === 0xa002 && type === 4) {
        out.width = Math.max(out.width || 0, u32(valueOffset));
      } else if (tag === 0xa003 && type === 4) {
        out.height = Math.max(out.height || 0, u32(valueOffset));
      }
    });
  }

  if (!out.exifDate && dateTime) out.exifDate = dateTime;
}

function jpegInfo(buf, out) {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    if (marker === 0xda) break;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) break;
    if (marker === 0xe1 && len > 8) {
      const seg = off + 4;
      if (buf.toString('latin1', seg, seg + 6) === 'Exif\0\0') parseTiff(buf, seg + 6, out);
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      out.height = buf.readUInt16BE(off + 5);
      out.width = buf.readUInt16BE(off + 7);
      break;
    }
    off += 2 + len;
  }
}

function pngInfo(buf, out) {
  if (buf.length >= 24) {
    out.width = buf.readUInt32BE(16);
    out.height = buf.readUInt32BE(20);
  }
}

function gifInfo(buf, out) {
  if (buf.length >= 10) {
    out.width = buf.readUInt16LE(6);
    out.height = buf.readUInt16LE(8);
  }
}

function bmpInfo(buf, out) {
  if (buf.length >= 26) {
    out.width = Math.abs(buf.readInt32LE(18));
    out.height = Math.abs(buf.readInt32LE(22));
  }
}

function webpInfo(buf, out) {
  if (buf.length < 30) return;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    out.width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    out.height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
  } else if (chunk === 'VP8 ') {
    out.width = buf.readUInt16LE(26) & 0x3fff;
    out.height = buf.readUInt16LE(28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    out.width = 1 + (((b1 & 0x3f) << 8) | b0);
    out.height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
  }
}

function tiffInfo(buf, out) {
  parseTiff(buf, 0, out);
}

function heifInfo(buf, out) {
  let i = 0;
  let best = 0;
  while ((i = buf.indexOf('ispe', i, 'latin1')) !== -1) {
    const p = i + 8;
    if (p + 8 <= buf.length) {
      const w = buf.readUInt32BE(p);
      const h = buf.readUInt32BE(p + 4);
      if (w > 0 && h > 0 && w * h > best) {
        best = w * h;
        out.width = w;
        out.height = h;
      }
    }
    i += 4;
  }
}

function svgInfo(buf, out) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 8192));
  const w = /\bwidth\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i.exec(head);
  const h = /\bheight\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i.exec(head);
  if (w && h) {
    out.width = Math.round(parseFloat(w[1]));
    out.height = Math.round(parseFloat(h[1]));
    return;
  }
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
  if (vb) {
    out.width = Math.round(parseFloat(vb[1]));
    out.height = Math.round(parseFloat(vb[2]));
  }
}

function icoInfo(buf, out) {
  if (buf.length >= 22 && buf.readUInt16LE(2) === 1) {
    const count = buf.readUInt16LE(4);
    let best = 0;
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16;
      if (off + 2 > buf.length) break;
      const w = buf[off] || 256;
      const h = buf[off + 1] || 256;
      if (w * h > best) {
        best = w * h;
        out.width = w;
        out.height = h;
      }
    }
  }
}

function psdInfo(buf, out) {
  if (buf.length >= 26 && buf.toString('latin1', 0, 4) === '8BPS') {
    out.height = buf.readUInt32BE(14);
    out.width = buf.readUInt32BE(18);
  }
}

function sniffFormat(buf, ext) {
  const b = buf;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 6 && b.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 4 && (b.toString('latin1', 0, 4) === 'II*\0' || b.toString('latin1', 0, 4) === 'MM\0*')) return 'tiff';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return 'heif';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === '8BPS') return 'psd';
  if (b.length >= 4 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1) return 'ico';
  const head = b.toString('utf8', 0, Math.min(b.length, 512)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && /<svg[\s>]/i.test(head))) return 'svg';

  // 识别不出来时退回扩展名
  const e = (ext || '').toLowerCase();
  if (e === '.jpg' || e === '.jpeg' || e === '.jpe' || e === '.jfif' || e === '.jif') return 'jpeg';
  if (e === '.png' || e === '.apng') return 'png';
  if (e === '.gif') return 'gif';
  if (e === '.bmp' || e === '.dib') return 'bmp';
  if (e === '.webp') return 'webp';
  if (e === '.tif' || e === '.tiff' || e === '.dng') return 'tiff';
  if (e === '.heic' || e === '.heif' || e === '.hif' || e === '.avif' || e === '.jxl') return 'heif';
  if (e === '.svg') return 'svg';
  if (e === '.ico' || e === '.cur') return 'ico';
  if (e === '.psd') return 'psd';
  return '';
}

function readImageInfo(file, ext) {
  const out = { width: null, height: null, exifDate: null };
  const buf = readHead(file);
  if (!buf || buf.length < 12) return out;
  // 文件真实内容优先：有些图被改了扩展名（.png 里其实是 JPEG），
  // 只按扩展名解析会得出离谱的宽高，照片墙比例就会错乱
  const format = sniffFormat(buf, ext);
  try {
    if (format === 'jpeg') jpegInfo(buf, out);
    else if (format === 'png') pngInfo(buf, out);
    else if (format === 'gif') gifInfo(buf, out);
    else if (format === 'bmp') bmpInfo(buf, out);
    else if (format === 'webp') webpInfo(buf, out);
    else if (format === 'tiff') tiffInfo(buf, out);
    else if (format === 'heif') heifInfo(buf, out);
    else if (format === 'svg') svgInfo(buf, out);
    else if (format === 'ico') icoInfo(buf, out);
    else if (format === 'psd') psdInfo(buf, out);
  } catch {
    /* keep whatever was parsed */
  }
  return out;
}

module.exports = { readImageInfo, parseExifDate };