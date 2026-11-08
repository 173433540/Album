'use strict';

(() => {
  const splash = document.getElementById('splash');
  if (!splash) return;

  const svg = splash.querySelector('.splash-ink');
  const NS = 'http://www.w3.org/2000/svg';

  const STROKES = [
    // 荧光蓝：从图标下方起笔，沿 N 形折线一路向上
    {
      color: '#22d3ee', w: 12, delay: 0.28, dur: 0.42,
      d: 'M118 226 L118 172 L92 198 L92 146 L66 172 L66 118 L92 92 L118 118 L118 66'
    },
    // 紫色：横向快速来回
    {
      color: '#a855f7', w: 11, delay: 0.55, dur: 0.34,
      d: 'M182 150 L58 138 L180 126 L56 114 L178 102 L60 90 L180 78 L62 66'
    },
    // 玫红：反方向再扫一遍
    {
      color: '#ff2d78', w: 11, delay: 0.78, dur: 0.30,
      d: 'M60 160 L180 172 L62 178 L178 164 L64 150 L176 140'
    },
    // 绿色：对角交错
    {
      color: '#22c55e', w: 11, delay: 0.95, dur: 0.30,
      d: 'M64 66 L176 174 L70 168 L180 72 L82 60 L170 180'
    },
    // 黄色：绕图标一圈
    {
      color: '#facc15', w: 10, delay: 1.10, dur: 0.32,
      d: 'M120 54 C160 54 186 78 186 120 C186 162 160 186 120 186 C80 186 54 162 54 120 C54 78 80 54 120 54'
    },
    // 橙色：中心纵向密集折线
    {
      color: '#fb923c', w: 11, delay: 1.26, dur: 0.28,
      d: 'M92 58 L120 182 L104 60 L132 180 L116 58 L144 182 L128 60 L156 178'
    },
    // 青蓝：横穿中部收密
    {
      color: '#38bdf8', w: 13, delay: 1.42, dur: 0.22,
      d: 'M56 120 L184 116 L58 130 L182 126 L60 108 L180 104'
    },
    // 玫红：最后一笔在图标中央快速划过
    {
      color: '#ff2d78', w: 16, delay: 1.60, dur: 0.20,
      d: 'M64 84 L176 158'
    }
  ];

  // 先铺一层宽而淡的同色笔触做荧光晕，比逐笔 blur 滤镜省很多，滚动/动画更稳
  for (const s of STROKES) {
    const glow = document.createElementNS(NS, 'path');
    glow.setAttribute('d', s.d);
    glow.setAttribute('pathLength', '1');
    glow.setAttribute('stroke', s.color);
    glow.style.strokeWidth = s.w * 2.4 + 'px';
    glow.style.strokeOpacity = '0.2';
    glow.style.setProperty('--dur', s.dur + 's');
    glow.style.setProperty('--delay', s.delay + 's');
    svg.appendChild(glow);
  }

  for (const s of STROKES) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', s.d);
    p.setAttribute('pathLength', '1');
    p.setAttribute('stroke', s.color);
    p.style.strokeWidth = s.w + 'px';
    p.style.setProperty('--dur', s.dur + 's');
    p.style.setProperty('--delay', s.delay + 's');
    svg.appendChild(p);
  }

  const FADE_AT = 2150;
  const FADE_MS = 440;

  let started = false;
  function start() {
    if (started) return;
    started = true;
    requestAnimationFrame(() => splash.classList.add('run'));

    setTimeout(() => {
      splash.classList.add('out');
      setTimeout(() => {
        splash.remove();
        if (window.album && window.album.splashDone) {
          window.album.splashDone(document.documentElement.getAttribute('data-theme') || 'dark');
        }
      }, FADE_MS);
    }, FADE_AT);
  }

  if (document.readyState === 'complete') requestAnimationFrame(start);
  else window.addEventListener('load', () => requestAnimationFrame(start), { once: true });
})();