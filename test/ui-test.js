'use strict';

/**
 * 用 Chrome DevTools Protocol 驱动已启动的相册窗口，验证界面与交互。
 * 用法：node test/ui-test.js
 */
const http = require('node:http');
const fs = require('node:fs');
const WebSocket = require('ws');

const PORT = 9222;

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
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
  throw new Error('debugger target not found');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.exceptions = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.console.push(msg.params.type + ': ' + (msg.params.args || []).map((a) => a.value || a.description || a.type).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || ''));
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
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: !!awaitPromise
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception || {}).description);
    return res.result.value;
  }

  async shot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const target = await waitForTarget();
  console.log('TARGET', target.url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  await sleep(1500);

  const report = {};
  report.title = await cdp.eval('document.title');
  report.bg = await cdp.eval('getComputedStyle(document.body).backgroundColor');
  report.yearLabel = await cdp.eval('document.getElementById("yearLabel").textContent');
  report.subLabel = await cdp.eval('document.getElementById("subLabel").textContent');
  report.cells = await cdp.eval('document.querySelectorAll(".cell").length');
  report.headers = await cdp.eval('Array.from(document.querySelectorAll(".row-header span:first-child")).slice(0,4).map(e=>e.textContent)');
  report.gridHeight = await cdp.eval('document.getElementById("grid").style.height');
  report.scrollHeight = await cdp.eval('document.getElementById("scroller").scrollHeight');
  report.viewport = await cdp.eval('[innerWidth, innerHeight]');
  report.timeline = await cdp.eval('Array.from(document.querySelectorAll(".tl-year")).map(e=>e.textContent)');
  report.emptyHidden = await cdp.eval('document.getElementById("empty").classList.contains("hidden")');

  await cdp.shot('C:/AI/PhotoAlbum/test/shot-grid.png');

  // 滚动：验证虚拟化（DOM 数量受控）与年份标题跟随
  await cdp.eval('document.getElementById("scroller").scrollTop = 2600');
  await sleep(700);
  report.afterScroll = {
    cells: await cdp.eval('document.querySelectorAll(".cell").length'),
    yearLabel: await cdp.eval('document.getElementById("yearLabel").textContent'),
    firstVisible: await cdp.eval('(function(){const c=document.querySelectorAll(".cell");return c.length?c[0].title:""})()')
  };
  await cdp.shot('C:/AI/PhotoAlbum/test/shot-scrolled.png');

  // 回到顶部并打开查看器
  await cdp.eval('document.getElementById("scroller").scrollTop = 0');
  await sleep(500);
  await cdp.eval('document.querySelector(".cell").click()');
  await sleep(900);
  report.viewer = {
    open: await cdp.eval('document.getElementById("viewer").classList.contains("on")'),
    name: await cdp.eval('document.getElementById("vName").textContent'),
    meta: await cdp.eval('document.getElementById("vMeta").textContent'),
    naturalW: await cdp.eval('document.getElementById("vImage").naturalWidth'),
    renderedW: await cdp.eval('document.getElementById("vImage").getBoundingClientRect().width'),
    opacity: await cdp.eval('getComputedStyle(document.getElementById("vImage")).opacity')
  };
  await cdp.shot('C:/AI/PhotoAlbum/test/shot-viewer.png');

  // 下一张 + 缩放
  await cdp.eval('document.getElementById("vNext").click()');
  await sleep(800);
  report.viewerAfterNext = {
    name: await cdp.eval('document.getElementById("vName").textContent'),
    index: await cdp.eval('document.querySelector(".v-info").textContent.length')
  };

  const box = await cdp.eval('(function(){const r=document.getElementById("stage").getBoundingClientRect();return [r.width/2,r.height/2]})()');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box[0], y: box[1], deltaX: 0, deltaY: -400 });
  await sleep(400);
  report.zoom = await cdp.eval('document.getElementById("vZoom").textContent + " / " + document.getElementById("viewer").classList.contains("scaled")');
  await cdp.shot('C:/AI/PhotoAlbum/test/shot-zoom.png');

  // 关闭查看器
  await cdp.eval('document.getElementById("vClose").click()');
  await sleep(400);
  report.viewerClosed = await cdp.eval('!document.getElementById("viewer").classList.contains("on")');

  // 搜索面板
  await cdp.eval('document.getElementById("btnSearch").click()');
  await sleep(400);
  report.sheetOpen = await cdp.eval('document.getElementById("sheet").classList.contains("on")');
  await cdp.shot('C:/AI/PhotoAlbum/test/shot-search.png');

  await cdp.eval('document.getElementById("q").value = "IMG_2025"; document.getElementById("q").dispatchEvent(new Event("input"))');
  await sleep(900);
  report.search = {
    cells: await cdp.eval('document.querySelectorAll(".cell").length'),
    total: await cdp.eval('document.getElementById("subLabel").textContent'),
    chips: await cdp.eval('Array.from(document.querySelectorAll("#chips .chip b")).map(e=>e.textContent)')
  };

  await cdp.eval('document.getElementById("btnClearFilter").click()');
  await sleep(800);

  // 时间轴面板 + 跳转
  await cdp.eval('document.querySelector(".tl-year").click()');
  await sleep(400);
  report.tlPanel = await cdp.eval('!document.getElementById("tlPanel").classList.contains("hidden")');
  await cdp.shot('C:/AI/PhotoAlbum/test/shot-timeline.png');
  const monthClicked = await cdp.eval('(function(){const m=document.querySelectorAll("#tlPanel .tl-month");if(!m.length)return null;const t=m[m.length-1].textContent;m[m.length-1].click();return t})()');
  await sleep(1200);
  report.jump = {
    clicked: monthClicked,
    yearLabel: await cdp.eval('document.getElementById("yearLabel").textContent'),
    chips: await cdp.eval('Array.from(document.querySelectorAll("#chips .chip b")).map(e=>e.textContent)'),
    cells: await cdp.eval('document.querySelectorAll(".cell").length')
  };

  // 更多菜单
  await cdp.eval('document.getElementById("btnMore").click()');
  await sleep(300);
  report.menu = await cdp.eval('Array.from(document.querySelectorAll("#menu .menu-item span:first-child")).map(e=>e.textContent)');
  await cdp.shot('C:/AI/PhotoAlbum/test/shot-menu.png');
  await cdp.eval('document.body.click()');

  report.console = cdp.console.slice(-12);
  report.exceptions = cdp.exceptions;

  console.log(JSON.stringify(report, null, 2));
  ws.close();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('UI_TEST_FAILED', err && err.stack ? err.stack : err);
  process.exit(1);
});