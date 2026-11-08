'use strict';

/** 全屏视频播放器：点开视频直接播放，Esc 关闭。 */
(function () {
  const el = {};
  const state = { open: false, item: null, handlers: {} };

  function $(id) { return document.getElementById(id); }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function metaText(it) {
    if (!it) return '';
    return formatBytes(it.size) + ' · ' + (it.ext || '').toUpperCase();
  }

  function bind() {
    el.view = $('videoPlayer');
    el.video = $('vpVideo');
    el.name = $('vpName');
    el.meta = $('vpMeta');
    el.close = $('vpClose');
    el.openSys = $('vpOpenSys');
    el.err = $('vpError');

    el.close.addEventListener('click', close);
    el.openSys.addEventListener('click', () => {
      if (state.item && state.handlers.onOpenOriginal) state.handlers.onOpenOriginal(state.item);
    });
    el.video.addEventListener('error', () => {
      if (!state.open) return;
      el.err.classList.add('on');
      el.err.textContent = '这个视频的编码无法在内置播放器播放，可用系统播放器打开。';
    });
    el.video.addEventListener('playing', () => {
      el.err.classList.remove('on');
    });
  }

  function open(item) {
    if (!item) return;
    if (!el.view) bind();
    state.item = item;
    state.open = true;
    el.name.textContent = item.name;
    el.meta.textContent = metaText(item);
    el.err.classList.remove('on');
    el.view.classList.add('on');
    el.video.src = 'video://media/' + item.id;
    el.video.currentTime = 0;
    const p = el.video.play();
    if (p && p.catch) p.catch(() => { /* 用户可在控制条手动播放 */ });
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    el.view.classList.remove('on');
    try {
      el.video.pause();
      el.video.removeAttribute('src');
      el.video.load();
    } catch {
      /* ignore */
    }
    state.item = null;
  }

  window.VideoPlayer = {
    mount(handlers) {
      state.handlers = handlers || {};
      bind();
    },
    open,
    close,
    isOpen() { return state.open; },
    current() { return state.item; },
    togglePlay() {
      if (!state.open) return;
      if (el.video.paused) el.video.play().catch(() => {});
      else el.video.pause();
    }
  };
})();