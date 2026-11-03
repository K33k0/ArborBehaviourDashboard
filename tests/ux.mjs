import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const profile = await mkdtemp(join(tmpdir(), 'dashboard-ux-'));
const browser = spawn(process.env.BROWSER_EXE ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=0',
  '--user-data-dir=' + profile, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Browser startup timed out')), 10000);
    browser.on('error', reject);
    browser.on('exit', code => reject(Error('Browser exited with code ' + code)));
    browser.stderr.on('data', chunk => {
      const match = String(chunk).match(/DevTools listening on ws:\/\/([^/]+)/);
      if (match) { clearTimeout(timeout); resolve('http://' + match[1]); }
    });
  });
  const targets = await (await fetch(endpoint + '/json/list')).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    const request = pending.get(reply.id);
    if (request) {
      pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.error) request.reject(Error(reply.error.message));
      else request.resolve(reply.result);
    }
  });
  function cdp(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 15000);
      pending.set(id, {resolve, reject, timer});
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  async function evaluate(expression) {
    const reply = await cdp('Runtime.evaluate', {expression, returnByValue: true});
    if (reply.exceptionDetails) throw Error(reply.exceptionDetails.text + ': ' + expression);
    return reply.result.value;
  }
  async function until(expression) {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Error('Timed out waiting for ' + expression);
  }
  const failures = [];
  for (const [width, height, zoom] of [
    [1920, 1080, 1], [1366, 768, 1], [1280, 720, 1], [1920, 1080, 1.25], [800, 600, 1], [390, 844, 1]
  ]) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: Math.round(width / zoom), height: Math.round(height / zoom),
      deviceScaleFactor: zoom, mobile: false
    });
    await cdp('Page.navigate', {url: base});
    await until("typeof state !== 'undefined' && !!state.ace?.groups.length && !!state.atl?.groups.length && !!state.attendance_form?.groups.length && !!state.attendance_year?.groups.length");
    await evaluate("if (document.querySelector('#auto-rotate').checked) document.querySelector('#auto-rotate').click()");
    for (const tab of ['ace', 'atl', 'attendance']) {
      await evaluate(`document.querySelector('[data-type="${tab}"]').click()`);
      assert.equal(await evaluate(`document.querySelector('[data-type="${tab}"]').getAttribute('aria-pressed')`), 'true');
      assert.ok(await evaluate("!!document.querySelector('.form-name + .form-value + .bar-track')"));
      const result = await evaluate(`(() => {
        const viewport = document.querySelector('#board-viewport').getBoundingClientRect();
        const rows = [...document.querySelectorAll('.form-row')];
        const footer = document.querySelector('footer').getBoundingClientRect();
        const outside = rect => rect.bottom > viewport.bottom + 1 || rect.right > viewport.right + 1 || rect.top < viewport.top - 1;
        const clipped = rows.filter(row => outside(row.getBoundingClientRect()) ||
          [...row.querySelectorAll('.form-name,.form-value')].some(el => outside(el.getBoundingClientRect()) || el.scrollWidth > el.clientWidth + 1)).length;
        const name = rows[0].querySelector('.form-name');
        const overlappingLabels = [...document.querySelectorAll('.year-board')].filter(board => {
          const firstRow = board.querySelector('.form-row').getBoundingClientRect();
          return [...board.querySelector('.year-label').children].some(child => {
            const rect = child.getBoundingClientRect();
            return rect.left < firstRow.right && rect.right > firstRow.left + 1 &&
              rect.top < firstRow.bottom && rect.bottom > firstRow.top;
          });
        }).length;
        return {rows: rows.length, expected: state[${JSON.stringify(tab === 'attendance' ? 'attendance_form' : tab)}].groups.length,
          clipped, overlappingLabels, footerVisible: footer.bottom <= innerHeight + 1, scale: name.currentCSSZoom,
          namePx: Math.round(parseFloat(getComputedStyle(name).fontSize) * (name.currentCSSZoom || 1) * 10) / 10};
      })()`);
      const label = `${width}x${height} @ ${zoom * 100}% ${tab}`;
      console.log(label, JSON.stringify(result));
      try {
        assert.equal(result.rows, result.expected);
        assert.equal(result.clipped, 0);
        assert.equal(result.overlappingLabels, 0);
        assert.ok(result.footerVisible);
      } catch { failures.push(label); }
      if (process.env.UX_SCREENSHOTS && (width === 1920 || width === 1280 || width === 390)) {
        const shot = await cdp('Page.captureScreenshot', {format: 'png'});
        await writeFile(join(process.env.UX_SCREENSHOTS, label.replaceAll(/[^a-z0-9]+/gi, '-') + '.png'), Buffer.from(shot.data, 'base64'));
      }
    }
    await evaluate("document.querySelector('#rotation-speed').value = '60'; document.querySelector('#rotation-speed').dispatchEvent(new Event('change'))");
    await cdp('Page.reload');
    await until("typeof state !== 'undefined' && state.active === 'attendance' && document.querySelector('#rotation-speed').value === '60' && !document.querySelector('#auto-rotate').checked");
  }
  if (failures.length) {
    console.error('Clipped or overlapping content: ' + failures.join(', '));
    process.exitCode = 1;
  }
  console.log('Preference persistence passed at all six sizes.');
  await until("!!state.attendance_form?.groups.length");
  await evaluate("document.querySelector('#rotation-speed').value = '15'; document.querySelector('#auto-rotate').click()");
  await until("state.active === 'ace'");
  console.log('Timed rotation passed.');
  await evaluate("document.querySelector('#auto-rotate').click()");
  if (process.env.UX_FULLSCREEN === '1') {
    await cdp('Runtime.evaluate', {
      expression: "document.querySelector('#fullscreen').click()", userGesture: true
    });
    await until("!!document.fullscreenElement && document.querySelector('#fullscreen').textContent === 'Exit fullscreen'");
    await evaluate('document.exitFullscreen()');
    await until("!document.fullscreenElement && document.querySelector('#fullscreen').textContent === 'Fullscreen'");
    console.log('Fullscreen toggle passed.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (browser.exitCode === null && browser.pid) {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    browser.stderr.destroy();
    browser.unref();
  }
  await rm(profile, {recursive: true, force: true, maxRetries: 6, retryDelay: 200}).catch(() => {});
}
