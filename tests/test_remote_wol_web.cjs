// 远程开机网页测试：bemfa.js 纯函数单元测试 + 真实 Chromium 页面测试（模拟巴法云接口，不访问外网）。
// 运行：node tests/test_remote_wol_web.cjs（需要 playwright；NODE_PATH 指向其 node_modules）
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'files', 'www', 'remote-wol');
const W = require(path.join(WEB, 'bemfa.js'));
const UID = '0123456789abcdef0123456789abcdef';
// 巴法云 allTopic 的真实返回格式（2026-11-05 实测，主题名已替换）
const REAL_ALLTOPIC = { code: 0, message: 'OK', data: { data: [{
  topic: 'Ab12Cd34E006', type: 3, share: false, time: '2026-11-05 13:37:10', unix: 1793857030, online: true, name: '电脑',
  room: '', msg: 'on', pubOnline: false, deviceType: 'switch', group: '', createTime: '2026-11-05 13:36:07'
}] } };
// 浏览器测试的接口模拟按真实格式包一层
const wrap = list => ({ code: 0, message: 'OK', data: { data: list } });

function fakeFetch(routes, calls) {
  return async (url, init) => {
    calls && calls.push({ url, init });
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) return { status: 200, json: async () => (typeof body === 'function' ? body(url, init) : body) };
    }
    throw new TypeError('network');
  };
}

async function unit() {
  assert.equal(W.miKind('pc001'), '插座');
  assert.equal(W.miKind('desk006'), '开关');
  assert.equal(W.miKind('pc'), null);
  assert.equal(W.miKind('pc007'), null);
  assert.equal(W.validUid(UID), true);
  assert.equal(W.validUid('bad uid'), false);
  assert.equal(W.validUid(''), false);
  for (const [msg, state] of [['on', 'on'], ['ON ', 'on'], ['on#1', 'on'], ['off', 'off'], ['', 'unknown'], ['hello', 'unknown']])
    assert.equal(W.powerState({ msg }), state, msg);

  const calls = [];
  const topics = await W.listTopics(UID, W.TCP, fakeFetch([['allTopic', {
    code: 0, data: [{ topic: 'pc001', name: '电脑', msg: 'on', online: true, unix: 1700000000 }, { topic: '', msg: 'x' }, { topic: 'nas', online: 'false' }]
  }]], calls));
  assert.deepEqual(topics, [
    { topic: 'pc001', name: '电脑', msg: 'on', online: true, unix: 1700000000 },
    { topic: 'nas', name: '', msg: '', online: false, unix: null }
  ]);
  assert.match(calls[0].url, /\/vb\/api\/v2\/allTopic\?openID=0123456789abcdef0123456789abcdef&type=3$/);
  // 2026-11-05 实测的真实返回（主题名已替换）：data 里还包着一层 data，与官方文档示例不同
  const real = await W.listTopics(UID, W.TCP, fakeFetch([['allTopic', REAL_ALLTOPIC]]));
  assert.deepEqual(real, [{ topic: 'Ab12Cd34E006', name: '电脑', msg: 'on', online: true, unix: 1793857030 }]);
  assert.deepEqual(W.diagnose(real, []).map(i => i.level), ['ok'], '真实格式下设置正确的账号不能误报');
  assert.deepEqual(await W.listTopics(UID, W.TCP, fakeFetch([['allTopic', { code: 0, data: { data: [] } }]])), []);
  assert.deepEqual(await W.listTopics(UID, W.TCP, fakeFetch([['allTopic', { code: 0, data: '' }]])), []);
  // 单独复核主题是否存在
  const probes = [];
  assert.equal(await W.topicExists(UID, 'pc001', fakeFetch([['getmsg', { code: 0, message: 'OK', data: [{ msg: 'on' }] }]], probes)), true);
  assert.equal(probes[0].url, `https://apis.bemfa.com/va/getmsg?uid=${UID}&topic=pc001&type=3`);
  assert.equal(await W.topicExists(UID, 'ghost001', fakeFetch([['getmsg', { code: 40004, message: 'Uid or topic err' }]])), false);
  assert.equal(await W.topicExists(UID, 'pc001', fakeFetch([])), null, '网络错误时不下结论');
  assert.equal(await W.topicExists(UID, 'pc/001', fakeFetch([])), false);
  assert.equal(W.VERSION, 3);
  await assert.rejects(W.listTopics(UID, W.TCP, fakeFetch([['allTopic', { code: -1, msg: '获取失败' }]])), /私钥不正确/);
  await assert.rejects(W.listTopics(UID, W.TCP, fakeFetch([])), /连不上巴法云/);
  await assert.rejects(W.listTopics('bad uid', W.TCP, fakeFetch([])), /私钥/);

  const sent = [];
  assert.equal(await W.wake(UID, 'pc001', fakeFetch([['postJsonMsg', { code: 0, message: 'OK' }]], sent)), true);
  assert.equal(sent[0].url, 'https://apis.bemfa.com/va/postJsonMsg');
  assert.equal(sent[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(sent[0].init.body), { uid: UID, topic: 'pc001', type: 3, msg: 'on' });
  await assert.rejects(W.wake(UID, 'pc001', fakeFetch([['postJsonMsg', { code: 40004, message: 'Uid or topic err' }]])), /Uid or topic err/);
  await assert.rejects(W.wake(UID, 'pc/001', fakeFetch([])), /主题/);

  const levels = items => items.map(i => i.level);
  const empty = W.diagnose([], null);
  assert.equal(empty[0].level, 'error');
  assert.match(empty[0].text, /没有查到主题/);
  const good = W.diagnose([{ topic: 'pc001', name: '电脑', online: true }], []);
  assert.deepEqual(levels(good), ['ok']);
  assert.match(good[0].text, /同步设备/);
  const bad = W.diagnose([{ topic: 'pc', name: '', online: false }, { topic: 'fan003', name: '', online: true }],
    [{ topic: 'light002' }, { topic: 'raw' }]);
  const text = bad.map(i => i.level + ':' + i.text).join('\n');
  assert.match(text, /error:pc：主题名后三位不是/);
  assert.match(text, /warn:pc：路由器没有在线订阅/);
  assert.match(text, /info:fan003：在米家里会显示为「风扇」/);
  assert.match(text, /warn:fan003：没有设置昵称/);
  assert.match(text, /MQTT 设备云里的 light002/);
  assert.doesNotMatch(text, /raw/);
  assert.equal(bad[bad.length - 1].level, 'info', '有错误时总结不标记为正常');
  console.log('PASS bemfa.js：米家设备类型、状态解析、接口参数与错误、诊断规则');
}

function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(WEB, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function browser() {
  let playwright;
  try { playwright = require('playwright'); } catch (e) { console.log('SKIP 浏览器测试：未安装 playwright'); return; }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const b = await playwright.chromium.launch({ headless: true, ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}) });
  try {
    const context = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [], posts = [], external = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => { const u = new URL(r.url()); if (u.origin !== new URL(base).origin && u.host !== 'apis.bemfa.com') external.push(r.url()); });
    let state = 'off';
    await context.route('https://apis.bemfa.com/**', async route => {
      const url = new URL(route.request().url());
      const json = body => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST' } });
      if (url.pathname === '/vb/api/v2/allTopic') {
        if (url.searchParams.get('openID') !== UID) return json({ code: -1, msg: '获取失败', data: '' });
        if (url.searchParams.get('type') === '1') return json(wrap([{ topic: 'light002', msg: 'off' }]));
        return json(wrap([
          { topic: 'pc001', name: '书房电脑', msg: state, online: true, unix: Math.floor(Date.now() / 1000) - 30 },
          { topic: 'nas', name: '<img src=x onerror=alert(1)>', msg: 'off', online: false, unix: 0 }
        ]));
      }
      if (url.pathname === '/va/postJsonMsg') {
        posts.push(JSON.parse(route.request().postData()));
        state = 'on';
        return json({ code: 0, message: 'OK', data: 0 });
      }
      return route.fulfill({ status: 404, body: '' });
    });

    await page.goto(base);
    assert.equal(await page.locator('#pcs-card').isHidden(), true);
    await page.fill('#uid', 'bad uid');
    await page.click('#save');
    await page.waitForFunction(() => document.querySelector('#setup-msg').textContent.includes('只包含字母和数字'));

    // 私钥错误：显示巴法云的错误说明
    await page.fill('#uid', 'ffffffffffffffffffffffffffffffff');
    await page.click('#save');
    await page.waitForFunction(() => document.querySelector('#pcs-msg').textContent.includes('私钥不正确'));

    await page.fill('#uid', UID);
    await page.press('#uid', 'Enter');
    await page.waitForSelector('.pc');
    assert.equal(await page.inputValue('#uid'), '', '保存后不在输入框里明文留着私钥');
    const rows = await page.locator('.pc').allTextContents();
    assert.equal(rows.length, 2);
    assert.match(rows[0], /书房电脑/);
    assert.match(rows[0], /pc001 · 已关机 · 刚刚 · 路由器在线/);
    assert.match(rows[1], /<img src=x onerror=alert\(1\)>/, '主题昵称按文本显示');
    assert.match(rows[1], /路由器离线/);
    assert.equal(await page.locator('.pc img').count(), 0);

    await page.locator('.pc').first().getByRole('button', { name: '开机' }).click();
    await page.waitForFunction(() => document.querySelector('#pcs-msg').textContent.includes('已向「书房电脑」发送开机指令'));
    assert.deepEqual(posts, [{ uid: UID, topic: 'pc001', type: 3, msg: 'on' }]);
    await page.waitForFunction(() => document.querySelector('.pc').textContent.includes('已开机'));
    assert.equal(await page.locator('.pc .dot.on').count(), 1);
    console.log('PASS 网页：保存私钥、列出电脑与状态、发送开机指令后刷新为已开机、昵称不当 HTML');

    await page.click('#check');
    await page.waitForSelector('#diag li');
    const diag = await page.locator('#diag li').allTextContents();
    assert.ok(diag.some(t => /主题名后三位不是/.test(t) && t.includes('nas')), diag.join('\n'));
    assert.ok(diag.some(t => /路由器没有在线订阅/.test(t)), diag.join('\n'));
    assert.ok(diag.some(t => /MQTT 设备云里的 light002/.test(t)), diag.join('\n'));
    assert.ok(diag.some(t => /同步设备/.test(t)), diag.join('\n'));
    console.log('PASS 网页：检查巴法云列出米家不同步、路由器未订阅、MQTT 主题和同步步骤');

    // 重新打开页面仍然记得私钥；清除后不再请求
    await page.reload();
    await page.waitForSelector('.pc');
    assert.match(await page.getAttribute('#uid', 'placeholder'), /已保存/);
    await page.click('#forget');
    assert.equal(await page.locator('#pcs-card').isHidden(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('remote-wol-uid')), null);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机页面不能横向溢出');
    if (process.env.REMOTE_WOL_SCREENSHOTS) {
      fs.mkdirSync(process.env.REMOTE_WOL_SCREENSHOTS, { recursive: true });
      await page.fill('#uid', UID);
      await page.click('#save');
      await page.waitForSelector('.pc');
      await page.click('#check');
      await page.waitForSelector('#diag li');
      await page.screenshot({ path: path.join(process.env.REMOTE_WOL_SCREENSHOTS, 'remote-wol-web.png'), fullPage: true });
    }
    assert.deepEqual(errors, [], '页面不能有脚本错误或 CSP 拦截');
    assert.deepEqual(external, [], '除巴法云外不能请求外部地址');
    console.log('PASS 网页：记住私钥、清除私钥、手机布局、无脚本错误、只访问巴法云');

    await luci(b, base);
  } finally {
    await b.close();
    server.close();
  }
}

// LuCI 页面的开机卡片与「检查巴法云」：在真实浏览器里用最小桩函数加载视图源码
async function luci(b, base) {
  const VIEW = fs.readFileSync(path.join(__dirname, '..', 'files', 'www', 'luci-static', 'resources', 'view', 'remote-wol-v3.js'), 'utf8');
  const BEMFA = fs.readFileSync(path.join(WEB, 'bemfa.js'), 'utf8');
  const context = await b.newContext();
  const page = await context.newPage();
  const errors = [], scripts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/remote-wol/bemfa.js')) scripts.push(r.url()); });
  let mode = 'normal';
  await context.route('https://apis.bemfa.com/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    if (url.pathname === '/va/getmsg') {
      // 单独复核：hidden006 存在（列表里却没有），其余不存在
      const topic = url.searchParams.get('topic');
      return reply(topic === 'hidden006' || topic === 'pc001' ? { code: 0, message: 'OK', data: [{ msg: 'on' }] } : { code: 40004, message: 'Uid or topic err', data: null });
    }
    if (mode === 'listfail' && url.searchParams.get('type') === '3') return reply({ code: -1, msg: '获取失败', data: '' });
    reply(wrap(url.searchParams.get('type') === '3' ? [{ topic: 'pc001', name: '电脑', msg: 'off', online: true }] : []));
  });
  // 模拟浏览器缓存里的 v2.14.0 旧脚本：没有 VERSION
  await context.route('**/remote-wol/bemfa.js*', route => mode === 'stale'
    ? route.fulfill({ status: 200, contentType: 'text/javascript', body: BEMFA.replace(/VERSION, /, '') })
    : route.continue());
  await page.goto(base + 'index.html');
  await page.evaluate(() => {
    document.body.replaceChildren();
    String.prototype.format = function () { let i = 0; const a = arguments; return this.replace(/%s/g, () => String(a[i++])); };
    window.E = (tag, attrs, children) => {
      if (Array.isArray(tag)) { const f = document.createDocumentFragment(); tag.forEach(c => f.append(c)); (attrs || []).forEach(c => f.append(c)); return f; }
      if (Array.isArray(attrs) || typeof attrs === 'string') { children = attrs; attrs = {}; }
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) typeof v === 'function' ? el.addEventListener(k, v) : el.setAttribute(k, v);
      for (const c of [].concat(children == null ? [] : children)) el.append(c instanceof Node ? c : String(c));
      return el;
    };
    window.makeView = source => {
      const conf = window.conf = {
        main: { '.name': 'main', '.type': 'remote-wol', uid: '0123456789abcdef0123456789abcdef', enabled: '1' },
        h1: { '.name': 'h1', '.type': 'host', name: '书房电脑', mac: 'AA:BB:CC:DD:EE:01', topic: 'pc001' },
        h2: { '.name': 'h2', '.type': 'host', name: '<b>NAS</b>', mac: 'AA:BB:CC:DD:EE:02', topic: 'ghost001' },
        h3: { '.name': 'h3', '.type': 'host', name: '停用', mac: 'AA:BB:CC:DD:EE:03', topic: 'off001', enabled: '0' },
        h4: { '.name': 'h4', '.type': 'host', name: '客厅', mac: 'AA:BB:CC:DD:EE:04', topic: 'hidden006' }
      };
      const uci = {
        get: (c, s, o) => (conf[s] || {})[o],
        sections: (c, type, cb) => { const r = Object.values(conf).filter(s => s['.type'] === type); if (cb) r.forEach(cb); return r; }
      };
      window.execs = []; window.notes = [];
      const fs = { exec: (cmd, args) => { window.execs.push([cmd, args]); return Promise.resolve({ code: 0 }); }, read: () => Promise.resolve(null) };
      const ui = { addNotification: (t, el, level) => window.notes.push([level, el.textContent]) };
      const L = { resolveDefault: (p, d) => Promise.resolve(p).catch(() => d), env: {} };
      return new Function('view', 'form', 'uci', 'rpc', 'fs', 'ui', 'poll', 'E', '_', 'L', source)(
        { extend: o => o }, {}, uci, { declare: () => () => Promise.resolve({}) }, fs, ui, { add() {} }, window.E, s => s, L);
    };
    window.check = async source => {
      delete window.RemoteWol;
      const view = window.makeView(source);
      const box = document.createElement('ul'), btn = document.createElement('button');
      await view.checkBemfa(box, btn);
      return { diag: [...box.querySelectorAll('li')].map(li => li.textContent), disabled: btn.disabled };
    };
  });

  const result = await page.evaluate(async source => {
    const view = window.makeView(source);
    const status = { running: true, status: { sync: true, topics: ['pc001', 'ghost001'], hosts: {
      pc001: { online: true, ip: '192.168.1.20' }, ghost001: { online: false, ip: null } } } };
    const table = view.renderPower(status);
    document.body.append(table);
    const rows = [...table.querySelectorAll('tr')].slice(1).map(r => r.textContent);
    table.querySelector('button').click();
    await new Promise(r => setTimeout(r, 50));
    const noSync = view.renderPower({ running: true, status: { sync: false } }).textContent;
    const stopped = view.renderPower({ running: false, status: null }).textContent;
    return { rows, execs: window.execs, notes: window.notes, noSync, stopped, html: table.innerHTML };
  }, VIEW);
  assert.equal(result.rows.length, 3, '停用的电脑不显示');
  assert.match(result.rows[0], /书房电脑已开机（192\.168\.1\.20）AA:BB:CC:DD:EE:01开机/);
  assert.match(result.rows[1], /<b>NAS<\/b>已关机/);
  assert.doesNotMatch(result.html, /<b>NAS<\/b>/, '名称按文本显示');
  assert.deepEqual(result.execs, [['/usr/share/remote-wol/wake', ['AA:BB:CC:DD:EE:01']]]);
  assert.equal(result.notes[0][0], 'info');
  assert.match(result.notes[0][1], /已向“书房电脑”（AA:BB:CC:DD:EE:01）发送开机魔术包/);
  assert.match(result.noSync, /未开启状态同步/);
  assert.match(result.stopped, /未知/);
  console.log('PASS LuCI：开机卡片状态与本地开机、停用电脑隐藏、名称不当 HTML');

  const normal = await page.evaluate(source => window.check(source), VIEW);
  const text = normal.diag.join('\n');
  assert.match(text, /路由器里填的主题 ghost001 在巴法云“TCP 设备云”里不存在/);
  assert.match(text, /主题 hidden006 存在，但没出现在巴法云主题列表接口的结果里/, '列表里没有但单独查得到的主题不能报不存在');
  assert.doesNotMatch(text, /hidden006 在巴法云“TCP 设备云”里不存在/);
  assert.doesNotMatch(text, /pc001 在巴法云/);
  assert.match(text, /同步设备/);
  assert.match(text, /诊断脚本版本 3/);
  assert.doesNotMatch(text, /off001/, '停用的电脑不参与检查');
  assert.equal(normal.disabled, false, '检查结束后恢复按钮');
  assert.ok(scripts.length && scripts.every(u => /bemfa\.js\?t=\d+$/.test(u)), '每次带时间戳加载诊断脚本，避开浏览器缓存：' + scripts.join(' '));

  mode = 'listfail';
  const failed = (await page.evaluate(source => window.check(source), VIEW)).diag.join('\n');
  assert.match(failed, /查询巴法云主题列表失败：获取主题失败/, '列表查询失败要如实显示');
  assert.match(failed, /主题 pc001 存在/, '列表失败时用单独查询确认主题存在');
  assert.doesNotMatch(failed, /pc001 在巴法云“TCP 设备云”里不存在/);
  assert.doesNotMatch(failed, /没有查到主题/, '查询失败不能当成没有主题');

  mode = 'stale';
  const stale = (await page.evaluate(source => window.check(source), VIEW)).diag.join('\n');
  assert.match(stale, /旧版诊断脚本，请按 Ctrl\+F5/);
  assert.deepEqual(errors, []);
  console.log('PASS LuCI：检查巴法云——不存在的主题报错、列表漏掉的主题经复核不误报、列表失败如实显示、旧缓存脚本提示刷新、带时间戳加载');
  await context.close();
}

(async () => {
  await unit();
  await browser();
})().catch(e => { console.error(e); process.exitCode = 1; });
