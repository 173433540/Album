'use strict';

const http = require('node:http');
const WebSocket = require('ws');

const PORT = 9222;

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    try {
      const list = await getJson('/json/list');
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('no target');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails.text);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression, awaitPromise) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const target = await waitForTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await sleep(2500);

  const out = {};
  out.initial = await cdp.eval('({album: window.__albumStats, grid: window.__gridStats, cells: document.querySelectorAll(".cell").length, sub: document.getElementById("subLabel").textContent})');

  // 滚到中间，测量“滚动 + 重排 + 渲染”耗时与 DOM 规模
  out.midScroll = await cdp.eval(`(async () => {
    const sc = document.getElementById('scroller');
    const t0 = performance.now();
    sc.scrollTop = Math.floor((sc.scrollHeight - sc.clientHeight) * 0.5);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      ms: +(performance.now() - t0).toFixed(2),
      cells: document.querySelectorAll('.cell').length,
      headers: document.querySelectorAll('.row-header').length,
      year: document.getElementById('yearLabel').textContent,
      grid: window.__gridStats
    };
  })()`, true);

  // 连续滚动 20 次，统计帧间隔
  out.scrollPerf = await cdp.eval(`(async () => {
    const sc = document.getElementById('scroller');
    const max = sc.scrollHeight - sc.clientHeight;
    const frames = [];
    let last = performance.now();
    for (let i = 0; i < 20; i++) {
      sc.scrollTop = Math.floor(max * (i / 20));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const now = performance.now();
      frames.push(+(now - last).toFixed(1));
      last = now;
    }
    return { frames, maxCells: document.querySelectorAll('.cell').length };
  })()`, true);

  // 无限滚动：滚动到底部应自动追加
  out.infinite = await cdp.eval(`(async () => {
    const sc = document.getElementById('scroller');
    const before = window.PhotoGrid.total();
    sc.scrollTop = sc.scrollHeight;
    await new Promise(r => setTimeout(r, 1200));
    sc.scrollTop = sc.scrollHeight;
    await new Promise(r => setTimeout(r, 1200));
    return { before, after: window.PhotoGrid.total(), grid: window.__gridStats };
  })()`, true);

  // 搜索 2 万条中的关键字
  out.search = await cdp.eval(`(async () => {
    const t0 = performance.now();
    document.getElementById('q').value = 'STRESS_199';
    document.getElementById('q').dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 900));
    return { ms: +(performance.now() - t0).toFixed(0), sub: document.getElementById('subLabel').textContent, cells: document.querySelectorAll('.cell').length };
  })()`, true);

  out.errors = cdp.errors;
  console.log(JSON.stringify(out, null, 2));
  ws.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e); process.exit(1); });