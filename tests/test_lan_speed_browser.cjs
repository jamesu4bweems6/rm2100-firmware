// 独立测速页真实浏览器测试。使用邻传测试服务器；CI 使用原生 ucode + uhttpd。
'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.LAN_TRANSFER_URL || 'http://127.0.0.1:8765/';
const origin = new URL(base).origin;
const shots = process.env.LAN_TRANSFER_SCREENSHOTS;
const errors = [], requests = [];
const MiB = 1048576;

async function done(page) {
  await page.waitForFunction(() => document.querySelector('#speed-panel').dataset.state === 'done', null, { timeout: 45000 });
}
async function stopped(page) {
  await page.waitForFunction(() => document.querySelector('#speed-panel').dataset.state === 'stopped');
  assert.equal(await page.locator('#speed-start').isEnabled(), true);
  assert.equal(await page.locator('#speed-down').textContent(), '—');
  assert.equal(await page.locator('#speed-up').textContent(), '—');
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // 在不支持 WebRTC 的浏览器中也必须可以直接测路由器。
    await context.addInitScript(() => { delete window.RTCPeerConnection; });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => requests.push(r.url()));
    await page.goto(base);
    await page.getByRole('link', { name: '内网测速' }).click();
    assert.equal(new URL(page.url()).pathname, '/speed.html');
    assert.equal(await page.locator('#speed-router').textContent(), new URL(base).host);
    await page.locator('#speed-duration').selectOption('3');
    const replies = [];
    page.on('response', async r => {
      if (!r.url().includes('/cgi-bin/speed?')) return;
      if (r.url().endsWith('a=upload')) {
        try { const data = await r.json(); replies.push(data.bytes); } catch (_) { /* 停止请求会中断响应 */ }
      }
    });
    const firstRequest = requests.length;
    await page.locator('#speed-start').click();
    await done(page);
    for (const dir of ['down', 'up']) {
      const rate = await page.locator(`#speed-${dir}`).textContent();
      assert.match(rate, /^\d+\.\d Mbps$/);
      assert.ok(parseFloat(rate) > 0);
      const detail = await page.locator(`#speed-${dir}-detail`).textContent();
      assert.match(detail, /MB\/s.*MiB.*秒/);
      // 两个单位是同一实际字节计数换算：Mbps = MB/s * 8。
      assert.ok(Math.abs(parseFloat(rate) - parseFloat(detail) * 8) <= 0.15);
      const elapsed = Number(detail.match(/([\d.]+) 秒/)[1]);
      assert.ok(elapsed >= 3, detail);
    }
    assert.match(await page.locator('#speed-latency').textContent(), /^\d+\.\d ms$/);
    const testRequests = requests.slice(firstRequest);
    assert.equal(testRequests.filter(url => url.endsWith('a=ping')).length, 7);
    assert.ok(testRequests.some(url => url.endsWith('a=download')));
    assert.ok(replies.length > 0 && replies.every(n => n === MiB), '所有上传必须由路由器确认实际收到 1 MiB');
    assert.ok(testRequests.every(url => url.startsWith(`${origin}/cgi-bin/speed?`)), '测速不能发现其他设备或请求外部服务');
    if (shots) {
      await fs.mkdir(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, 'speed-desktop.png'), fullPage: true });
    }
    console.log('PASS 单设备真实 HTTP 双向测速、实际上传确认、单位换算、测量时长与同源请求');

    // 测量中取消，并立即重新开始：旧请求不得污染新的结果。
    await page.locator('#speed-start').click();
    await page.waitForFunction(() => document.querySelector('#speed-status').textContent.includes('正在测试下载'));
    await page.locator('#speed-stop').click();
    await stopped(page);
    await page.locator('#speed-start').click();
    await done(page);
    console.log('PASS 下载中停止后可立即重新完成测速');
    await page.locator('#speed-start').click();
    await page.waitForFunction(() => document.querySelector('#speed-status').textContent.includes('正在测试上传'));
    await page.locator('#speed-stop').click();
    await stopped(page);
    console.log('PASS 上传中停止会清除部分结果并恢复按钮');

    await page.route('**/cgi-bin/speed?a=upload', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"bytes":1}' }));
    await page.locator('#speed-start').click();
    await stopped(page);
    assert.match(await page.locator('#speed-status').textContent(), /未完整收到/);
    await page.unroute('**/cgi-bin/speed?a=upload');
    await page.route('**/cgi-bin/speed?a=download', route => route.fulfill({ status: 200, contentType: 'text/html', body: 'wrong service' }));
    await page.locator('#speed-start').click();
    await stopped(page);
    assert.match(await page.locator('#speed-status').textContent(), /下载响应不正确/);
    console.log('PASS 不完整上传确认与错误下载响应不会生成测速结果');
    await page.unroute('**/cgi-bin/speed?a=download');

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const phone = await mobile.newPage();
    phone.on('pageerror', e => errors.push(e.message));
    await phone.goto(new URL('speed.html', base).href);
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机页面不能横向溢出');
    if (shots) await phone.screenshot({ path: path.join(shots, 'speed-mobile.png'), fullPage: true });
    console.log('PASS 手机深色页面布局无横向溢出');
    assert.equal(requests.filter(url => /^https?:/.test(url) && new URL(url).origin !== origin).length, 0);
    assert.deepEqual(errors, [], '浏览器 JavaScript 错误');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
