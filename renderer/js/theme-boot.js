'use strict';

/** 在首帧之前应用上次选择的主题，避免启动时闪一下深色。 */
(function () {
  try {
    if (localStorage.getItem('album-theme') === 'light') {
      document.documentElement.dataset.theme = 'light';
    }
  } catch {
    /* localStorage 不可用时保持默认深色 */
  }
})();