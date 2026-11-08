'use strict';

(function () {
  const api = window.album;
  const PAGE = 300;

  const state = {
    filter: { sort: 'taken', dir: 'desc', media: '', albumId: null },
    jump: null,
    items: [],
    offset: 0,
    total: 0,
    loading: false,
    loadingOlder: false,
    suppressOlder: false,
    hasMore: true,
    folders: [],
    albums: [],
    timeline: [],
    stats: null,
    settings: {},
    currentKey: null,
    lastYear: null,
    scan: false,
    menuTargetId: null,
    theme: 'dark'
  };

  const $ = (id) => document.getElementById(id);

  /* ---------------- helpers ---------------- */

  function formatCount(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }

  function monthStartMs(year, month) {
    return new Date(year, month - 1, 1, 0, 0, 0, 0).getTime();
  }

  function toast(text, ms) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('on'), ms || 1800);
  }

  function debounce(fn, ms) {
    let timer = 0;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /* ---------------- data ---------------- */

  function buildFilter() {
    return Object.assign({}, state.filter);
  }

  async function refreshTimeline() {
    state.timeline = await api.timeline();
    const counts = new Map();
    for (const y of state.timeline) {
      for (const m of y.months) {
        counts.set(y.year + '-' + String(m.month).padStart(2, '0'), m.count);
      }
    }
    window.PhotoGrid.setMonthCounts(counts);
    renderTimeline();
    renderYearSelect();
  }

  async function reload({ keepScroll } = {}) {
    if (state.loading) return;
    const t0 = performance.now();
    state.loading = true;
    state.items = [];
    state.hasMore = true;
    try {
      const filter = buildFilter();
      let offset = 0;
      if (state.jump) {
        // 倒序排列时，目标月份前面的项目就是“拍摄时间晚于这个月”的那些
        const nextMonth = monthStartMs(state.jump.year, state.jump.month + 1);
        const newer = await api.count(Object.assign({}, filter, { afterTs: nextMonth }));
        // 目标月份往前留一段缓冲，定位后仍能向上滚到更新的照片
        offset = Math.max(0, newer - Math.round(PAGE * 0.4));
      }
      state.offset = offset;
      const tq = performance.now();
      const [batch, total] = await Promise.all([
        api.query(filter, offset, PAGE),
        api.count(filter)
      ]);
      const queryMs = performance.now() - tq;
      state.total = total;
      state.items = batch.items;
      state.hasMore = state.offset + state.items.length < state.total;
      const tr = performance.now();
      window.PhotoGrid.setItems(state.items, !keepScroll);
      if (state.jump) {
        const key = state.jump.year + '-' + String(state.jump.month).padStart(2, '0');
        // 平滑滚动经过顶部时不要误触发“向上加载更新照片”，否则会一次性把前面全拉下来
        state.suppressOlder = true;
        setTimeout(() => { state.suppressOlder = false; }, 1000);
        requestAnimationFrame(() => window.PhotoGrid.scrollToMonth(key));
      }
      const renderMs = performance.now() - tr;
      window.__albumStats = { queryMs, renderMs, reloadMs: performance.now() - t0, total };
      updateSubLabel();
      updateEmpty();
      if (state.hasMore) preloadMore();
    } finally {
      state.loading = false;
      updateLoading();
    }
  }

  async function loadMore() {
    if (state.loading || !state.hasMore) return false;
    state.loading = true;
    updateLoading();
    try {
      const batch = await api.query(buildFilter(), state.offset + state.items.length, PAGE);
      if (!batch.items.length) {
        state.hasMore = false;
        return false;
      }
      state.items = state.items.concat(batch.items);
      window.PhotoGrid.appendItems(batch.items);
      state.hasMore = state.offset + state.items.length < state.total;
      updateSubLabel();
      return true;
    } finally {
      state.loading = false;
      updateLoading();
    }
  }

  async function loadOlder() {
    if (state.suppressOlder || state.loading || state.loadingOlder || state.offset <= 0) return false;
    state.loadingOlder = true;
    try {
      const take = Math.min(PAGE, state.offset);
      const start = state.offset - take;
      const batch = await api.query(buildFilter(), start, take);
      if (!batch.items.length) {
        state.offset = 0;
        return false;
      }
      state.items = batch.items.concat(state.items);
      state.offset = start;
      window.PhotoGrid.prependItems(batch.items);
      return true;
    } finally {
      state.loadingOlder = false;
    }
  }

  function preloadMore() {
    if (state.hasMore && !state.loading) {
      loadMore();
    }
  }

  function updateLoading() {
    const box = $('loading');
    box.classList.toggle('hidden', !(state.loading && state.items.length > 0));
  }

  function updateSubLabel() {
    const parts = [];
    const n = state.total !== undefined && state.items.length >= state.total ? state.total : Math.max(state.total, state.items.length);
    const folder = state.filter.folderId
      ? state.folders.find((f) => Number(f.id) === Number(state.filter.folderId))
      : null;
    const album = state.filter.albumId
      ? state.albums.find((a) => Number(a.id) === Number(state.filter.albumId))
      : null;
    const videos = folder ? Number(folder.videos) || 0 : (state.stats ? Number(state.stats.videos) || 0 : 0);
    const photos = folder
      ? Math.max(0, (Number(folder.total) || 0) - (Number(folder.videos) || 0))
      : (state.stats ? Number(state.stats.photos) || 0 : 0);
    if (folder) parts.push('文件夹：' + baseName(folder.path));
    if (album) parts.push('相册：' + album.name);
    if (state.filter.media === 'video') parts.push(formatCount(n) + ' 个视频');
    else if (state.filter.media === 'gif') parts.push(formatCount(n) + ' 个动图');
    else if (state.filter.media === 'photo') parts.push(formatCount(n) + ' 张照片');
    else if (videos > 0) parts.push(formatCount(n) + ' 个项目');
    else parts.push(formatCount(n) + ' 张照片');
    if (state.filter.q) parts.push('搜索「' + state.filter.q + '」');
    if (state.filter.year) parts.push(state.filter.year + '年');
    if (state.filter.month) parts.push(state.filter.month + '月');
    if (state.stats && !folder && !album && !state.filter.q && !state.filter.year && !state.filter.media) {
      if (videos > 0) parts.push('照片 ' + formatCount(photos) + ' · 视频 ' + formatCount(videos));
      parts.push('共 ' + formatBytes(state.stats.bytes));
    }
    $('subLabel').textContent = parts.join(' · ');
  }

  function updateEmpty() {
    const empty = $('empty');
    const show = state.items.length === 0 && !state.loading;
    empty.classList.toggle('hidden', !show);
    if (!show) return;
    const hasFolders = state.folders.length > 0;
    const album = state.filter.albumId
      ? state.albums.find((a) => Number(a.id) === Number(state.filter.albumId))
      : null;
    const filtered = !!(state.filter.q || state.filter.year || state.filter.month || state.filter.ext ||
      state.filter.minSize || state.filter.maxSize || state.jump || state.filter.media);
    if (album) {
      $('emptyTitle').textContent = '「' + album.name + '」里还没有内容';
      $('emptyDesc').textContent = '在照片墙上右键照片选择「添加到相册…」，或打开大图后点右上角的 ⊕，把照片、视频和动图放进这个相册。';
      $('emptyPick').textContent = '添加文件夹';
      $('emptyFolders').textContent = '';
      return;
    }
    $('emptyTitle').textContent = hasFolders ? (filtered ? '没有符合条件的项目' : '这个文件夹里没有图片或视频') : '还没有照片';
    $('emptyDesc').innerHTML = hasFolders
      ? (filtered ? '试试放宽筛选条件，或者清除全部条件。' : '相册会扫描文件夹及其子文件夹中的照片和视频，并按拍摄时间混排。')
      : '选择一个本地文件夹，相册会扫描其中的照片和视频并自动按拍摄时间整理。<br>所有文件只保存在你的电脑上。';
    $('emptyPick').textContent = hasFolders ? '添加文件夹' : '选择文件夹';
    $('emptyFolders').textContent = hasFolders ? state.folders.map((f) => f.path).join('  ·  ') : '';
  }

  /* ---------------- header ---------------- */

  function updateHeaderYear(key) {
    if (!key) return;
    const [y, m] = key.split('-');
    const label = state.filter.year && state.filter.month
      ? state.filter.year + '年' + state.filter.month + '月'
      : y + '年';
    const sig = key + '|' + label;
    state.currentKey = key;
    // 滚动时每帧都会调用，内容没变就不要再碰 DOM，避免固定顶栏反复重绘
    if (state.headerSig === sig) return;
    state.headerSig = sig;
    const labelEl = $('yearLabel');
    if (labelEl.textContent !== label) labelEl.textContent = label;
    const active = state.timeline.find((t) => String(t.year) === y);
    document.querySelectorAll('.tl-year').forEach((el) => {
      el.classList.toggle('active', !!(active && String(active.year) === y));
    });
  }

  function shiftYear(delta) {
    const list = state.timeline.map((t) => t.year);
    if (!list.length) return;
    const current = Number((state.currentKey || '').split('-')[0]) || list[0];
    const idx = list.indexOf(current);
    const next = list[Math.max(0, Math.min(list.length - 1, idx + delta))];
    if (next == null) return;
    state.filter.year = next;
    state.filter.month = null;
    state.jump = null;
    syncSheetFromFilter();
    renderChips();
    reload();
  }

  /* ---------------- chips ---------------- */

  function renderChips() {
    const box = $('chips');
    box.innerHTML = '';
    const add = (label, onClear) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      const b = document.createElement('b');
      b.textContent = label;
      const x = document.createElement('button');
      x.textContent = '✕';
      x.addEventListener('click', onClear);
      chip.appendChild(b);
      chip.appendChild(x);
      box.appendChild(chip);
    };

    if (state.filter.q) add('文件名：' + state.filter.q, () => { state.filter.q = ''; $('q').value = ''; applyFilter(); });
    if (state.filter.albumId) {
      const album = state.albums.find((a) => Number(a.id) === Number(state.filter.albumId));
      if (album) {
        add('相册：' + album.name, () => {
          state.filter.albumId = null;
          applyFilter();
        });
      }
    }
    if (state.filter.folderId) {
      const folder = state.folders.find((f) => Number(f.id) === Number(state.filter.folderId));
      if (folder) {
        add('文件夹：' + baseName(folder.path), () => {
          state.filter.folderId = null;
          applyFilter();
        });
      }
    }
    if (state.filter.year) {
      add(state.filter.year + '年' + (state.filter.month ? state.filter.month + '月' : ''), () => {
        state.filter.year = null; state.filter.month = null; syncSheetFromFilter(); applyFilter();
      });
    }
    if (!state.filter.year && state.jump) {
      add('跳到 ' + state.jump.year + '年' + state.jump.month + '月', () => {
        state.jump = null;
        state.offset = 0;
        applyFilter();
      });
    }
    if (state.filter.ext) add(state.filter.ext.toUpperCase().replace('.', ''), () => { state.filter.ext = ''; syncSheetFromFilter(); applyFilter(); });
    if (state.filter.media) {
      const label = state.filter.media === 'video' ? '只看视频' : (state.filter.media === 'gif' ? '只看动图' : '只看照片');
      add(label, () => {
        state.filter.media = '';
        syncSheetFromFilter();
        applyFilter();
      });
    }
    if (state.filter.minSize || state.filter.maxSize) {
      const a = state.filter.minSize ? (state.filter.minSize / 1048576).toFixed(1) + 'MB' : '0';
      const b = state.filter.maxSize ? (state.filter.maxSize / 1048576).toFixed(1) + 'MB' : '∞';
      add('大小 ' + a + ' – ' + b, () => {
        state.filter.minSize = 0; state.filter.maxSize = 0;
        $('fMin').value = ''; $('fMax').value = '';
        applyFilter();
      });
    }
  }

  /* ---------------- sheet ---------------- */

  function sheetOpen() {
    $('sheet').classList.add('on');
    $('sheetMask').classList.add('on');
    setTimeout(() => $('q').focus(), 80);
  }

  function sheetClose() {
    $('sheet').classList.remove('on');
    $('sheetMask').classList.remove('on');
  }

  function syncSheetFromFilter() {
    $('q').value = state.filter.q || '';
    $('fYear').value = state.filter.year ? String(state.filter.year) : '';
    $('fMonth').value = state.filter.month ? String(state.filter.month) : '';
    $('fExt').value = state.filter.ext || '';
    $('fMin').value = state.filter.minSize ? (state.filter.minSize / 1048576).toFixed(1) : '';
    $('fMax').value = state.filter.maxSize ? (state.filter.maxSize / 1048576).toFixed(1) : '';
    $('fSort').value = state.filter.sort || 'taken';
    document.querySelectorAll('#fDir button').forEach((b) => {
      b.classList.toggle('on', b.dataset.dir === (state.filter.dir || 'desc'));
    });
    document.querySelectorAll('#fMedia button').forEach((b) => {
      b.classList.toggle('on', (b.dataset.media || '') === (state.filter.media || ''));
    });
  }

  function readSheet(immediate) {
    state.filter.q = $('q').value.trim();
    const y = $('fYear').value;
    const m = $('fMonth').value;
    state.filter.year = y ? Number(y) : null;
    state.filter.month = y && m ? Number(m) : null;
    state.filter.ext = $('fExt').value;
    const minMb = parseFloat($('fMin').value);
    const maxMb = parseFloat($('fMax').value);
    state.filter.minSize = Number.isFinite(minMb) && minMb > 0 ? Math.round(minMb * 1048576) : 0;
    state.filter.maxSize = Number.isFinite(maxMb) && maxMb > 0 ? Math.round(maxMb * 1048576) : 0;
    state.filter.sort = $('fSort').value;
    const mediaBtn = document.querySelector('#fMedia button.on');
    state.filter.media = mediaBtn ? (mediaBtn.dataset.media || '') : '';
    state.jump = null;
    if (immediate) applyFilter();
  }

  function renderYearSelect() {
    const sel = $('fYear');
    const prev = sel.value;
    sel.innerHTML = '<option value="">全部年份</option>';
    for (const y of state.timeline) {
      const o = document.createElement('option');
      o.value = String(y.year);
      o.textContent = y.year + '年（' + formatCount(y.count) + '）';
      sel.appendChild(o);
    }
    if (prev) sel.value = prev;
  }

  function renderMonthSelect() {
    const year = Number($('fYear').value);
    const sel = $('fMonth');
    const prev = sel.value;
    sel.innerHTML = '<option value="">全部月份</option>';
    const entry = state.timeline.find((t) => t.year === year);
    if (entry) {
      for (const m of entry.months) {
        const o = document.createElement('option');
        o.value = String(m.month);
        o.textContent = m.month + '月（' + formatCount(m.count) + '）';
        sel.appendChild(o);
      }
    }
    if (prev) sel.value = prev;
  }

  function renderExtSelect() {
    const sel = $('fExt');
    const prev = sel.value;
    sel.innerHTML = '<option value="">全部格式</option>';
    const formats = (state.stats && state.stats.formats) || [];
    for (const f of formats) {
      const o = document.createElement('option');
      o.value = '.' + f.ext.toLowerCase();
      o.textContent = f.ext + '（' + formatCount(f.count) + '）';
      sel.appendChild(o);
    }
    if (prev) sel.value = prev;
  }

  /* ---------------- timeline ---------------- */

  function renderTimeline() {
    const rail = $('timeline');
    rail.innerHTML = '';
    state.headerSig = null;
    if (!state.timeline.length) return;
    for (const y of state.timeline.slice(0, 14)) {
      const btn = document.createElement('button');
      btn.className = 'tl-year';
      btn.dataset.year = String(y.year);
      btn.innerHTML = '<span>' + String(y.year).slice(2) + '</span><i></i>';
      btn.title = y.year + '年 · ' + formatCount(y.count) + ' 个项目';
      btn.addEventListener('click', () => openTlPanel(y.year));
      rail.appendChild(btn);
    }
  }

  function openTlPanel(year) {
    const panel = $('tlPanel');
    panel.classList.remove('hidden');
    panel.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'tl-head';
    head.innerHTML = '<span>时间轴 · 全部 ' + formatCount(state.stats ? state.stats.total : 0) + ' 个项目</span>';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.color = '#7a7a80';
    closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
    head.appendChild(closeBtn);
    panel.appendChild(head);

    for (const y of state.timeline) {
      const group = document.createElement('div');
      group.className = 'tl-group' + (y.year === year ? ' open' : '');
      const btn = document.createElement('button');
      btn.className = 'tl-group-year';
      btn.innerHTML = '<span style="color:inherit;font-size:13px;font-weight:600">' + y.year + '年<span style="margin-left:6px">' + formatCount(y.count) + '</span></span><span class="car">▶</span>';
      btn.addEventListener('click', () => group.classList.toggle('open'));
      group.appendChild(btn);

      const months = document.createElement('div');
      months.className = 'tl-months';
      for (const m of y.months) {
        const mb = document.createElement('button');
        mb.className = 'tl-month';
        mb.innerHTML = '<span style="color:inherit">' + m.month + '月</span><span>' + formatCount(m.count) + '</span>';
        mb.addEventListener('click', () => {
          panel.classList.add('hidden');
          jumpToMonth(y.year, m.month);
        });
        months.appendChild(mb);
      }
      group.appendChild(months);
      panel.appendChild(group);
    }
  }

  function jumpToMonth(year, month) {
    // 时间轴定位是“滚动到那个月”，不是把更新的照片过滤掉；
    // 按时间倒序才能用拍摄时间计算定位偏移。
    if (state.filter.sort !== 'taken') state.filter.sort = 'taken';
    if (state.filter.dir !== 'desc') state.filter.dir = 'desc';
    state.filter.year = null;
    state.filter.month = null;
    state.jump = { year, month };
    syncSheetFromFilter();
    applyFilter();
    toast('已跳到 ' + year + '年' + month + '月');
    updateHeaderYear(year + '-' + String(month).padStart(2, '0'));
  }

  /* ---------------- menus ---------------- */

  function closeMenu() {
    $('menu').classList.remove('on');
    state.menuTargetId = null;
  }

  function menuItem(label, hint, onClick, cls) {
    const b = document.createElement('button');
    b.className = 'menu-item' + (cls ? ' ' + cls : '');
    b.innerHTML = '<span>' + label + '</span>' + (hint ? '<span class="k">' + hint + '</span>' : '');
    b.addEventListener('click', () => { closeMenu(); onClick(); });
    return b;
  }

  function openMainMenu() {
    const menu = $('menu');
    menu.innerHTML = '';
    state.menuTargetId = null;
    menu.classList.add('on');
    const rect = $('btnMore').getBoundingClientRect();
    menu.style.left = Math.round(rect.right - 208) + 'px';
    menu.style.top = Math.round(rect.bottom + 6) + 'px';

    menu.appendChild(menuItem('添加文件夹…', 'Ctrl+O', () => openFolderBrowser()));
    menu.appendChild(menuItem('文件夹…', '', () => openFolderPanel()));
    menu.appendChild(menuItem('批量选择…', '', () => enterSelectMode()));
    menu.appendChild(menuItem('重新扫描全部', '', () => runScan(null)));
    menu.appendChild(menuItem('刷新列表', 'F5', () => refreshAll()));
    menu.appendChild(menuItem(state.theme === 'light' ? '切换到深色主题' : '切换到浅色主题', '', () => toggleTheme()));
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    menu.appendChild(sep);
    menu.appendChild(menuItem('滚动到顶部', '', () => window.PhotoGrid.scrollToTop()));
    menu.appendChild(menuItem('滚动到底部', '', () => window.PhotoGrid.scrollToBottom()));
    menu.appendChild(menuItem('清空缩略图缓存', '', async () => {
      const r = await api.clearCache();
      toast('已清理 ' + r.removed + ' 个缩略图文件');
      reload();
    }));
    const sep2 = document.createElement('div');
    sep2.className = 'menu-sep';
    menu.appendChild(sep2);
    menu.appendChild(menuItem('关于', '', () => openAbout()));

    const ver = document.createElement('div');
    ver.className = 'menu-title';
    ver.textContent = 'Album · Electron ' + ((state.versions && state.versions.electron) || '');
    menu.appendChild(ver);
  }

  function openPhotoMenu(item, x, y) {
    const menu = $('menu');
    menu.innerHTML = '';
    menu.classList.add('on');
    state.menuTargetId = item.id;
    const w = 216;
    menu.style.left = Math.min(window.innerWidth - w - 12, x) + 'px';
    menu.style.top = Math.min(window.innerHeight - 300, y) + 'px';
    menu.style.transformOrigin = 'top left';

    menu.appendChild(menuItem('打开', 'Enter', () => openViewerById(item.id)));
    menu.appendChild(menuItem(item.kind === 'video' ? '用系统播放器打开' : '用系统看图器打开', '', () => api.openOriginal(item.id)));
    menu.appendChild(menuItem('在文件夹中显示', '', () => api.reveal(item.id)));
    menu.appendChild(menuItem('复制路径', '', async () => {
      await api.copyPath(item.id);
      toast('已复制路径');
    }));
    if (item.kind !== 'video') {
      menu.appendChild(menuItem('复制图片', '', async () => {
        const r = await api.copyImage(item.id);
        toast(r.ok ? '已复制图片到剪贴板' : '复制失败');
      }));
    }
    menu.appendChild(menuItem('添加到相册…', '', () => openAlbumPicker([item.id], '添加到相册')));
    if (state.filter.albumId && albumById(state.filter.albumId)) {
      menu.appendChild(menuItem('从当前相册移除', '', () => removeFromCurrentAlbum(item)));
    }
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    menu.appendChild(sep);
    menu.appendChild(menuItem('从相册移除（不删文件）', '', () => removeFromLibrary(item)));
    menu.appendChild(menuItem('删除到回收站', '', () => deletePhoto(item), 'danger'));
  }

  /* ---------------- actions ---------------- */

  /* ---------------- 添加文件夹：内置浏览器 ---------------- */

  const BROWSER_PAGE = 120;
  const BROWSER_WEB = new Set([
    '.jpg', '.jpeg', '.jpe', '.jfif', '.jif', '.png', '.apng', '.gif',
    '.webp', '.avif', '.bmp', '.svg', '.ico'
  ]);
  const browserState = {
    open: false,
    path: null,
    parent: null,
    dirs: [],
    files: [],
    shown: 0,
    loading: false,
    roots: [],
    start: null
  };

  function baseName(p) {
    const s = String(p || '').replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function b64url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function probeUrl(mode, filePath) {
    return 'probe://' + mode + '/' + b64url(filePath);
  }

  async function openFolderBrowser() {
    if (browserState.open) return;
    browserState.open = true;
    $('folderBrowser').classList.add('on');
    if (!$('fbPreview').classList.contains('hidden')) closeBrowserPreview();
    if (!browserState.roots.length) {
      try {
        const r = await api.browseRoots();
        browserState.roots = (r && r.roots) || [];
        browserState.start = (r && r.start) || null;
      } catch {
        browserState.roots = [];
      }
    }
    renderRoots();
    const startPath = browserState.path || browserState.start ||
      (browserState.roots[0] && browserState.roots[0].path);
    if (startPath) await loadBrowse(startPath);
    else $('fbSub').textContent = '没有找到可浏览的磁盘';
  }

  function closeFolderBrowser() {
    browserState.open = false;
    $('folderBrowser').classList.remove('on');
    closeBrowserPreview();
  }

  async function loadBrowse(dirPath) {
    if (browserState.loading) return;
    browserState.loading = true;
    $('fbSub').textContent = '正在读取…';
    try {
      const res = await api.browseList(dirPath);
      browserState.path = res.path;
      browserState.parent = res.parent;
      browserState.dirs = res.dirs || [];
      browserState.files = res.files || [];
      browserState.shown = 0;
      $('fbPath').textContent = res.path;
      $('fbPath').title = res.path;
      $('fbUp').disabled = !res.parent;
      renderRoots();
      renderDirs();
      renderBrowserMedia(true);
      const parts = [];
      parts.push(res.totalDirs ? res.totalDirs + ' 个文件夹' : '没有子文件夹');
      if (res.totalFiles) parts.push(res.totalFiles + ' 个可预览项目');
      else parts.push('没有可预览的照片或视频');
      $('fbSub').textContent = parts.join(' · ') + ' · 添加后会扫描该文件夹及所有子文件夹';
      $('fbMain').scrollTop = 0;
    } catch (err) {
      $('fbSub').textContent = '无法读取这个文件夹：' + errText(err);
    } finally {
      browserState.loading = false;
    }
  }

  function renderRoots() {
    const box = $('fbRoots');
    box.innerHTML = '';
    const cur = String(browserState.path || '').toLowerCase();
    for (const r of browserState.roots) {
      const b = document.createElement('button');
      b.className = 'fb-drive';
      if (cur.startsWith(String(r.path).toLowerCase())) b.classList.add('on');
      b.textContent = r.name;
      b.title = r.path;
      b.addEventListener('click', () => loadBrowse(r.path));
      box.appendChild(b);
    }
  }

  function makeDirRow(label, kind, onClick, title) {
    const b = document.createElement('button');
    b.className = 'fb-dir' + (kind === 'up' ? ' up' : '');
    if (title) b.title = title;
    const svg = kind === 'up'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 19V5"></path><path d="M6 11l6-6 6 6"></path></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 6.5h5l2 2h10a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20.5 19h-17A1.5 1.5 0 0 1 2 17.5v-9a1.5 1.5 0 0 1 1.5-2z"></path></svg>';
    b.innerHTML = svg;
    const span = document.createElement('span');
    span.className = 'name';
    span.textContent = label;
    b.appendChild(span);
    b.addEventListener('click', onClick);
    return b;
  }

  function renderDirs() {
    const box = $('fbDirs');
    box.innerHTML = '';
    if (browserState.parent) {
      box.appendChild(makeDirRow('上一级', 'up', () => loadBrowse(browserState.parent)));
    }
    for (const d of browserState.dirs) {
      box.appendChild(makeDirRow(d.name, 'dir', () => loadBrowse(d.path), d.path));
    }
  }

  function renderBrowserMedia(reset) {
    const grid = $('fbGrid');
    if (reset) grid.innerHTML = '';
    const files = browserState.files;
    const start = browserState.shown;
    const end = Math.min(files.length, start + BROWSER_PAGE);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(browserCell(files[i]));
    grid.appendChild(frag);
    browserState.shown = end;
    $('fbEmpty').classList.toggle('hidden', files.length > 0);
    $('fbMore').classList.toggle('hidden', end >= files.length);
    $('fbMore').textContent = '显示更多（还有 ' + formatCount(files.length - end) + ' 个）';
  }

  function browserCell(file) {
    const cell = document.createElement('button');
    cell.className = 'fb-cell';
    cell.title = file.name;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = probeUrl('thumb', file.path);
    img.addEventListener('error', () => cell.classList.add('broken'));
    cell.appendChild(img);
    if (file.kind === 'video') {
      const play = document.createElement('span');
      play.className = 'fb-play';
      play.textContent = '▶';
      cell.appendChild(play);
    }
    cell.addEventListener('click', () => openBrowserPreview(file));
    return cell;
  }

  function openBrowserPreview(file) {
    const img = $('fbPreviewImg');
    img.src = probeUrl('preview', file.path);
    $('fbPreviewMeta').textContent = file.name + ' · ' +
      (file.kind === 'video' ? '视频' : '图片') + ' · ' +
      String(file.ext || '').replace('.', '').toUpperCase();
    $('fbPreview').classList.remove('hidden');
  }

  function closeBrowserPreview() {
    $('fbPreview').classList.add('hidden');
    $('fbPreviewImg').removeAttribute('src');
    $('fbPreviewMeta').textContent = '';
  }

  async function addBrowsedFolder() {
    if (!browserState.path || browserState.loading) return;
    const target = browserState.path;
    $('fbAdd').disabled = true;
    try {
      const res = await api.addFolderPath(target);
      state.folders = res.folders || state.folders;
      const folder = res.folder || (res.added && res.added[0]);
      closeFolderBrowser();
      if (!folder) {
        toast('文件夹已在相册中');
        return;
      }
      toast(res.existing ? '已在相册中，重新扫描…' : '已添加文件夹，开始扫描…');
      await runScan(folder.id);
    } catch (err) {
      toast('添加失败：' + errText(err));
    } finally {
      $('fbAdd').disabled = false;
    }
  }

  /* ---------------- 文件夹面板 ---------------- */

  function openFolderPanel() {
    const old = document.getElementById('folderPanelMask');
    if (old) old.remove();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.id = 'folderPanelMask';
    const modal = document.createElement('div');
    modal.className = 'modal folders';

    const title = document.createElement('h3');
    title.textContent = '文件夹';
    modal.appendChild(title);

    const list = document.createElement('div');
    list.className = 'folder-list';

    const total = state.stats ? Number(state.stats.total) || 0 : state.total;
    list.appendChild(makeFolderRow({
      name: '全部照片',
      pathText: '显示相册中的全部照片和视频',
      count: formatCount(total) + ' 个项目',
      actions: [{ label: '查看', onClick: () => viewFolder(null) }]
    }));

    for (const f of state.folders) {
      const parts = [formatCount(f.total) + ' 个项目'];
      if (Number(f.videos) > 0) parts.push(Number(f.videos) + ' 个视频');
      list.appendChild(makeFolderRow({
        name: baseName(f.path),
        pathText: f.path,
        count: parts.join(' · '),
        actions: [
          { label: '查看', onClick: () => viewFolder(f.id) },
          { label: '扫描', onClick: () => { close(); runScan(f.id); } },
          { label: '移除', onClick: () => removeFolderFromPanel(f.id, f.path) }
        ]
      }));
    }

    if (!state.folders.length) {
      const empty = document.createElement('div');
      empty.className = 'folder-empty';
      empty.textContent = '还没有添加文件夹';
      list.appendChild(empty);
    }
    modal.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'ghost-action';
    addBtn.textContent = '添加文件夹';
    addBtn.addEventListener('click', () => { close(); openFolderBrowser(); });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ghost-action';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', close);
    actions.appendChild(addBtn);
    actions.appendChild(closeBtn);
    modal.appendChild(actions);

    mask.appendChild(modal);
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('on'));

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      mask.classList.remove('on');
      setTimeout(() => mask.remove(), 180);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close();
      }
    }
    document.addEventListener('keydown', onKey, true);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

    function viewFolder(id) {
      close();
      state.filter.folderId = id == null ? null : Number(id);
      state.filter.albumId = null;
      applyFilter();
      window.PhotoGrid.scrollToTop();
    }

    async function removeFolderFromPanel(id, folderPath) {
      const ok = await confirmDialog('移除这个文件夹？',
        '只会从相册索引里移除，电脑上的原文件不会被删除。<br><span style="color:var(--dim);word-break:break-all">' +
        String(folderPath).replace(/</g, '&lt;') + '</span>', '从相册移除');
      if (!ok) return;
      const res = await api.removeFolder(id);
      state.folders = res || [];
      if (Number(state.filter.folderId) === Number(id)) state.filter.folderId = null;
      await refreshAll();
      close();
      openFolderPanel();
      toast('已从相册移除');
    }
  }

  function makeFolderRow({ name, pathText, count, actions }) {
    const row = document.createElement('div');
    row.className = 'folder-row';
    const info = document.createElement('div');
    info.className = 'f-main';
    const n = document.createElement('div');
    n.className = 'f-name';
    n.textContent = name;
    const p = document.createElement('div');
    p.className = 'f-path';
    p.textContent = pathText;
    p.title = pathText;
    info.appendChild(n);
    info.appendChild(p);
    row.appendChild(info);

    const cnt = document.createElement('div');
    cnt.className = 'f-count';
    cnt.textContent = count;
    row.appendChild(cnt);

    const acts = document.createElement('div');
    acts.className = 'f-actions';
    for (const action of actions) {
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = action.label;
      b.addEventListener('click', action.onClick);
      acts.appendChild(b);
    }
    row.appendChild(acts);
    return row;
  }

  /* ---------------- 相册分类 ---------------- */

  const albumsState = { open: false, q: '', sort: 'created' };
  const selection = { on: false };
  const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function albumById(id) {
    return state.albums.find((a) => Number(a.id) === Number(id)) || null;
  }

  function thumbUrl(id) {
    return 'thumb://photo/' + id;
  }

  async function refreshAlbums() {
    state.albums = await api.listAlbums();
    if (albumsState.open) renderAlbumPanel();
    renderChips();
    updateSubLabel();
  }

  function renderAlbumPanel() {
    renderSmartCards();
    renderAlbumGrid();
  }

  function renderSmartCards() {
    const box = $('apSmart');
    if (!box) return;
    box.innerHTML = '';
    const stats = state.stats || {};
    const defs = [
      {
        key: 'all',
        label: '全部照片',
        count: Number(stats.total) || 0,
        icon: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.2"></rect><circle cx="8.5" cy="10" r="1.6"></circle><path d="M3.8 16.4l4.6-4a1.6 1.6 0 0 1 2.1 0l3 2.6 2-1.7a1.6 1.6 0 0 1 2 0l3.2 2.9"></path></svg>',
        active: !state.filter.media && !state.filter.albumId
      },
      {
        key: 'video',
        label: '视频',
        count: Number(stats.videos) || 0,
        icon: '<svg viewBox="0 0 24 24"><rect x="3.2" y="5.4" width="17.6" height="13.2" rx="2.2"></rect><path d="M10.2 9.4l4.8 2.6-4.8 2.6z" fill="currentColor" stroke="none"></path></svg>',
        active: state.filter.media === 'video'
      },
      {
        key: 'gif',
        label: 'GIF 动图',
        count: Number(stats.gifs) || 0,
        icon: '<svg viewBox="0 0 24 24"><rect x="3.2" y="6.4" width="12" height="11.2" rx="2.2"></rect><path d="M18 10.2l3-1.7v7l-3-1.7"></path></svg>',
        active: state.filter.media === 'gif'
      }
    ];
    for (const d of defs) {
      const b = document.createElement('button');
      b.className = 'ap-smart-card' + (d.active ? ' on' : '');
      b.innerHTML = d.icon + '<b>' + d.label + '</b><span>' + formatCount(d.count) + ' 个</span>';
      b.addEventListener('click', () => applySmartCategory(d.key));
      box.appendChild(b);
    }
  }

  function applySmartCategory(key) {
    state.filter.albumId = null;
    state.filter.media = key === 'video' ? 'video' : (key === 'gif' ? 'gif' : '');
    state.jump = null;
    syncSheetFromFilter();
    applyFilter();
    window.PhotoGrid.scrollToTop();
    closeAlbums();
  }

  function renderAlbumGrid() {
    const box = $('apGrid');
    if (!box) return;
    box.innerHTML = '';
    const q = albumsState.q.trim().toLowerCase();
    let list = state.albums.slice();
    if (q) list = list.filter((a) => String(a.name).toLowerCase().includes(q));
    if (albumsState.sort === 'name') list.sort((a, b) => nameCollator.compare(a.name, b.name));
    else if (albumsState.sort === 'count') list.sort((a, b) => b.count - a.count || nameCollator.compare(a.name, b.name));
    else list.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    for (const album of list) box.appendChild(albumCard(album));
    const empty = $('apEmpty');
    empty.classList.toggle('hidden', list.length > 0);
    empty.textContent = q ? '没有匹配的相册' : '还没有相册，点右上角「新建相册」开始整理';
  }

  function albumCard(album) {
    const card = document.createElement('div');
    card.className = 'ap-card';
    card.dataset.albumId = String(album.id);
    card.title = album.name + ' · ' + formatCount(album.count) + ' 个项目';

    const cover = document.createElement('div');
    cover.className = 'ap-cover';
    const ids = [];
    if (album.coverId) ids.push(album.coverId);
    for (const id of album.previews || []) if (!ids.includes(id)) ids.push(id);
    const shown = ids.slice(0, 4);
    if (shown.length) {
      if (shown.length === 1) cover.classList.add('single');
      for (const id of shown) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.src = thumbUrl(id);
        cover.appendChild(img);
      }
    } else {
      cover.classList.add('empty');
      const ph = document.createElement('span');
      ph.textContent = '空相册';
      cover.appendChild(ph);
    }
    card.appendChild(cover);

    const meta = document.createElement('div');
    meta.className = 'ap-meta';
    const name = document.createElement('div');
    name.className = 'ap-name';
    name.textContent = album.name;
    const sub = document.createElement('div');
    sub.className = 'ap-sub';
    sub.textContent = formatCount(album.count) + ' 个项目';
    meta.appendChild(name);
    meta.appendChild(sub);
    card.appendChild(meta);

    const more = document.createElement('button');
    more.className = 'ap-menu';
    more.title = '相册操作';
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"></circle></svg>';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      openAlbumMenu(album, r.right, r.bottom + 4);
    });
    card.appendChild(more);

    card.addEventListener('click', () => viewAlbum(album));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openAlbumMenu(album, e.clientX, e.clientY);
    });

    card.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types || !Array.from(e.dataTransfer.types).includes('application/x-album-photos')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      card.classList.add('drop');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop');
      const list = readDragIds(e);
      if (list.length) addIdsToAlbum(album, list);
    });
    return card;
  }

  function openAlbumMenu(album, x, y) {
    const menu = $('menu');
    menu.innerHTML = '';
    menu.classList.add('on');
    state.menuTargetId = null;
    const w = 200;
    menu.style.left = Math.min(window.innerWidth - w - 12, Math.max(8, x - w)) + 'px';
    menu.style.top = Math.min(window.innerHeight - 210, Math.max(8, y)) + 'px';
    menu.style.transformOrigin = 'top right';
    menu.appendChild(menuItem('查看相册', '', () => viewAlbum(album)));
    menu.appendChild(menuItem('重命名…', '', () => renameAlbumFlow(album)));
    menu.appendChild(menuItem('更换封面…', '', () => chooseCoverFlow(album)));
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    menu.appendChild(sep);
    menu.appendChild(menuItem('删除相册', '', () => deleteAlbumFlow(album), 'danger'));
  }

  function openAlbums() {
    if (albumsState.open) {
      closeAlbums();
      return;
    }
    albumsState.open = true;
    $('albumsPanel').classList.add('on');
    document.body.classList.add('albums-open');
    $('apSearch').value = albumsState.q;
    $('apSort').value = albumsState.sort;
    window.PhotoGrid.setDraggable(true);
    renderAlbumPanel();
    refreshAlbums().catch((err) => toast('读取相册失败：' + errText(err)));
  }

  function closeAlbums() {
    if (!albumsState.open) return;
    albumsState.open = false;
    $('albumsPanel').classList.remove('on');
    document.body.classList.remove('albums-open');
    window.PhotoGrid.setDraggable(false);
  }

  function viewAlbum(album) {
    if (!album) return;
    state.filter.albumId = Number(album.id);
    state.filter.folderId = null;
    state.filter.media = '';
    state.filter.q = '';
    state.filter.year = null;
    state.filter.month = null;
    state.filter.ext = '';
    state.filter.minSize = 0;
    state.filter.maxSize = 0;
    state.jump = null;
    syncSheetFromFilter();
    closeAlbums();
    applyFilter();
    window.PhotoGrid.scrollToTop();
  }

  async function createAlbumFlow() {
    const name = await promptDialog({ title: '新建相册', label: '相册名称', placeholder: '例如：旅行、家人、壁纸', okLabel: '创建' });
    if (!name) return null;
    try {
      const album = await api.createAlbum(name);
      await refreshAlbums();
      if (albumsState.open) renderAlbumPanel();
      if (album) toast('已创建相册「' + album.name + '」');
      return album;
    } catch (err) {
      toast('创建失败：' + errText(err));
      return null;
    }
  }

  async function renameAlbumFlow(album) {
    const name = await promptDialog({ title: '重命名相册', label: '相册名称', value: album.name, okLabel: '保存' });
    if (!name || name === album.name) return;
    try {
      await api.updateAlbum(album.id, { name });
      await refreshAlbums();
      if (albumsState.open) renderAlbumPanel();
      toast('已重命名');
    } catch (err) {
      toast('重命名失败：' + errText(err));
    }
  }

  async function chooseCoverFlow(album) {
    let items = [];
    try {
      const batch = await api.query({ albumId: album.id, sort: 'taken', dir: 'desc' }, 0, 300);
      items = (batch && batch.items) || [];
    } catch (err) {
      toast('读取相册失败：' + errText(err));
      return;
    }
    if (!items.length) {
      toast('这个相册里还没有照片');
      return;
    }
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal picker">' +
      '<h3>选择封面</h3>' +
      '<p class="picker-sub">从「' + escapeHtml(album.name) + '」里的 ' + formatCount(items.length) + ' 个项目中选一张</p>' +
      '<div class="cover-grid"></div>' +
      '<div class="modal-actions"><button class="ghost-action" data-act="close">取消</button></div>' +
      '</div>';
    const grid = mask.querySelector('.cover-grid');
    const done = () => {
      mask.classList.remove('on');
      setTimeout(() => mask.remove(), 180);
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        done();
      }
    };
    for (const it of items) {
      const cell = document.createElement('button');
      cell.className = 'cover-cell';
      cell.title = it.name;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = thumbUrl(it.id);
      cell.appendChild(img);
      cell.addEventListener('click', async () => {
        try {
          await api.updateAlbum(album.id, { coverId: it.id });
          done();
          await refreshAlbums();
          if (albumsState.open) renderAlbumPanel();
          toast('已更新封面');
        } catch (err) {
          toast('设置封面失败：' + errText(err));
        }
      });
      grid.appendChild(cell);
    }
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('on'));
    document.addEventListener('keydown', onKey, true);
    mask.addEventListener('click', (e) => ifMaskClose(e));
    function ifMaskClose(e) {
      if (e.target === mask) done();
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') done();
    }
  }

  async function deleteAlbumFlow(album) {
    const ok = await confirmDialog('删除相册「' + album.name + '」？',
      '只会删除这个分类，相册里的照片、视频和动图都不会被删除，原文件也不受影响。', '删除相册');
    if (!ok) return;
    try {
      state.albums = await api.deleteAlbum(album.id);
      if (Number(state.filter.albumId) === Number(album.id)) {
        state.filter.albumId = null;
        applyFilter();
      }
      if (albumsState.open) renderAlbumPanel();
      renderChips();
      updateSubLabel();
      toast('已删除相册');
    } catch (err) {
      toast('删除失败：' + errText(err));
    }
  }

  function promptDialog({ title, label, value, placeholder, okLabel }) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal prompt">' +
        '<h3>' + escapeHtml(title || '') + '</h3>' +
        (label ? '<div class="prompt-label">' + escapeHtml(label) + '</div>' : '') +
        '<input class="prompt-input" type="text" maxlength="60" autocomplete="off">' +
        '<div class="modal-actions"><button class="ghost-action" data-act="cancel">取消</button>' +
        '<button class="primary-btn" data-act="ok" style="height:32px;padding:0 16px">' + escapeHtml(okLabel || '确定') + '</button></div>' +
        '</div>';
      const input = mask.querySelector('.prompt-input');
      input.value = value || '';
      input.placeholder = placeholder || '';
      let closed = false;
      const done = (v) => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        mask.classList.remove('on');
        setTimeout(() => mask.remove(), 180);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          done(null);
        }
      };
      document.body.appendChild(mask);
      requestAnimationFrame(() => {
        mask.classList.add('on');
        input.focus();
        input.select();
      });
      document.addEventListener('keydown', onKey, true);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const v = input.value.trim();
          done(v || null);
        }
      });
      mask.addEventListener('click', (e) => {
        if (e.target === mask) done(null);
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'ok') done(input.value.trim() || null);
        if (act === 'cancel') done(null);
      });
    });
  }

  async function openAlbumPicker(ids, title) {
    const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
    if (!list.length) {
      toast('还没有选中任何项目');
      return;
    }
    let albums = state.albums.slice();
    try {
      albums = await api.listAlbums();
      state.albums = albums;
    } catch {
      /* 用缓存列表 */
    }

    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal picker picker-albums">' +
      '<h3>' + escapeHtml(title || '添加到相册') + '</h3>' +
      '<p class="picker-sub">已选 ' + formatCount(list.length) + ' 个项目 · 同一张照片可以同时加入多个相册</p>' +
      '<div class="picker-grid"></div>' +
      '<div class="picker-new"><input type="text" maxlength="60" placeholder="新相册名称" autocomplete="off"><button class="primary-btn">新建并添加</button></div>' +
      '<div class="modal-actions"><button class="ghost-action" data-act="close">完成</button></div>' +
      '</div>';
    const listBox = mask.querySelector('.picker-grid');
    const input = mask.querySelector('.picker-new input');
    const newBtn = mask.querySelector('.picker-new button');

    const done = () => {
      mask.classList.remove('on');
      setTimeout(() => mask.remove(), 180);
      document.removeEventListener('keydown', onKey, true);
      refreshAlbums().catch(() => {});
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        done();
      }
    };

    const coverOf = (album) => album.coverId || (album.previews && album.previews[0]) || null;

    const paintCover = (coverEl, album) => {
      const id = coverOf(album);
      coverEl.innerHTML = '';
      if (id) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.src = thumbUrl(id);
        coverEl.appendChild(img);
        coverEl.classList.remove('empty');
      } else {
        coverEl.classList.add('empty');
        const ph = document.createElement('span');
        ph.textContent = '空相册';
        coverEl.appendChild(ph);
      }
      const mark = document.createElement('span');
      mark.className = 'pk-ok hidden';
      mark.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="6,12.5 10.5,17 18,8"></polyline></svg>';
      coverEl.appendChild(mark);
    };

    const renderRows = () => {
      listBox.innerHTML = '';
      if (!albums.length) {
        const p = document.createElement('div');
        p.className = 'picker-empty';
        p.textContent = '还没有相册，在下方输入名称即可新建';
        listBox.appendChild(p);
        return;
      }
      for (const album of albums) {
        const card = document.createElement('button');
        card.className = 'picker-card';
        card.title = album.name;
        card.innerHTML = '<span class="pk-cover"></span>' +
          '<span class="pk-name">' + escapeHtml(album.name) + '</span>' +
          '<span class="pk-count">' + formatCount(album.count) + ' 个项目</span>';
        paintCover(card.querySelector('.pk-cover'), album);
        card.addEventListener('click', async () => {
          if (card.classList.contains('busy')) return;
          card.classList.add('busy');
          try {
            const res = await api.addToAlbum(album.id, list);
            if (res && res.album) {
              albums = albums.map((a) => (a.id === res.album.id ? res.album : a));
              card.querySelector('.pk-count').textContent = formatCount(res.album.count) + ' 个项目';
              if (res.added) {
                paintCover(card.querySelector('.pk-cover'), res.album);
                card.classList.add('added');
                card.querySelector('.pk-ok').classList.remove('hidden');
              }
            }
            toast(res && res.added
              ? '已添加 ' + formatCount(res.added) + ' 个项目到「' + album.name + '」'
              : '这些项目已经在「' + album.name + '」里了');
            refreshAlbums().catch(() => {});
          } catch (err) {
            toast('添加失败：' + errText(err));
          } finally {
            card.classList.remove('busy');
          }
        });
        listBox.appendChild(card);
      }
    };

    newBtn.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      try {
        const album = await api.createAlbum(name);
        await api.addToAlbum(album.id, list);
        albums = await api.listAlbums();
        state.albums = albums;
        input.value = '';
        renderRows();
        toast('已创建「' + album.name + '」并加入 ' + formatCount(list.length) + ' 个项目');
      } catch (err) {
        toast('创建失败：' + errText(err));
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        newBtn.click();
      }
    });

    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('on'));
    document.addEventListener('keydown', onKey, true);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) done();
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') done();
    });
    renderRows();
  }

  function readDragIds(e) {
    try {
      const raw = e.dataTransfer.getData('application/x-album-photos');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.map(Number).filter(Number.isFinite);
      }
      const txt = e.dataTransfer.getData('text/plain');
      if (txt) return txt.split(',').map(Number).filter(Number.isFinite);
    } catch {
      /* 忽略无效拖拽数据 */
    }
    return [];
  }

  async function addIdsToAlbum(album, ids) {
    try {
      const res = await api.addToAlbum(album.id, ids);
      const added = (res && res.added) || 0;
      toast(added
        ? '已把 ' + formatCount(added) + ' 个项目加入「' + album.name + '」'
        : '这些项目已经在「' + album.name + '」里了');
      state.albums = await api.listAlbums();
      if (albumsState.open) renderAlbumPanel();
      updateSubLabel();
    } catch (err) {
      toast('添加失败：' + errText(err));
    }
  }

  async function removeFromCurrentAlbum(item) {
    const album = albumById(state.filter.albumId);
    if (!album) return;
    try {
      const res = await api.removeFromAlbum(album.id, [item.id]);
      if (res && res.removed) {
        window.PhotoGrid.removeItem(item.id);
        state.items = window.PhotoGrid.items();
        state.total = Math.max(0, state.total - 1);
        updateSubLabel();
        refreshAlbums().catch(() => {});
        toast('已从相册移除，原文件仍在');
      }
    } catch (err) {
      toast('移除失败：' + errText(err));
    }
  }

  function enterSelectMode() {
    if (selection.on) return;
    selection.on = true;
    closeMenu();
    closeAlbums();
    window.PhotoGrid.setSelectMode(true);
    $('selectBar').classList.add('on');
    updateSelCount(0);
    toast('点按选择项目，再点「添加到相册」');
  }

  function exitSelectMode() {
    if (!selection.on) return;
    selection.on = false;
    window.PhotoGrid.setSelectMode(false);
    $('selectBar').classList.remove('on');
  }

  function updateSelCount(n) {
    $('selCount').textContent = '已选 ' + formatCount(n) + ' 项';
    $('selAlbum').disabled = !n;
  }

  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  function scanBar() {
    return document.getElementById('scanBar');
  }

  function applyTheme(theme, persist) {
    const t = theme === 'light' ? 'light' : 'dark';
    state.theme = t;
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('album-theme', t); } catch { /* ignore */ }
    if (api.windowTheme) api.windowTheme(t).catch(() => {});
    if (persist !== false) api.saveSettings({ theme: t }).catch(() => {});
  }

  function toggleTheme() {
    applyTheme(state.theme === 'light' ? 'dark' : 'light', true);
    toast(state.theme === 'light' ? '已切换到浅色主题' : '已切换到深色主题');
  }

  async function runScan(folderId) {
    if (state.scan) return;
    state.scan = true;
    const bar = scanBar();
    if (bar) {
      bar.classList.add('on');
      bar.style.width = '2%';
    }
    try {
      const result = await api.scan(folderId);
      if (result && result.busy) {
        toast('正在扫描中，请稍候');
        return;
      }
      const results = result.results || [];
      const totalIndexed = results.reduce((a, r) => a + r.indexed, 0);
      const totalFound = results.reduce((a, r) => a + (r.found || 0), 0);
      const totalFailed = results.reduce((a, r) => a + (r.failed || 0), 0);
      let msg = '扫描完成，已索引 ' + formatCount(totalIndexed) + ' 个文件';
      if (!totalIndexed && !totalFound) msg = '这个文件夹里没有找到照片或视频';
      else if (totalFailed) msg += '（' + totalFailed + ' 个文件无法读取）';
      toast(msg);
    } catch (err) {
      toast('扫描失败：' + errText(err));
    } finally {
      state.scan = false;
      if (bar) {
        bar.classList.remove('on');
        bar.style.width = '0';
      }
      $('subLabel').classList.remove('scanning');
      try {
        await refreshAll();
      } catch (err) {
        toast('刷新列表失败：' + errText(err));
      }
    }
  }

  async function refreshAll() {
    state.stats = await api.stats();
    state.folders = await api.listFolders();
    state.albums = await api.listAlbums();
    await refreshTimeline();
    renderExtSelect();
    if (albumsState.open) renderAlbumPanel();
    await reload();
  }

  function applyFilter() {
    api.saveSettings({ sort: state.filter.sort, dir: state.filter.dir }).catch(() => {});
    renderChips();
    reload();
  }

  async function deletePhoto(item) {
    const isVideo = item && item.kind === 'video';
    const ok = await confirmDialog(isVideo ? '删除这个视频？' : '删除这张照片？', '文件会被移入系统回收站，可随时恢复。', '移到回收站');
    if (!ok) return;
    const index = window.PhotoViewer.index();
    const res = await api.deletePhotos([item.id], true);
    if (res.removed) {
      window.PhotoGrid.removeItem(item.id);
      state.items = window.PhotoGrid.items();
      state.total = Math.max(0, state.total - res.removed);
      updateSubLabel();
      if (window.PhotoViewer.isOpen()) window.PhotoViewer.afterRemove(index);
      toast('已移到回收站');
      refreshTimeline();
    } else if (res.failed && res.failed.length) {
      toast('删除失败：' + res.failed[0].error);
    }
  }

  async function removeFromLibrary(item) {
    const ok = await confirmDialog('从相册移除？', '只会把它从相册索引里去掉，电脑上的原文件不会被删除。', '从相册移除');
    if (!ok) return;
    const res = await api.deletePhotos([item.id], false);
    if (res.removed) {
      window.PhotoGrid.removeItem(item.id);
      state.items = window.PhotoGrid.items();
      state.total = Math.max(0, state.total - res.removed);
      updateSubLabel();
      toast('已从相册移除');
    }
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="modal">
          <h3>${title}</h3>
          <p>${text}</p>
          <div class="modal-actions">
            <button class="ghost-action" data-act="cancel">取消</button>
            <button class="primary-btn" data-act="ok" style="height:32px;padding:0 16px">${okLabel}</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add('on'));
      const done = (v) => {
        mask.classList.remove('on');
        setTimeout(() => mask.remove(), 180);
        resolve(v);
      };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) done(false);
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'ok') done(true);
        if (act === 'cancel') done(false);
      });
    });
  }

  const ABOUT_AUTHOR = '宇宙世界最强反派';

  function openAbout() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const chars = ABOUT_AUTHOR.split('').map((c) => '<span>' + c + '</span>').join('');
    const appVer = (state.versions && state.versions.app) || '';
    mask.innerHTML =
      '<div class="modal about">' +
        '<div class="about-head">' +
          '<img class="about-icon" src="../assets/app-256.png" alt="">' +
          '<div class="about-id">' +
            '<h3>Album</h3>' +
            '<div class="about-tag">本地照片与视频相册</div>' +
          '</div>' +
          (appVer ? '<span class="about-ver">v' + appVer + '</span>' : '') +
        '</div>' +
        '<div class="about-section">' +
          '<div class="about-label">使用声明</div>' +
          '<ul class="about-list">' +
            '<li>本项目依据 MIT 许可协议开源，可免费使用、复制、修改、分发，也可用于商业用途。</li>' +
            '<li>分发本软件或其修改版本时，必须保留原始版权声明。</li>' +
            '<li>本软件按现状提供，不提供任何担保；使用风险与本地图片版权由使用者自行承担，禁止用于违法、侵权场景。</li>' +
            '<li>使用此软件默认同意以上全部条款。</li>' +
          '</ul>' +
        '</div>' +
        '<div class="about-author">作者：<b class="chars">' + chars + '</b></div>' +
        '<div class="modal-actions"><button class="ghost-action" data-act="close">关闭</button></div>' +
      '</div>';
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('on'));

    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      mask.classList.remove('on');
      setTimeout(() => mask.remove(), 180);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        done();
      }
    };
    document.addEventListener('keydown', onKey, true);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) return done();
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') done();
    });
  }

  function openViewerById(id) {
    const idx = window.PhotoGrid.items().findIndex((x) => x.id === id);
    if (idx >= 0) openItem(idx);
  }

  function openItem(index) {
    const item = window.PhotoGrid.itemAt(index);
    if (!item) return;
    if (item.kind === 'video') window.VideoPlayer.open(item);
    else window.PhotoViewer.open(index);
  }

  /* ---------------- 视频时长 ---------------- */

  const durationQueue = [];
  const durationPending = new Set();
  let durationBusy = false;

  function ensureDuration(item) {
    if (!item || item.kind !== 'video' || item.duration) return;
    if (durationPending.has(item.id)) return;
    durationPending.add(item.id);
    durationQueue.push(item);
    pumpDurations();
  }

  async function pumpDurations() {
    if (durationBusy) return;
    durationBusy = true;
    try {
      while (durationQueue.length) {
        const item = durationQueue.shift();
        const ms = await measureDuration(item.id);
        durationPending.delete(item.id);
        if (ms) {
          item.duration = ms;
          window.PhotoGrid.updateItem(item.id, { duration: ms });
          api.setMediaMeta(item.id, { duration: ms }).catch(() => {});
        }
      }
    } finally {
      durationBusy = false;
    }
  }

  function measureDuration(id) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeAttribute('src');
        try { v.load(); } catch { /* ignore */ }
        resolve(val);
      };
      const timer = setTimeout(() => finish(null), 8000);
      v.addEventListener('loadedmetadata', () => {
        const d = v.duration;
        finish(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null);
      }, { once: true });
      v.addEventListener('error', () => finish(null), { once: true });
      v.src = 'video://media/' + id;
      v.load();
    });
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    window.PhotoGrid.mount({
      scroller: $('scroller'),
      grid: $('grid'),
      onOpen: (index) => openItem(index),
      onNeedMore: () => { loadMore(); },
      onContextMenu: (item, x, y) => openPhotoMenu(item, x, y),
      onYearChange: (key) => updateHeaderYear(key),
      onNeedDuration: (item) => ensureDuration(item),
      onNeedOlder: () => loadOlder(),
      onSelectionChange: (n) => updateSelCount(n)
    });

    window.VideoPlayer.mount({
      onOpenOriginal: (item) => api.openOriginal(item.id)
    });

    window.PhotoViewer.mount({
      onAddAlbum: (item) => openAlbumPicker([item.id], '添加到相册'),
      onDelete: (item) => deletePhoto(item),
      onOpenOriginal: (item) => api.openOriginal(item.id),
      onNeedMore: () => loadMore()
    });

    $('btnSearch').addEventListener('click', () => { syncSheetFromFilter(); sheetOpen(); });
    $('btnAlbums').addEventListener('click', (e) => {
      e.stopPropagation();
      openAlbums();
    });
    $('btnMore').addEventListener('click', (e) => {
      e.stopPropagation();
      // 再点一次三个点关闭菜单（右键照片弹出的菜单不算）
      const menu = $('menu');
      if (menu.classList.contains('on') && state.menuTargetId == null) closeMenu();
      else openMainMenu();
    });
    $('sheetMask').addEventListener('click', sheetClose);
    $('btnCloseSheet').addEventListener('click', sheetClose);
    $('btnClearFilter').addEventListener('click', () => {
      state.filter = { sort: 'taken', dir: 'desc', media: '', albumId: null };
      state.jump = null;
      syncSheetFromFilter();
      applyFilter();
      toast('已清除全部条件');
    });

    $('q').addEventListener('input', debounce(() => readSheet(true), 260));
    $('fYear').addEventListener('change', () => { renderMonthSelect(); readSheet(true); });
    $('fMonth').addEventListener('change', () => readSheet(true));
    $('fExt').addEventListener('change', () => readSheet(true));
    $('fMin').addEventListener('input', debounce(() => readSheet(true), 400));
    $('fMax').addEventListener('input', debounce(() => readSheet(true), 400));
    $('fSort').addEventListener('change', () => readSheet(true));
    $('fDir').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      state.filter.dir = btn.dataset.dir;
      document.querySelectorAll('#fDir button').forEach((b) => b.classList.toggle('on', b === btn));
      readSheet(true);
    });
    $('fMedia').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      document.querySelectorAll('#fMedia button').forEach((b) => b.classList.toggle('on', b === btn));
      readSheet(true);
    });

    $('apClose').addEventListener('click', () => closeAlbums());
    $('apNew').addEventListener('click', () => { createAlbumFlow(); });
    $('apSearch').addEventListener('input', debounce(() => {
      albumsState.q = $('apSearch').value;
      renderAlbumGrid();
    }, 160));
    $('apSort').addEventListener('change', () => {
      albumsState.sort = $('apSort').value;
      renderAlbumGrid();
    });
    $('selCancel').addEventListener('click', () => exitSelectMode());
    $('selAlbum').addEventListener('click', async () => {
      const ids = window.PhotoGrid.selectedIds();
      if (!ids.length) return;
      await openAlbumPicker(ids, '批量添加到相册');
      exitSelectMode();
    });

    $('prevYear').addEventListener('click', () => shiftYear(-1));
    $('nextYear').addEventListener('click', () => shiftYear(1));
    $('emptyPick').addEventListener('click', () => openFolderBrowser());

    $('fbClose').addEventListener('click', () => closeFolderBrowser());
    $('fbUp').addEventListener('click', () => {
      if (browserState.parent) loadBrowse(browserState.parent);
    });
    $('fbAdd').addEventListener('click', () => addBrowsedFolder());
    $('fbMore').addEventListener('click', () => renderBrowserMedia(false));
    $('fbPreviewClose').addEventListener('click', () => closeBrowserPreview());
    $('fbPreview').addEventListener('click', (e) => {
      if (e.target === $('fbPreview')) closeBrowserPreview();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#menu') && !e.target.closest('#btnMore')) closeMenu();
      if (!e.target.closest('#tlPanel') && !e.target.closest('.tl-year')) $('tlPanel').classList.add('hidden');
    });

    window.addEventListener('resize', () => window.PhotoViewer.handleResize());

    api.onScanProgress((ev) => {
      const bar = scanBar();
      if (ev.phase === 'walking') {
        if (bar) bar.style.width = '8%';
        $('subLabel').textContent = '正在查找照片和视频… 已发现 ' + formatCount(ev.found);
      } else if (ev.phase === 'indexing') {
        const pct = ev.found ? Math.min(92, 8 + (ev.processed / ev.found) * 84) : 40;
        if (bar) bar.style.width = pct.toFixed(1) + '%';
        $('subLabel').textContent = '正在建立索引 ' + formatCount(ev.processed) + ' / ' + formatCount(ev.found);
      } else if (ev.phase === 'all-done') {
        if (bar) bar.style.width = '100%';
      }
    });

    document.addEventListener('keydown', (e) => {
      const viewerOpen = window.PhotoViewer.isOpen();
      const videoOpen = window.VideoPlayer.isOpen();
      const typing = /input|textarea|select/i.test(document.activeElement && document.activeElement.tagName);

      if (browserState.open) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (!$('fbPreview').classList.contains('hidden')) closeBrowserPreview();
          else closeFolderBrowser();
        }
        return;
      }

      if (e.key === 'Escape') {
        if (videoOpen) { window.VideoPlayer.close(); return; }
        if (viewerOpen) { window.PhotoViewer.close(); return; }
        if (albumsState.open) { closeAlbums(); return; }
        if (selection.on) { exitSelectMode(); return; }
        if ($('menu').classList.contains('on')) { closeMenu(); return; }
        if ($('sheet').classList.contains('on')) { sheetClose(); return; }
      }

      if (videoOpen) {
        // 视频播放器里只接管空格和左右方向键，其余交给原生控制条
        if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); window.VideoPlayer.togglePlay(); }
        return;
      }

      if (viewerOpen) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); window.PhotoViewer.prev(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); window.PhotoViewer.next(); }
        else if (e.key === 'Delete') {
          const item = window.PhotoViewer.current();
          if (item) deletePhoto(item);
        } else if (e.key === 'a' || e.key === 'A') {
          const item = window.PhotoViewer.current();
          if (item) openAlbumPicker([item.id], '添加到相册');
        } else if (e.key === 'Enter') {
          const item = window.PhotoViewer.current();
          if (item) api.openOriginal(item.id);
        }
        return;
      }

      if (typing) return;

      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); syncSheetFromFilter(); sheetOpen(); }
      else if (e.ctrlKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); openAlbums(); }
      else if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openFolderBrowser(); }
      else if (e.key === 'F5') { e.preventDefault(); refreshAll().then(() => toast('已刷新')); }
      else if (e.ctrlKey && e.key === 'ArrowLeft') { e.preventDefault(); shiftYear(-1); }
      else if (e.ctrlKey && e.key === 'ArrowRight') { e.preventDefault(); shiftYear(1); }
      else if (e.key === 'Home') { window.PhotoGrid.scrollToTop(); }
      else if (e.key === 'End') { window.PhotoGrid.scrollToBottom(); }
    });
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    wire();
    const init = await api.init();
    state.folders = init.folders || [];
    state.settings = init.settings || {};
    state.stats = init.stats;
    state.timeline = init.timeline || [];
    state.versions = init.versions;
    state.albums = init.albums || [];

    state.filter.sort = state.settings.sort || 'taken';
    state.filter.dir = state.settings.dir || 'desc';
    applyTheme(state.settings.theme === 'light' ? 'light' : 'dark', false);

    renderTimeline();
    renderYearSelect();
    renderExtSelect();
    syncSheetFromFilter();

    const counts = new Map();
    for (const y of state.timeline) {
      for (const m of y.months) counts.set(y.year + '-' + String(m.month).padStart(2, '0'), m.count);
    }
    window.PhotoGrid.setMonthCounts(counts);

    await reload();

    if (!state.folders.length) {
      updateEmpty();
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error(err);
      const sub = document.getElementById('subLabel');
      if (sub) sub.textContent = '初始化失败：' + (err && err.message ? err.message : err);
    });
  });
})();