'use strict';
/* 当前设备 ↔ 路由器。常驻服务复用 TCP 连接；下载按收到字节计数，上传按路由器确认计数。
 * 两条 4 MiB 流水线，路由器仅使用 64 KiB 流式缓冲，不写闪存。 */
(() => {
  const $ = id => document.getElementById(id);
  const CHUNK = 4194304;
  const MiB = 1048576;
  const PARALLEL = 2;
  let active = null;
  $('speed-router').textContent = location.host;
  function check(s) { if (active !== s || s.controller.signal.aborted) throw new DOMException('测速已停止', 'AbortError'); }
  function status(text) { $('speed-status').textContent = text; }
  $('speed-start').disabled = true;
  const ready = (async () => {
    status('正在连接路由器测速服务…');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let response, info;
      try {
        response = await fetch('cgi-bin/speed?a=endpoint', {
          method: 'POST', cache: 'no-store', redirect: 'error',
          headers: { 'Content-Type': 'application/octet-stream' }, body: '', signal: controller.signal
        });
        info = await response.json();
      } finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(info.error || '测速服务未就绪');
      if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || info.chunk !== CHUNK ||
          !Number.isInteger(info.webport) || info.webport < 1 || info.webport > 65535) throw new Error('测速服务配置不正确');
      if (Number(location.port || 80) !== info.port) {
        const target = new URL('speed.html', location.href);
        target.port = info.port; target.search = ''; target.hash = '';
        location.replace(target.href);
        return false;
      }
      $('speed-router').textContent = `${location.hostname}:${info.webport}`;
      document.querySelector('.page-nav').href = `http://${location.hostname}:${info.webport}/`;
      $('speed-start').disabled = false;
      status('已连接路由器 · 点击开始测速');
      return true;
    } catch (e) { status(e.name === 'AbortError' ? '连接测速服务超时，请重新打开测速页面' : e.message); return false; }
  })();
  function showRate(dir, bytes, ms, measured = false) {
    $(`speed-${dir}`).textContent = `${(bytes * 8 / Math.max(1, ms) / 1000).toFixed(1)} Mbps`;
    $(`speed-${dir}-detail`).textContent = `${(bytes / Math.max(1, ms) / 1000).toFixed(2)} MB/s · ${(bytes / MiB).toFixed(1)} MiB${measured ? ` · ${(ms / 1000).toFixed(2)} 秒` : ''}`;
  }
  function reset() {
    for (const key of ['down', 'up', 'latency']) { $(`speed-${key}`).textContent = '—'; $(`speed-${key}-detail`).textContent = ''; }
    $('speed-progress').value = 0;
  }
  async function request(s, action, body = '') {
    check(s);
    const controller = new AbortController();
    const abort = () => controller.abort();
    s.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    // 响应体读完才清理超时，避免收到响应头后无限卡住。
    try {
      const response = await fetch(`speed?a=${action}`, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': 'application/octet-stream' }, body, signal: controller.signal
      });
      if (!response.ok) {
        let reason;
        try { reason = (await response.json()).error; } catch (_) { /* 非 JSON 错误页 */ }
        throw new Error(reason || `路由器返回错误（${response.status}）`);
      }
      if (action === 'download') {
        if (response.headers.get('Content-Type') !== 'application/octet-stream' || Number(response.headers.get('Content-Length')) !== CHUNK)
          throw new Error('测速下载响应不正确，请更新路由器上的测速服务');
        if (!response.body?.getReader) throw new Error('浏览器不支持流式下载，请使用新版系统浏览器');
        const reader = response.body.getReader();
        let received = 0;
        while (true) {
          const part = await reader.read();
          check(s);
          if (part.done) break;
          received += part.value.byteLength;
          if (received > CHUNK) throw new Error('测速下载数据长度不正确');
          if (s.count) s.count.bytes += part.value.byteLength;
        }
        if (received !== CHUNK) throw new Error('测速下载中断，未收到完整数据');
        return received;
      }
      const reply = await response.json();
      if (action === 'upload') {
        if (reply.bytes !== body.byteLength) throw new Error('路由器未完整收到上传数据');
        if (s.count) s.count.bytes += reply.bytes;
      } else if (reply.ok !== true) throw new Error('测速服务响应不正确');
      return reply;
    } catch (e) {
      if (active !== s || s.controller.signal.aborted) throw new DOMException('测速已停止', 'AbortError');
      if (controller.signal.aborted) throw new Error('测速请求超时，请检查与路由器的连接');
      if (e instanceof TypeError) throw new Error('测速服务连接已断开，请从“文件互传”重新打开测速页面');
      throw e;
    } finally { clearTimeout(timer); s.controller.signal.removeEventListener('abort', abort); }
  }
  async function measure(s, dir, seconds, warm) {
    check(s);
    const action = dir === 'down' ? 'download' : 'upload';
    const label = dir === 'down' ? '下载' : '上传';
    status(warm ? `正在预热${label}连接…` : `正在测试${label}…`);
    const count = { bytes: 0, began: performance.now() };
    s.count = warm ? null : count;
    const deadline = count.began + seconds * 1000;
    let painting;
    if (!warm) painting = setInterval(() => {
      if (active !== s) return;
      const elapsed = performance.now() - count.began;
      showRate(dir, count.bytes, elapsed);
      status(`正在测试${label} · ${(elapsed / 1000).toFixed(1)} 秒`);
      $('speed-progress').value = (dir === 'down' ? 0 : 0.5) + Math.min(1, elapsed / (seconds * 1000)) * 0.5;
    }, 250);
    try {
      // 到时停止发新请求，等待两块尾部收到/确认后才结算，避免把发送队列算成速度。
      await Promise.all(Array.from({ length: PARALLEL }, async () => {
        do { await request(s, action, dir === 'up' ? s.payload : ''); check(s); }
        while (performance.now() < deadline);
      }));
      const elapsed = performance.now() - count.began;
      if (!warm) {
        if (!count.bytes) throw new Error('没有收到有效测速数据');
        showRate(dir, count.bytes, elapsed, true);
      }
    } finally { clearInterval(painting); s.count = null; }
  }
  function finish(s, message, done) {
    if (active !== s) return;
    active = null;
    s.controller.abort();
    s.payload = null;
    $('speed-start').disabled = $('speed-duration').disabled = false;
    $('speed-stop').hidden = true;
    $('speed-panel').dataset.state = done ? 'done' : 'stopped';
    if (!done) reset(); else $('speed-progress').value = 1;
    status(message);
  }
  async function start() {
    if (!await ready) return;
    if (active) return;
    const seconds = Number($('speed-duration').value);
    if (![3, 5, 10, 15].includes(seconds)) return;
    const s = { controller: new AbortController(), count: null, payload: new Uint8Array(CHUNK) };
    for (let offset = 0; offset < CHUNK; offset += 65536) crypto.getRandomValues(s.payload.subarray(offset, offset + 65536));
    active = s;
    reset();
    $('speed-panel').dataset.state = 'active';
    $('speed-start').disabled = $('speed-duration').disabled = true;
    $('speed-stop').hidden = false;
    status('正在测量到路由器的往返延迟…');
    try {
      await request(s, 'ping'); // 首次建连不计入延迟
      const samples = [];
      for (let i = 0; i < 6; i++) { const began = performance.now(); await request(s, 'ping'); samples.push(performance.now() - began); }
      samples.sort((a, b) => a - b);
      $('speed-latency').textContent = `${((samples[2] + samples[3]) / 2).toFixed(1)} ms`;
      $('speed-latency-detail').textContent = 'HTTP 往返 · 6 次采样中位数';
      await measure(s, 'down', 1, true);
      await measure(s, 'down', seconds, false);
      await measure(s, 'up', 1, true);
      await measure(s, 'up', seconds, false);
      finish(s, '测速完成 · 当前设备 ↔ 路由器 · 仅内网流量', true);
    } catch (e) { finish(s, e.name === 'AbortError' ? '测速已停止' : e.message, false); }
  }
  $('speed-start').addEventListener('click', start);
  $('speed-stop').addEventListener('click', () => { if (active) finish(active, '测速已停止', false); });
  window.addEventListener('beforeunload', e => { if (active) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('pagehide', () => { if (active) finish(active, '测速已停止', false); });
  if (!window.fetch || !window.AbortController || !window.ReadableStream) {
    $('speed-start').disabled = true;
    status('当前浏览器不支持测速，请使用新版系统浏览器。');
  }
})();
