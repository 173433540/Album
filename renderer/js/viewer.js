'use strict';

/** 全屏沉浸式查看器：缩放、拖动、切换、信息栏、自动隐藏工具栏。 */
(function () {
  const el = {};
  const state = {
    open: false,
    index: 0,
    scale: 1,
    tx: 0,
    ty: 0,
    baseW: 0,
    baseH: 0,
    dragging: false,
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0,
    idleTimer: 0,
    token: 0,
    showDetails: false,
    handlers: {}
  };

  const MAX_SCALE = 8;

  function $(id) { return document.getElementById(id); }

  function items() { return window.PhotoGrid.items(); }

  function item() { return items()[state.index] || null; }

  function isPhoto(it) { return !!it && it.kind !== 'video'; }

  function nearestPhotoIndex(index, dir) {
    const list = items();
    if (!list.length) return -1;
    const start = Math.max(0, Math.min(list.length - 1, index));
    if (isPhoto(list[start])) return start;
    const stepDir = dir >= 0 ? 1 : -1;
    for (let i = start; i >= 0 && i < list.length; i += stepDir) if (isPhoto(list[i])) return i;
    for (let i = start; i >= 0 && i < list.length; i -= stepDir) if (isPhoto(list[i])) return i;
    return -1;
  }

  function photoPosition() {
    const list = items();
    let pos = 0;
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      if (!isPhoto(list[i])) continue;
      total++;
      if (i <= state.index) pos++;
    }
    return { pos, total };
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function formatDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (v) => String(v).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function applyTransform(animate) {
    const img = el.img;
    if (!img) return;
    img.style.transition = animate ? 'transform 0.18s ease-out' : 'none';
    img.style.transform = 'translate3d(' + state.tx + 'px,' + state.ty + 'px,0) scale(' + state.scale + ')';
    el.viewer.classList.toggle('scaled', state.scale > 1.02);
    el.zoom.textContent = Math.round(state.scale * 100) + '%';
  }

  function fitToView(nw, nh) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const base = Math.min(vw / nw, vh / nh, 1);
    state.baseW = Math.max(1, Math.round(nw * base));
    state.baseH = Math.max(1, Math.round(nh * base));
    el.img.style.width = state.baseW + 'px';
    el.img.style.height = state.baseH + 'px';
  }

  function resetZoom() {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    applyTransform(false);
  }

  function renderMeta() {
    const it = item();
    if (!it) return;
    const pos = photoPosition();
    el.name.textContent = it.name;
    const dim = it.width && it.height ? it.width + ' × ' + it.height : '—';
    el.meta.textContent = dim + ' · ' + formatBytes(it.size) + ' · ' + (it.ext || '');
    el.infoLine.innerHTML = '<span>时间 <b>' + formatDate(it.takenAt) + '</b></span>'
      + '<span>大小 <b>' + formatBytes(it.size) + '</b></span>'
      + '<span>分辨率 <b>' + dim + '</b></span>'
      + (state.showDetails ? '<span>路径 <b style="font-weight:400">' + escapeHtml(it.path) + '</b></span>' : '');
    el.bar.style.width = Math.min(100, (pos.pos / Math.max(1, pos.total)) * 100) + '%';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function setImage(it, animate) {
    const myToken = ++state.token;
    const img = el.img;
    const sources = [
      { url: 'photo://photo/' + it.id, note: '' },
      { url: 'preview://photo/' + it.id, note: '预览图' },
      { url: 'thumb://photo/' + it.id, note: '缩略预览' }
    ];

    if (animate && img.classList.contains('ready')) {
      img.classList.remove('ready');
      img.classList.add('swapping');
      setTimeout(() => { if (myToken === state.token) load(); }, 90);
    } else {
      load();
    }

    function load() {
      img.classList.remove('swapping');
      let attempt = 0;
      let note = '';
      img.onload = () => {
        if (myToken !== state.token) return;
        const nw = img.naturalWidth || 1;
        const nh = img.naturalHeight || 1;
        fitToView(nw, nh);
        resetZoom();
        img.classList.add('ready');
        if (note) el.meta.textContent = note + ' · ' + (it.ext || '').replace('.', '').toUpperCase();
      };
      img.onerror = () => {
        if (myToken !== state.token) return;
        attempt++;
        if (attempt < sources.length) {
          note = sources[attempt].note;
          if (attempt === 1) el.meta.textContent = '正在生成预览…';
          img.src = sources[attempt].url;
          return;
        }
        img.classList.remove('ready');
        el.meta.textContent = '无法解码 · ' + (it.ext || '').toUpperCase() + ' · 按 Enter 用系统看图器打开';
      };
      img.src = sources[0].url;
    }

    // 预加载相邻图片，切换时不出现白屏（跳过视频，视频在播放器里打开）
    for (const offset of [1, -1]) {
      const next = nearestPhotoIndex(state.index + offset, offset);
      if (next >= 0 && next !== state.index) {
        const pre = new Image();
        pre.onerror = () => { pre.onerror = null; pre.src = 'preview://photo/' + items()[next].id; };
        pre.src = 'photo://photo/' + items()[next].id;
      }
    }
  }

  function show(index, animate) {
    const list = items();
    if (!list.length) return;
    const target = nearestPhotoIndex(index, 1);
    if (target < 0) { close(); return; }
    state.index = target;
    const it = list[state.index];
    if (!it) return;
    el.viewer.classList.add('on');
    el.stage.style.cursor = '';
    renderMeta();
    setImage(it, animate !== false);
    resetIdle();
  }

  function resetIdle() {
    el.viewer.classList.remove('idle');
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (!state.dragging && state.open) el.viewer.classList.add('idle');
    }, 2400);
  }

  function close() {
    state.open = false;
    el.viewer.classList.remove('on');
    el.viewer.classList.remove('idle');
    clearTimeout(state.idleTimer);
    if (state.handlers.onClose) state.handlers.onClose();
  }

  async function step(delta) {
    const dir = delta >= 0 ? 1 : -1;
    let next = state.index + dir;
    let list = items();
    while (next >= 0 && next < list.length && !isPhoto(list[next])) next += dir;
    if (next < 0 || next >= list.length) {
      if (state.handlers.onNeedMore && dir > 0) {
        const grown = await state.handlers.onNeedMore();
        if (grown) {
          list = items();
          next = state.index + dir;
          while (next >= 0 && next < list.length && !isPhoto(list[next])) next += dir;
        }
      }
      if (next < 0 || next >= items().length) return;
    }
    show(next, true);
  }

  function zoomAt(clientX, clientY, factor, animate) {
    const next = Math.min(MAX_SCALE, Math.max(1, state.scale * factor));
    if (Math.abs(next - state.scale) < 0.001) return;
    const rect = el.stage.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const mx = clientX - rect.left - cx;
    const my = clientY - rect.top - cy;
    const ratio = next / state.scale;
    state.tx = mx - (mx - state.tx) * ratio;
    state.ty = my - (my - state.ty) * ratio;
    state.scale = next;
    clampPan();
    applyTransform(animate);
  }

  function clampPan() {
    if (state.scale <= 1.001) {
      state.tx = 0;
      state.ty = 0;
      return;
    }
    const maxX = (state.baseW * state.scale - state.baseW) / 2 + 120;
    const maxY = (state.baseH * state.scale - state.baseH) / 2 + 120;
    state.tx = Math.max(-maxX, Math.min(maxX, state.tx));
    state.ty = Math.max(-maxY, Math.min(maxY, state.ty));
  }

  function toggleZoom() {
    if (state.scale > 1.02) {
      state.scale = 1;
      state.tx = 0;
      state.ty = 0;
      applyTransform(true);
    } else {
      state.scale = 2.4;
      state.tx = 0;
      state.ty = 0;
      applyTransform(true);
    }
  }

  function bind() {
    el.viewer = $('viewer');
    el.stage = $('stage');
    el.img = $('vImage');
    el.name = $('vName');
    el.meta = $('vMeta');
    el.infoLine = $('vInfoLine');
    el.bar = $('vBar');
    el.zoom = $('vZoom');

    $('vClose').addEventListener('click', close);
    $('vPrev').addEventListener('click', () => step(-1));
    $('vNext').addEventListener('click', () => step(1));
    $('vOpen').addEventListener('click', () => {
      const it = item();
      if (it && state.handlers.onOpenOriginal) state.handlers.onOpenOriginal(it);
    });
    $('vDelete').addEventListener('click', () => {
      const it = item();
      if (it && state.handlers.onDelete) state.handlers.onDelete(it);
    });
    $('vAlbum').addEventListener('click', () => {
      const it = item();
      if (it && state.handlers.onAddAlbum) state.handlers.onAddAlbum(it);
    });
    $('vInfo').addEventListener('click', () => {
      state.showDetails = !state.showDetails;
      renderMeta();
    });

    el.viewer.addEventListener('mousemove', (e) => {
      resetIdle();
      if (state.dragging) {
        state.tx = state.startTx + (e.clientX - state.startX);
        state.ty = state.startTy + (e.clientY - state.startY);
        clampPan();
        applyTransform(false);
      }
    });

    el.stage.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      state.dragging = true;
      state.startX = e.clientX;
      state.startY = e.clientY;
      state.startTx = state.tx;
      state.startTy = state.ty;
      el.stage.classList.add('dragging');
      resetIdle();
    });

    window.addEventListener('mouseup', () => {
      state.dragging = false;
      el.stage.classList.remove('dragging');
    });

    el.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0016);
      zoomAt(e.clientX, e.clientY, factor, false);
    }, { passive: false });

    el.stage.addEventListener('dblclick', (e) => {
      e.preventDefault();
      toggleZoom();
    });

    el.img.addEventListener('dragstart', (e) => e.preventDefault());
  }

  window.PhotoViewer = {
    mount(handlers) {
      state.handlers = handlers || {};
      bind();
    },

    open(index) {
      state.open = true;
      state.showDetails = false;
      show(index, false);
      el.viewer.classList.remove('idle');
    },

    close,

    isOpen() { return state.open && el.viewer.classList.contains('on'); },

    next() { return step(1); },
    prev() { return step(-1); },
    index() { return state.index; },
    current() { return item(); },

    /** 分类或信息在外部变更后同步界面 */
    refresh() {
      const list = items();
      if (!list.length) { close(); return; }
      if (state.index >= list.length) state.index = list.length - 1;
      renderMeta();
    },

    /** 删除后显示相邻照片 */
    afterRemove(index) {
      const list = items();
      if (!list.length) { close(); return; }
      state.index = Math.min(index, list.length - 1);
      show(state.index, true);
    },

    handleResize() {
      const it = item();
      if (!it || !el.img.classList.contains('ready')) return;
      const nw = el.img.naturalWidth || 1;
      const nh = el.img.naturalHeight || 1;
      fitToView(nw, nh);
      clampPan();
      applyTransform(false);
    }
  };
})();