'use strict';

/** 视频扩展名（数组给 SQL 用，Set 给扫描用） */
const VIDEO_EXTS = [
  // 常见容器
  '.mp4', '.m4v', '.mov', '.qt', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.f4v',
  // MPEG 家族
  '.mpg', '.mpeg', '.mpe', '.mpv', '.m1v', '.m2v', '.m2p', '.m2t', '.m2ts', '.mts', '.ts', '.tp', '.trp',
  // 移动设备
  '.3gp', '.3g2', '.3gpp', '.3gpp2',
  // Ogg / Real / ASF
  '.ogv', '.ogm', '.rm', '.rmvb', '.rv', '.asf', '.vob',
  // 其他容器与原始码流
  '.divx', '.xvid', '.mxf', '.dv', '.wtv', '.mod', '.tod', '.svi',
  '.h264', '.264', '.h265', '.265', '.ivf', '.mjpg', '.mjpeg'
];

const VIDEO_EXT = new Set(VIDEO_EXTS);

/** 播放器能直接打开的 MIME，缺省按 mp4 处理 */
const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.qt': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogm': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.asf': 'video/x-ms-asf',
  '.flv': 'video/x-flv',
  '.f4v': 'video/mp4',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mpe': 'video/mpeg',
  '.mpv': 'video/mpeg',
  '.m1v': 'video/mpeg',
  '.m2v': 'video/mpeg',
  '.m2p': 'video/mpeg',
  '.mod': 'video/mpeg',
  '.tod': 'video/mpeg',
  '.m2t': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.ts': 'video/mp2t',
  '.tp': 'video/mp2t',
  '.trp': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.3gpp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.3gpp2': 'video/3gpp2',
  '.rm': 'video/vnd.rn-realvideo',
  '.rmvb': 'video/vnd.rn-realvideo',
  '.rv': 'video/vnd.rn-realvideo',
  '.mxf': 'application/mxf',
  '.dv': 'video/dv',
  '.wtv': 'video/x-ms-wtv',
  '.svi': 'video/x-svi',
  '.divx': 'video/divx',
  '.xvid': 'video/x-msvideo',
  '.vob': 'video/mpeg',
  '.h264': 'video/avc',
  '.264': 'video/avc',
  '.h265': 'video/hevc',
  '.265': 'video/hevc',
  '.ivf': 'video/x-ivf',
  '.mjpg': 'video/x-motion-jpeg',
  '.mjpeg': 'video/x-motion-jpeg'
};

function isVideoExt(ext) {
  return VIDEO_EXT.has(String(ext || '').toLowerCase());
}

function mimeFor(ext) {
  return VIDEO_MIME[String(ext || '').toLowerCase()] || 'video/mp4';
}

module.exports = { VIDEO_EXTS, VIDEO_EXT, VIDEO_MIME, isVideoExt, mimeFor };