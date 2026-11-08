'use strict';

/**
 * 虚拟化照片墙：行高对齐（justified）布局 + 按可视区域渲染。
 * 只挂载视口附近的行，数万张照片也能保持滚动流畅。
 */
(function () {
  const state = {
    scroller: null,
    grid: null,
    items: [],
    blocks: [],
    height: 0,
    width: 0,
    gap: 2,
    targetH: 196,
    mounted: new Map(),   // key -> element
    headerMounted: new Map(),
    overscan: 500,
    onOpen: null,
    onNeedMore: null,
    onNeedOlder: null,
    onContextMenu: null,
    onYearChange: null,
    onNeedDuration: null,
    onSelectionChange: null,
    selectMode: false,
    selected: new Set(),
    draggable: false,
    monthCounts: new Map(),
    raf: 0,
    viewportH: 0,
    lastStart: -1,
    lastEnd: -1,
    dirty: true,
    lastNotifiedKey: null,
    scrollIdle: 0,
    zoom: 1,
    zoomTarget: 1,
    zoomAnchor: null,
    zoomRaf: 0
  };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

// 00:35 / 02:35 / 15:28，超过一小时给 1:02:03
  function formatDuration(ms) {
    if (!ms || ms < 0) return '';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p = (v) => String(v).padStart(2, '0');
    return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }

  // 宽高比 / 分组键按项缓存：缩放时每帧都要重排，避免反复解析
  function aspect(item) {
    if (item._a) return item._a;
    item._a = (item.width > 0 && item.height > 0) ? clamp(item.width / item.height, 0.42, 2.7) : 1;
    return item._a;
  }

  function groupKey(item) {
    if (item._gk) return item._gk;
    const d = new Date(item.takenAt || item.mtime || Date.now());
    item._gk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    return item._gk;
  }

  function groupLabel(key) {
    const parts = key.split('-');
    return parts[0] + '年' + Number(parts[1]) + '月';
  }

  /* ---------------- layout ---------------- */

  function justifyRow(row, width, targetH, gap) {
    const n = row.length;
    const sum = row.reduce((acc, it) => acc + aspect(it), 0);

    if (row._last) {
      // 最后一行按目标高度排，不拉伸，避免两张图铺满一整行
      const h = targetH;
      let x = 0;
      return row.map((it) => {
        const w = aspect(it) * h;
        const cell = { item: it, x, y: 0, w, h };
        x += w + gap;
        return cell;
      }).slice(0, n);
    }

    let h = (width - gap * (n - 1)) / Math.max(0.01, sum);
    // 行高围绕目标高度浮动，缩放时整墙同步变大变小
    h = clamp(h, Math.max(60, targetH * 0.72), targetH * 1.35);

    let x = 0;
    return row.map((it) => {
      const w = aspect(it) * h;
      const cell = { item: it, x, y: 0, w, h };
      x += w + gap;
      return cell;
    });
  }

  function buildLayout() {
    const t0 = performance.now();
    const width = Math.max(200, state.width);
    let rowCount = 0;
    // 基础行高按窗口宽度自适应，再乘上中键滚轮的缩放系数；
    // 上限 360px 保证放大后仍然由 480px 缩略图承担，不会糊
    const base = clamp(Math.round(width / 6.4), 150, 240);
    const targetH = clamp(Math.round(base * state.zoom), 90, 360);
    state.targetH = targetH;
    const gap = state.gap;
    const blocks = [];
    let y = 0;
    let i = 0;

    while (i < state.items.length) {
      const key = groupKey(state.items[i]);
      const start = i;
      while (i < state.items.length && groupKey(state.items[i]) === key) i++;
      const count = state.monthCounts.get(key) || (i - start);

      blocks.push({ kind: 'header', key, label: groupLabel(key), count, y, h: 44 });
      y += 44;

      let cur = [];
      let sum = 0;
      const flushRow = () => {
        const cells = justifyRow(cur, width, targetH, gap);
        const rowH = cells.length ? cells[0].h : targetH;
        const blockIdx = blocks.length;
        blocks.push({ kind: 'row', y, h: rowH, cells, key });
        rowCount++;
        for (const cell of cells) cell.item._row = blockIdx;
        y += rowH + gap;
        cur = [];
        sum = 0;
      };
      for (let k = start; k < i; k++) {
        const item = state.items[k];
        cur.push(item);
        sum += aspect(item);
        if (sum * targetH + gap * (cur.length - 1) >= width) flushRow();
      }
      if (cur.length) {
        cur._last = true;
        flushRow();
      }
      y += 8;
    }

    state.blocks = blocks;
    state.height = Math.max(y + 56, state.scroller ? state.scroller.clientHeight : 0);
    state.grid.style.height = state.height + 'px';
    state.dirty = true;
    window.__gridStats = {
      items: state.items.length,
      blocks: blocks.length,
      rows: rowCount,
      zoom: +state.zoom.toFixed(3),
      zoomTarget: +state.zoomTarget.toFixed(3),
      targetH,
      layoutMs: +(performance.now() - t0).toFixed(2)
    };
  }

  /* ---------------- render ---------------- */

  function visibleRange() {
    const sc = state.scroller;
    const blocks = state.blocks;
    const top = sc.scrollTop - state.overscan;
    const bottom = sc.scrollTop + state.viewportH + state.overscan;
    let lo = 0;
    let hi = blocks.length - 1;
    let start = blocks.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].y + blocks[mid].h >= top) { start = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    let end = start;
    while (end < blocks.length && blocks[end].y <= bottom) end++;
    return [start, end];
  }

  function makeCell(item) {
    const isVideo = item.kind === 'video';
    const ext = String(item.ext || '').toLowerCase().replace('.', '');
    const animated = ext === 'gif' ? 'GIF' : (ext === 'apng' ? 'APNG' : '');
    const el = document.createElement('div');
    el.className = 'cell' + (isVideo ? ' video' : '') + (animated ? ' animated' : '');
    el.dataset.id = String(item.id);
    el.title = item.name;
    el.draggable = state.draggable;

    const img = document.createElement('img');
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    img.src = 'thumb://photo/' + item.id;
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => {
      img.remove();
      el.classList.add('broken');
      // 只放一个格式占位，保留播放三角 / 时长 / 动图标等覆盖元素
      const fmt = document.createElement('span');
      fmt.className = 'fmt';
      fmt.textContent = (item.ext || '').replace('.', '').toUpperCase() || '?';
      el.appendChild(fmt);
    }, { once: true });

    const selbox = document.createElement('span');
    selbox.className = 'selbox';

    el.appendChild(img);
    el.appendChild(selbox);

    if (isVideo) {
      // 中央白色播放三角：不加圆形底，尽量少挡画面
      const play = document.createElement('span');
      play.className = 'play';
      play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 5.4v13.2L18.6 12z"/></svg>';
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = formatDuration(item.duration);
      el.appendChild(play);
      el.appendChild(dur);
      if (!item.duration && state.onNeedDuration) state.onNeedDuration(item);
    } else if (animated) {
      // 动图标识（点击后在查看器里播放动画）
      const tag = document.createElement('span');
      tag.className = 'glabel';
      tag.textContent = animated;
      el.appendChild(tag);
    }
    el.addEventListener('click', () => {
      if (state.selectMode) {
        toggleSelected(item, el);
        return;
      }
      const index = state.items.findIndex((x) => x.id === item.id);
      if (state.onOpen && index >= 0) state.onOpen(index);
    });
    el.addEventListener('dragstart', (e) => {
      if (!state.draggable) {
        e.preventDefault();
        return;
      }
      const ids = state.selectMode && state.selected.has(item.id)
        ? Array.from(state.selected)
        : [item.id];
      e.dataTransfer.effectAllowed = 'copy';
      try {
        e.dataTransfer.setData('application/x-album-photos', JSON.stringify(ids));
        e.dataTransfer.setData('text/plain', ids.join(','));
      } catch {
        /* 某些环境不允许自定义类型 */
      }
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (state.onContextMenu) state.onContextMenu(item, e.clientX, e.clientY);
    });
    return el;
  }

  function toggleSelected(item, el) {
    if (state.selected.has(item.id)) state.selected.delete(item.id);
    else state.selected.add(item.id);
    el.classList.toggle('sel', state.selected.has(item.id));
    if (state.onSelectionChange) state.onSelectionChange(state.selected.size);
  }

  function render(force) {
    if (!state.scroller) return;
    const [start, end] = visibleRange();
    if (!force && !state.dirty && start === state.lastStart && end === state.lastEnd) return;
    state.dirty = false;
    state.lastStart = start;
    state.lastEnd = end;
    const wanted = new Set();
    const wantedHeaders = new Set();

    for (let i = start; i < end; i++) {
      const b = state.blocks[i];
      if (b.kind === 'header') {
        wantedHeaders.add(b.key);
        let el = state.headerMounted.get(b.key);
        if (!el) {
          el = document.createElement('div');
          el.className = 'row-header';
          el.innerHTML = '<span>' + b.label + '</span><span class="count">' + b.count + '</span>';
          state.grid.appendChild(el);
          state.headerMounted.set(b.key, el);
        }
        el.style.top = b.y + 'px';
        el.style.height = b.h + 'px';
        let elText = el.firstChild;
        if (elText && elText.textContent !== b.label) elText.textContent = b.label;
        const cntEl = el.querySelector('.count');
        if (cntEl && cntEl.textContent !== String(b.count)) cntEl.textContent = String(b.count);
      } else {
        for (const cell of b.cells) {
          const key = String(cell.item.id);
          wanted.add(key);
          let el = state.mounted.get(key);
          if (!el) {
            el = makeCell(cell.item);
            state.mounted.set(key, el);
            state.grid.appendChild(el);
          }
          const left = Math.round(cell.x);
          const top = Math.round(b.y);
          const w = Math.max(1, Math.round(cell.w));
          const h = Math.max(1, Math.round(cell.h));
          if (el._l !== left) { el.style.left = left + 'px'; el._l = left; }
          if (el._t !== top) { el.style.top = top + 'px'; el._t = top; }
          if (el._w !== w) { el.style.width = w + 'px'; el._w = w; }
          if (el._h !== h) { el.style.height = h + 'px'; el._h = h; }
          if (state.selectMode) el.classList.toggle('sel', state.selected.has(cell.item.id));
        }
      }
    }

    for (const [key, el] of state.mounted) {
      if (!wanted.has(key)) {
        el.remove();
        state.mounted.delete(key);
      }
    }
    for (const [key, el] of state.headerMounted) {
      if (!wantedHeaders.has(key)) {
        el.remove();
        state.headerMounted.delete(key);
      }
    }
  }

  function onScroll() {
    const sc = state.scroller;
    if (sc) {
      sc.classList.add('scrolling');
      clearTimeout(state.scrollIdle);
      state.scrollIdle = setTimeout(() => sc.classList.remove('scrolling'), 160);
    }
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      render();
      if (state.scroller.scrollTop < 700 && state.onNeedOlder) state.onNeedOlder();
      const remaining = state.height - state.scroller.scrollTop - state.viewportH;
      if (remaining < 1400 && state.onNeedMore) state.onNeedMore();
      notifyYear();
    });
  }

  function notifyYear(force) {
    if (!state.onYearChange || !state.items.length || !state.blocks.length) return;
    const target = state.scroller.scrollTop + 40;
    let lo = 0;
    let hi = state.blocks.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (state.blocks[mid].y <= target) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const current = idx >= 0 ? state.blocks[idx] : state.blocks[0];
    if (!current) return;
    const key = current.key || (current.cells && current.cells[0] ? groupKey(current.cells[0].item) : null);
    if (!key) return;
    if (!force && key === state.lastNotifiedKey) return;
    state.lastNotifiedKey = key;
    state.onYearChange(key);
  }

  /* ---------------- zoom ---------------- */

  function blockIndexAt(y) {
    const blocks = state.blocks;
    let lo = 0;
    let hi = blocks.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].y <= y) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return idx;
  }

  function captureAnchor() {
    const sc = state.scroller;
    if (!sc || !state.blocks.length) return null;
    const y = sc.scrollTop;
    let idx = blockIndexAt(y);
    if (idx < 0) idx = 0;
    // 优先取“当前仍在视口内、覆盖顶部的那一行”，避免跨月表头把锚点推到下一行
    let rowIdx = idx;
    while (rowIdx >= 0 && state.blocks[rowIdx].kind !== 'row') rowIdx--;
    if (rowIdx < 0) {
      rowIdx = idx;
      while (rowIdx < state.blocks.length && state.blocks[rowIdx].kind !== 'row') rowIdx++;
    }
    const b = state.blocks[rowIdx];
    if (!b || !b.cells.length) return { y, item: null, frac: 0 };
    return {
      item: b.cells[0].item,
      y: b.y,
      frac: b.h ? clamp((y - b.y) / b.h, 0, 1) : 0
    };
  }

  function restoreAnchor(anchor) {
    const sc = state.scroller;
    if (!sc || !anchor) return;
    const b = anchor.item && anchor.item._row != null ? state.blocks[anchor.item._row] : null;
    if (b && b.cells.some((c) => c.item === anchor.item)) {
      sc.scrollTop = Math.max(0, b.y + b.h * anchor.frac);
      return;
    }
    if (anchor.y != null) sc.scrollTop = Math.max(0, anchor.y);
  }

  function applyZoomLayout(anchor) {
    buildLayout();
    restoreAnchor(anchor || state.zoomAnchor);
    render(true);
  }

  function zoomFrame() {
    const dz = state.zoomTarget - state.zoom;
    const done = Math.abs(dz) < 0.0015;
    state.zoom = done ? state.zoomTarget : state.zoom + dz * 0.3;
    applyZoomLayout(state.zoomAnchor);
    if (done) {
      state.zoomRaf = 0;
      state.zoomAnchor = null;
    } else {
      state.zoomRaf = requestAnimationFrame(zoomFrame);
    }
  }

  function onWheel(e) {
    // 普通滚轮：正常上下滚动；Ctrl + 滚轮：缩放照片墙。
    // 同时接管 Ctrl+滚轮，避免 Electron 默认把整个界面缩放掉
    if (!e.ctrlKey) return;
    if (e.shiftKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (state.viewportH || 800) : 1;
    const delta = e.deltaY * unit;
    if (!delta) return;
    const next = clamp(state.zoomTarget * Math.exp(-delta * 0.0009), 0.55, 2);
    if (Math.abs(next - state.zoomTarget) < 0.0005) return;
    state.zoomTarget = next;
    if (!state.zoomRaf) {
      // 一次缩放过程只认一个锚点，避免行边界变化导致画面缓慢漂移
      state.zoomAnchor = captureAnchor();
      state.zoomRaf = requestAnimationFrame(zoomFrame);
    }
  }

  /* ---------------- public ---------------- */

  function onViewportChange() {
    const w = state.scroller.clientWidth;
    const h = state.scroller.clientHeight;
    const wChanged = Math.abs(w - state.width) >= 2;
    const hChanged = Math.abs(h - state.viewportH) >= 2;
    if (!wChanged && !hChanged) return;
    state.viewportH = h;
    if (wChanged) {
      state.width = w;
      buildLayout();
    }
    render();
  }

  const Grid = {
    mount(opts) {
      state.scroller = opts.scroller;
      state.grid = opts.grid;
      state.onOpen = opts.onOpen;
      state.onNeedMore = opts.onNeedMore;
      state.onNeedOlder = opts.onNeedOlder || null;
      state.onContextMenu = opts.onContextMenu;
      state.onYearChange = opts.onYearChange;
      state.onNeedDuration = opts.onNeedDuration || null;
      state.onSelectionChange = opts.onSelectionChange || null;

      state.scroller.addEventListener('scroll', onScroll, { passive: true });
      state.scroller.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('resize', onViewportChange);
      const ro = new ResizeObserver(onViewportChange);
      ro.observe(state.scroller);
      state.width = state.scroller.clientWidth;
      state.viewportH = state.scroller.clientHeight;
    },

    setMonthCounts(map) {
      state.monthCounts = map instanceof Map ? map : new Map(Object.entries(map || {}));
      buildLayout();
      render();
    },

    setItems(items, resetScroll) {
      state.items = items;
      if (resetScroll) state.scroller.scrollTop = 0;
      buildLayout();
      for (const [, el] of state.mounted) el.remove();
      state.mounted.clear();
      for (const [, el] of state.headerMounted) el.remove();
      state.headerMounted.clear();
      state.lastNotifiedKey = null;
      render(true);
      notifyYear(true);
    },

    appendItems(items) {
      if (!items.length) return;
      const prev = state.items.length;
      state.items = state.items.concat(items);
      buildLayout();
      // 只补渲染新追加的部分（其余已在可视区外，会在滚动时按需挂载）
      render();
      if (state.items.length !== prev) {
        state.scroller.dispatchEvent(new Event('scroll'));
      }
    },

    prependItems(items) {
      if (!items.length) return;
      const sc = state.scroller;
      const prevH = state.height;
      state.items = items.concat(state.items);
      buildLayout();
      // 顶部插入后整体下移，同步把滚动位置下移同样的高度，视觉上停在原来那行
      const delta = state.height - prevH;
      if (delta > 0) sc.scrollTop = sc.scrollTop + delta;
      render(true);
      sc.dispatchEvent(new Event('scroll'));
    },

    items() { return state.items; },
    total() { return state.items.length; },

    setSelectMode(on) {
      state.selectMode = !!on;
      state.selected.clear();
      if (state.grid) state.grid.classList.toggle('selecting', state.selectMode);
      for (const [, el] of state.mounted) el.classList.remove('sel');
      if (state.onSelectionChange) state.onSelectionChange(0);
    },

    isSelectMode() { return state.selectMode; },

    selectedIds() { return Array.from(state.selected); },

    setDraggable(on) {
      state.draggable = !!on;
      for (const [, el] of state.mounted) el.draggable = state.draggable;
    },

    updateItem(id, patch) {
      const item = state.items.find((x) => x.id === Number(id));
      if (item) Object.assign(item, patch);
      const el = state.mounted.get(String(id));
      if (el && patch && patch.duration != null) {
        const dur = el.querySelector('.dur');
        if (dur) dur.textContent = formatDuration(patch.duration);
      }
    },

    removeItem(id) {
      const idx = state.items.findIndex((x) => x.id === Number(id));
      if (idx < 0) return;
      state.items.splice(idx, 1);
      const el = state.mounted.get(String(id));
      if (el) { el.remove(); state.mounted.delete(String(id)); }
      buildLayout();
      render();
    },

    scrollToTop() {
      state.scroller.scrollTo({ top: 0, behavior: 'smooth' });
    },

    scrollToBottom() {
      state.scroller.scrollTo({ top: state.height, behavior: 'smooth' });
    },

    scrollToMonth(key) {
      const block = state.blocks.find((b) => b.kind === 'header' && b.key === key);
      if (!block) return false;
      const top = Math.max(0, block.y - 6);
      state.scroller.scrollTo({ top, behavior: 'smooth' });
      render();
      return true;
    },

    scrollToIndex(index) {
      let seen = 0;
      for (const b of state.blocks) {
        if (b.kind !== 'row') continue;
        for (const cell of b.cells) {
          if (seen === index) {
            state.scroller.scrollTo({ top: Math.max(0, b.y - 80), behavior: 'smooth' });
            return;
          }
          seen++;
        }
      }
    },

    itemAt(index) {
      return state.items[index] || null;
    },

    scrollTop() { return state.scroller.scrollTop; },
    viewportHeight() { return state.viewportH || state.scroller.clientHeight; },
    height() { return state.height; },
    groupKey
  };

  window.PhotoGrid = Grid;
})();