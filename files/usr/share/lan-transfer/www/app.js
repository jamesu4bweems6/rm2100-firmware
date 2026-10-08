'use strict';
/* 邻传前端：自动发现同一路由器下的设备，WebRTC 直连传输；直连不通时经路由器分块中转。
 * 没有第三方依赖、没有外部请求：页面、信令和中转都来自路由器本身。 */
(() => {
  const API = 1;
  const MiB = 1048576;
  const HEADER = 4;                  // 直连二进制分包头：u32 批次号
  const SLICE = MiB;                 // 发送端每次从磁盘读 1 MiB
  const RELAY_INFLIGHT = 2;          // 两块上传流水线，隐藏读盘和 HTTP 往返；接收仍顺序确认
  const HIGH_WATER = 8 * MiB;        // DataChannel 发送缓冲上限
  const LOW_WATER = 2 * MiB;
  const CONSOLIDATE = 16 * MiB;      // 接收端每攒 16 MiB 合成 Blob，交给浏览器托管（大文件可落盘）
  const LINK_TIMEOUT = 9000;         // 协商完成后 ICE 仍连不通，这么久后改走中转
  const ANSWER_TIMEOUT = 30000;      // 等对方页面应答（后台标签页 8 秒才轮询一次）
  const ACCEPT_TIMEOUT = 120000;
  const STALL_TIMEOUT = 45000;
  const DONE_TIMEOUT = 60000;
  const BATCH_MAX = 300;
  const TEXT_MAX = 10000;
  const NAME_MAX = 24;
  const TOKEN = /^[0-9a-f]{32}$/;

  // ---------- 小工具 ----------
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
    return node;
  }

  const ICONS = {
    laptop: 'M4.5 6.5A1.5 1.5 0 0 1 6 5h12a1.5 1.5 0 0 1 1.5 1.5V15h-15zM2.5 18.5h19',
    desktop: 'M3.5 5.5A1.5 1.5 0 0 1 5 4h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 16H5a1.5 1.5 0 0 1-1.5-1.5zM9 20h6M12 16v4',
    phone: 'M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2',
    tablet: 'M5.5 3h13A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3zM11 18h2',
    up: 'M12 19V5M6 11l6-6 6 6',
    down: 'M12 5v14M6 13l6 6 6-6',
    text: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4zM8 9h8M8 12h5',
    file: 'M6.5 3h7l4 4v12.5A1.5 1.5 0 0 1 16 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3zM13.5 3v4h4',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    cross: 'M6 6l12 12M18 6L6 18'
  };
  function icon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name] || ICONS.file);
    svg.append(path);
    return cls ? h('span', { class: cls }, svg) : svg;
  }

  function sizeText(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`;
  }
  function durationText(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    if (sec < 60) return `${Math.max(1, Math.round(sec))} 秒`;
    if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
    return `${(sec / 3600).toFixed(1)} 小时`;
  }
  const cleanText = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
  const cleanName = s => cleanText(s, NAME_MAX);
  function safeFileName(s) {
    let name = typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').trim() : '';
    if (!name || name === '.' || name === '..') name = '未命名文件';
    return name.slice(0, 200);
  }
  const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const randomU32 = () => crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  const hex8 = n => (n >>> 0).toString(16).padStart(8, '0');

  function deferred() {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    promise.catch(() => {});
    return { promise, resolve, reject };
  }
  function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
      .finally(() => clearTimeout(timer));
  }

  // CRC-32（与 zlib/ZIP 相同），支持分段累加：crc32(crc32(0, a), b) === crc32(0, a+b)
  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  function crc32(crc, bytes) {
    let c = ~crc;
    for (let i = 0, n = bytes.length; i < n; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  }

  async function readSlice(blob, name) {
    try {
      if (blob.arrayBuffer) return await blob.arrayBuffer();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
      });
    } catch (_) {
      throw new Error(`读取「${name}」失败，文件可能已被移动或修改`);
    }
  }

  // 只给无害类型标 MIME；svg/html 等可含脚本的一律按二进制下载——blob: 链接继承本站源，
  // 被浏览器当文档打开时脚本会在本站运行
  const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    heic: 'image/heic', pdf: 'application/pdf', txt: 'text/plain', mp4: 'video/mp4',
    mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', zip: 'application/zip', apk: 'application/vnd.android.package-archive'
  };
  const extOf = name => (name.match(/\.([a-z0-9]{1,5})$/i) || [])[1]?.toLowerCase() || '';
  const mimeOf = name => MIME[extOf(name)] || 'application/octet-stream';
  const isPreviewable = name => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(extOf(name));

  const storage = {
    get(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (_) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* 隐私模式 */ } },
    sget(key) { try { return sessionStorage.getItem(key); } catch (_) { return null; } },
    sset(key, value) { try { sessionStorage.setItem(key, value); } catch (_) { /* 隐私模式 */ } }
  };

  // ---------- 本机信息 ----------
  function detectDevice() {
    const ua = navigator.userAgent;
    const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    let os = 'Linux', kind = 'desktop';
    if (/HarmonyOS|OpenHarmony/.test(ua)) { os = 'HarmonyOS'; kind = /Mobile|Phone/.test(ua) ? 'phone' : 'tablet'; }
    else if (/iPhone|iPod/.test(ua)) { os = 'iOS'; kind = 'phone'; }
    else if (/iPad/.test(ua) || touchMac) { os = 'iPadOS'; kind = 'tablet'; }
    else if (/Android/.test(ua)) { os = 'Android'; kind = /Mobile/.test(ua) ? 'phone' : 'tablet'; }
    else if (/Windows/.test(ua)) { os = 'Windows'; kind = 'laptop'; }
    else if (/Mac OS X|Macintosh/.test(ua)) { os = 'macOS'; kind = 'laptop'; }
    else if (/CrOS/.test(ua)) { os = 'ChromeOS'; kind = 'laptop'; }
    const browser = /MicroMessenger/.test(ua) ? '微信' : /\bQQ\//.test(ua) ? 'QQ' : /DingTalk/.test(ua) ? '钉钉'
      : /EdgA?\/|EdgiOS/.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /OPR\//.test(ua) ? 'Opera'
      : /Quark/.test(ua) ? '夸克' : /UCBrowser/.test(ua) ? 'UC' : /HuaweiBrowser/.test(ua) ? '华为浏览器'
      : /MiuiBrowser|XiaoMi/.test(ua) ? '小米浏览器' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '浏览器';
    const inApp = /MicroMessenger|\bQQ\/|DingTalk|Weibo|AlipayClient/.test(ua);
    return { kind, os, browser, inApp, mobile: kind === 'phone' || kind === 'tablet' };
  }
  const KIND_TEXT = { phone: '手机', tablet: '平板', laptop: '电脑', desktop: '电脑' };
  function parseDev(value) {
    const [kind, os, browser] = typeof value === 'string' ? value.split('|') : [];
    return { kind: ICONS[kind] ? kind : 'desktop', os: cleanText(os, 20), browser: cleanText(browser, 20) };
  }
  const devLabel = dev => [dev.os || KIND_TEXT[dev.kind], dev.browser].filter(Boolean).join(' · ');

  const COLORS = ['青色', '橙色', '蓝色', '紫色', '金色', '银色', '红色', '绿色', '粉色', '白色', '黑色', '棕色'];
  const ANIMALS = ['海豚', '狐狸', '熊猫', '企鹅', '考拉', '松鼠', '小鹿', '鲸鱼', '海獭', '猫头鹰', '兔子', '柴犬', '仓鼠', '猎豹', '刺猬', '水獭', '羊驼', '浣熊', '海豹', '河马'];
  const pick = list => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];

  const device = detectDevice();
  const RTC = typeof RTCPeerConnection === 'function';
  // 不按设备类型限制文件大小；实际容量由浏览器的 Blob 临时存储和设备剩余空间决定。
  const me = { id: null, key: null, ip: '', name: cleanName(storage.get('lt-name')) || pick(COLORS) + pick(ANIMALS) };
  storage.set('lt-name', me.name);
  const server = { stun: null, chunk: MiB };
  const peers = new Map();
  const links = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  const tiles = new Map();
  const kept = new Set();            // 已结束但仍持有文件的接收记录
  let autoSave = storage.get('lt-autosave', device.os === 'iOS' || device.os === 'iPadOS' ? '0' : '1') === '1';

  // ---------- 与路由器通信 ----------
  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  async function post(body, { query = '', binary = null, timeout = 15000, keepalive = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      return await fetch('cgi-bin/api' + query, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin', signal: ctrl.signal, keepalive,
        headers: { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
        body: binary || JSON.stringify(body)
      });
    } catch (e) {
      throw new ApiError(0, e.name === 'AbortError' ? '连接路由器超时' : '无法连接路由器');
    } finally {
      clearTimeout(timer);
    }
  }
  async function errorOf(res) {
    let message = '';
    try { message = (await res.json()).error; } catch (_) { /* 非 JSON 应答 */ }
    return new ApiError(res.status, typeof message === 'string' && message ? message : `路由器返回错误（${res.status}）`);
  }
  async function call(action, payload = {}, opts) {
    const res = await post({ a: action, id: me.id, key: me.key, ...payload }, opts);
    if (!res.ok) throw await errorOf(res);
    return res.json();
  }
  // 信令投递（offer/answer/bye）：偶发的网络抖动或 CGI 排队超时不能让整次
  // 直连协商白等 30 秒 —— 按 lid 去重是幂等的，短间隔重试两次即可
  async function sendSignal(peerId, data) {
    for (let attempt = 0; ; attempt++) {
      try {
        await call('send', { to: peerId, k: 'sig', d: data });
        return;
      } catch (e) {
        if (attempt >= 2 || e.status === 401 || e.status === 404) throw e;
        await sleep(600 * (attempt + 1));
      }
    }
  }

  // ---------- 设备发现（短轮询） ----------
  let pollTimer = 0, polling = false, fastUntil = 0, failures = 0;
  let lastAck = Number(storage.sget('lt-ack')) || 0;
  const devString = `${device.kind}|${device.os}|${device.browser}`;

  async function hello() {
    let saved = null;
    try { saved = JSON.parse(storage.sget('lt-session') || 'null'); } catch (_) { saved = null; }
    const r = await call('hello', { id: saved?.id, key: saved?.key, name: me.name, dev: devString, rtc: RTC ? 1 : 0, max: 0 });
    if (!TOKEN.test(r.id) || !TOKEN.test(r.key)) throw new ApiError(0, '路由器返回了无效的会话');
    if (r.id !== saved?.id) { lastAck = 0; storage.sset('lt-ack', '0'); }
    me.id = r.id; me.key = r.key; me.ip = typeof r.ip === 'string' ? r.ip : '';
    server.chunk = Number.isInteger(r.chunk) && r.chunk > 0 ? r.chunk : MiB;
    server.stun = Number.isInteger(r.stun) ? r.stun : null;
    storage.sset('lt-session', JSON.stringify({ id: r.id, key: r.key }));
    if (r.v !== API) showBanner('互传服务已更新，请刷新页面后再使用。', '刷新', () => location.reload());
    renderMe();
  }

  function pollDelay() {
    if (failures) return Math.min(10000, 1500 * failures);
    if (document.hidden) return 8000;
    return Date.now() < fastUntil ? 400 : 2000;
  }
  function schedule(delay = pollDelay()) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }
  // 有信令或中转控制消息在路上时加快轮询
  function hurry(ms = 12000) {
    fastUntil = Math.max(fastUntil, Date.now() + ms);
    if (!polling) schedule(150);
  }

  async function poll() {
    if (polling) return;
    polling = true;
    let delay = null;
    try {
      if (!me.id) await hello();
      const r = await call('poll', { ack: lastAck });
      failures = 0;
      setOnline(true);
      server.stun = Number.isInteger(r.stun) ? r.stun : null;
      syncPeers(Array.isArray(r.peers) ? r.peers : []);
      for (const m of Array.isArray(r.msgs) ? r.msgs : []) {
        if (!m || !Number.isInteger(m.n) || m.n <= lastAck) continue;
        lastAck = m.n;
        storage.sset('lt-ack', String(lastAck));
        try { onMail(m); } catch (e) { console.warn('lan-transfer: 消息处理失败', e); }
      }
    } catch (e) {
      if (e.status === 401) {
        // 页面长时间在后台被判离线：换一个新身份重新上线
        me.id = me.key = null;
        storage.sset('lt-session', '');
        delay = 100;
      } else {
        failures++;
        if (failures >= 2) setOnline(false, e.message);
      }
    } finally {
      polling = false;
      schedule(delay ?? pollDelay());
    }
  }

  function onMail(m) {
    if (!TOKEN.test(m.f)) return;
    if (m.k === 'sig') linkFor(m.f).onSignal(m.d);
    else if (m.k === 'ctl') onControl(m.f, m.d, 'relay');
    else if (m.k === 'txt') onText(m.f, m.d);
  }

  function syncPeers(list) {
    const seen = new Set();
    for (const p of list) {
      if (!p || !TOKEN.test(p.id) || p.id === me.id) continue;
      seen.add(p.id);
      const peer = peers.get(p.id) || { id: p.id, since: Number(p.since) || 0 };
      peer.name = cleanName(p.name) || '未命名设备';
      peer.dev = parseDev(p.dev);
      peer.rtc = p.rtc === 1;
      peer.max = Number.isSafeInteger(p.max) && p.max > 0 ? p.max : 0;
      peer.same = p.same === 1;
      peers.set(p.id, peer);
    }
    for (const id of [...peers.keys()]) if (!seen.has(id)) peers.delete(id);
    renderPeers();
  }

  // ---------- 直连（WebRTC DataChannel） ----------
  function linkFor(id) {
    let link = links.get(id);
    if (!link) { link = new Link(id); links.set(id, link); }
    return link;
  }

  async function localSdp(pc, kind) {
    const desc = kind === 'offer' ? await pc.createOffer() : await pc.createAnswer();
    await pc.setLocalDescription(desc);
    // 不做 trickle：等候选地址收集完（最多 2.5 秒）再一次性通过路由器转交
    if (pc.iceGatheringState !== 'complete') {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
        const check = () => { if (pc.iceGatheringState === 'complete') done(); };
        const timer = setTimeout(done, 2500);
        pc.addEventListener('icegatheringstatechange', check);
      });
    }
    return { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
  }
  const isDesc = (d, type) => d && d.type === type && typeof d.sdp === 'string' && d.sdp.length < 60000;

  class Link {
    constructor(peerId) {
      this.peerId = peerId;
      this.pc = null;
      this.dc = null;
      this.lid = null;
      this.role = null;
      this.connecting = null;
      this.failedAt = 0;
      this.progressAt = 0;
      this.packet = 16384;
      this.waiters = new Set();
    }
    get open() { return !!this.dc && this.dc.readyState === 'open'; }
    get busy() { return !!this.connecting && !this.open; }

    // 建立直连；成功返回 true，失败或不可用返回 false（调用方改走中转）
    connect() {
      if (this.open) return Promise.resolve(true);
      if (!this.connecting) {
        this.connecting = this.start().finally(() => { this.connecting = null; renderPeers(); });
        renderPeers();
      }
      return this.connecting;
    }
    async start() {
      const peer = peers.get(this.peerId);
      if (!RTC || (peer && !peer.rtc)) return false;
      // 一分钟内刚直连失败过：直接中转，免得每次多等
      if (Date.now() - this.failedAt < 60000) return false;
      // 对方发起的连接正在建立：等它，别拆掉重来
      if (this.pc && this.role === 'answer') return this.settle(Date.now());
      this.teardown();
      const lid = randomHex(8);
      this.lid = lid;
      this.role = 'offer';
      let pc;
      try {
        pc = this.createPeer();
        this.attach(pc.createDataChannel('lt', { ordered: true }));
        const sdp = await localSdp(pc, 'offer');
        if (this.pc === pc) {
          await sendSignal(this.peerId, { t: 'offer', lid, sdp });
          hurry(ANSWER_TIMEOUT);
        }
      } catch (e) {
        // 期间被对方的 offer 取代（双方同时发起）时 pc 已换新，继续等对方发起的连接
        if (this.pc === pc) {
          this.teardown();
          this.failedAt = Date.now();
          return false;
        }
      }
      const ok = await this.settle(Date.now());
      if (!ok && this.lid === lid && !this.open) {
        this.teardown();
        sendSignal(this.peerId, { t: 'bye', lid }).catch(() => {});
      }
      return ok;
    }
    // 对方还没应答时最多等 ANSWER_TIMEOUT（对方页面在后台时轮询慢）；
    // 协商有了进展（收到应答或已经应答）仍连不通，LINK_TIMEOUT 后放弃，改走中转
    async settle(began) {
      while (!this.open && this.pc) {
        const limit = this.progressAt ? this.progressAt + LINK_TIMEOUT : began + ANSWER_TIMEOUT;
        const left = limit - Date.now();
        if (left <= 0) break;
        await this.waitOpen(Math.min(1000, left));
      }
      if (!this.open) this.failedAt = Date.now();
      return this.open;
    }
    waitOpen(ms) {
      if (this.open) return Promise.resolve(true);
      return new Promise(resolve => {
        const done = ok => { clearTimeout(timer); this.waiters.delete(done); resolve(ok); };
        const timer = setTimeout(() => done(this.open), ms);
        this.waiters.add(done);
      });
    }
    createPeer() {
      const iceServers = server.stun ? [{ urls: `stun:${location.hostname}:${server.stun}` }] : [];
      const pc = new RTCPeerConnection({ iceServers });
      this.pc = pc;
      pc.onconnectionstatechange = () => {
        if (this.pc !== pc) return;
        if (pc.connectionState === 'failed') this.teardown('直连中断');
        else if (pc.connectionState === 'disconnected') {
          // Wi-Fi 短暂抖动会先进 disconnected，给 6 秒恢复
          clearTimeout(this.grace);
          this.grace = setTimeout(() => {
            if (this.pc === pc && pc.connectionState !== 'connected') this.teardown('直连中断');
          }, 6000);
        }
      };
      pc.ondatachannel = e => {
        if (this.pc === pc && !this.dc) this.attach(e.channel);
        else e.channel.close();
      };
      return pc;
    }
    attach(dc) {
      this.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = LOW_WATER;
      dc.onopen = () => {
        if (this.dc !== dc) return;
        const max = this.pc && this.pc.sctp ? this.pc.sctp.maxMessageSize : 0;
        this.packet = Math.max(16384, Math.min(65536, max || 16384));
        this.failedAt = 0;
        for (const done of [...this.waiters]) done(true);
        renderPeers();
      };
      dc.onclose = () => { if (this.dc === dc) this.teardown('直连中断'); };
      dc.onmessage = e => {
        try { onChannelMessage(this, e.data); } catch (err) { console.warn('lan-transfer: 直连消息处理失败', err); }
      };
    }
    async onSignal(d) {
      if (!d || typeof d !== 'object' || typeof d.lid !== 'string') return;
      if (d.t === 'offer') {
        if (!RTC || !isDesc(d.sdp, 'offer')) return;
        // 双方同时发起：编号小的一方保留自己的 offer，另一方放弃并应答
        if (this.role === 'offer' && this.pc && !this.open && me.id < this.peerId) return;
        this.teardown(this.open ? '对方重新连接' : null);
        this.lid = d.lid;
        this.role = 'answer';
        let pc;
        try {
          pc = this.createPeer();
          await pc.setRemoteDescription(d.sdp);
          const sdp = await localSdp(pc, 'answer');
          if (this.pc !== pc) return;
          await sendSignal(this.peerId, { t: 'answer', lid: d.lid, sdp });
          this.progressAt = Date.now();
          hurry(LINK_TIMEOUT);
        } catch (e) {
          if (this.pc === pc) this.teardown();
        }
      } else if (d.t === 'answer') {
        if (d.lid !== this.lid || this.role !== 'offer' || !this.pc || this.pc.signalingState !== 'have-local-offer' || !isDesc(d.sdp, 'answer')) return;
        try {
          await this.pc.setRemoteDescription(d.sdp);
          this.progressAt = Date.now();
        } catch (e) {
          this.teardown();
        }
      } else if (d.t === 'bye') {
        if (d.lid === this.lid && !this.open) this.teardown();
      }
    }
    send(msg) {
      if (!this.open) throw new Error('直连已断开');
      this.dc.send(JSON.stringify(msg));
    }
    teardown(reason) {
      const { pc, dc } = this;
      this.pc = this.dc = null;
      this.role = null;
      this.progressAt = 0;
      clearTimeout(this.grace);
      if (dc) {
        dc.onopen = dc.onclose = dc.onmessage = null;
        try { dc.close(); } catch (_) { /* 已关闭 */ }
      }
      if (pc) {
        pc.onconnectionstatechange = pc.ondatachannel = null;
        try { pc.close(); } catch (_) { /* 已关闭 */ }
      }
      if (reason) {
        for (const t of outgoing.values()) if (t.peerId === this.peerId && t.via === 'p2p') t.end('failed', `${reason}，请重试`);
        for (const t of incoming.values()) if (t.peerId === this.peerId && t.via === 'p2p') t.fail(`${reason}，未完成的文件已丢弃`, false);
      }
      renderPeers();
    }
  }

  function onChannelMessage(link, data) {
    if (typeof data === 'string') {
      if (data.length > 200000) return;
      let msg = null;
      try { msg = JSON.parse(data); } catch (_) { return; }
      onControl(link.peerId, msg, 'p2p');
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER) return;
    const bid = new DataView(data).getUint32(0);
    const t = incoming.get(`${link.peerId}:${bid}`);
    if (t && t.via === 'p2p') t.onBytes(new Uint8Array(data, HEADER));
  }

  // 发送方 → 接收方：offer / eof / stop；接收方 → 发送方：accept / reject / got / done / cancel
  function onControl(from, msg, via) {
    if (!msg || typeof msg !== 'object' || !Number.isInteger(msg.bid)) return;
    if (msg.t === 'offer') return onOffer(from, msg, via);
    if (['accept', 'reject', 'got', 'done', 'cancel'].includes(msg.t)) {
      const t = outgoing.get(msg.bid);
      if (t && t.peerId === from && t.via === via) t.onControl(msg);
      return;
    }
    const t = incoming.get(`${from}:${msg.bid}`);
    if (t && t.via === via) t.onControl(msg);
  }

  function onOffer(from, msg, via) {
    const key = `${from}:${msg.bid}`;
    if (incoming.has(key) || !Array.isArray(msg.files) || !msg.files.length || msg.files.length > BATCH_MAX) return;
    if (via !== msg.via) return;
    if (via === 'relay' && (!TOKEN.test(msg.rid) || !Number.isInteger(msg.chunk) || msg.chunk < 1)) return;
    const files = [];
    let total = 0;
    for (const f of msg.files) {
      if (!f || typeof f.name !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0) return;
      files.push({ name: safeFileName(f.name), size: f.size });
      total += f.size;
      if (!Number.isSafeInteger(total)) return;
    }
    const t = new Incoming(from, msg, via, files, total);
    queuePrompt(t);
  }

  // ---------- 传输卡片（进度渲染节流到每 200ms 一次） ----------
  const dirty = new Set();
  let paintQueued = false;
  function markDirty(t) {
    dirty.add(t);
    if (!paintQueued) {
      paintQueued = true;
      setTimeout(() => requestAnimationFrame(() => {
        paintQueued = false;
        const list = [...dirty];
        dirty.clear();
        for (const item of list) item.paint();
        renderPeerProgress();
      }), 200);
    }
  }

  class Speed {
    start() { this.samples = [[performance.now(), 0]]; this.bytes = 0; this.rate = 0; }
    add(n) {
      this.bytes += n;
      const now = performance.now(), last = this.samples[this.samples.length - 1];
      if (now - last[0] < 500) return;
      this.samples.push([now, this.bytes]);
      if (this.samples.length > 8) this.samples.shift();
      const first = this.samples[0];
      this.rate = (this.bytes - first[1]) / Math.max(0.001, (now - first[0]) / 1000);
    }
  }

  function makeCard(dir) {
    const title = h('strong'), meta = h('span', { class: 'xfer-meta' });
    const actions = h('div', { class: 'xfer-actions' });
    const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('i'));
    const status = h('p', { class: 'xfer-status' });
    const list = h('ul', { class: 'xfer-files' });
    const card = h('article', { class: `xfer ${dir}`, 'data-dir': dir },
      h('div', { class: 'xfer-head' }, icon(dir === 'out' ? 'up' : 'down', 'xfer-icon'), h('div', { class: 'xfer-title' }, title, meta), actions),
      bar, status, list);
    $('transfers').prepend(card);
    $('history').hidden = false;
    return { card, title, meta, actions, bar, status, list, rows: [] };
  }

  function fileRows(ui, files) {
    const shown = 6;
    ui.list.replaceChildren();
    ui.rows = files.map((file, i) => {
      const thumb = h('span', { class: 'thumb' }, icon('file'));
      const state = h('span', { class: 'fstate' });
      const extra = h('span', { class: 'fextra' });
      const li = h('li', { hidden: i >= shown }, thumb, h('span', { class: 'fname', text: file.name }), h('span', { class: 'fsize', text: sizeText(file.size) }), state, extra);
      ui.list.append(li);
      return { li, thumb, state, extra };
    });
    if (files.length > shown) {
      const more = h('button', { class: 'btn ghost small more', type: 'button', text: `展开全部 ${files.length} 个文件` });
      more.addEventListener('click', () => { for (const row of ui.rows) row.li.hidden = false; more.remove(); });
      ui.list.after(more);
    }
  }

  function paintProgress(ui, done, total, speed, label) {
    const ratio = total ? Math.min(1, done / total) : 1;
    ui.bar.firstChild.style.transform = `scaleX(${ratio})`;
    ui.bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    const parts = [`${label} ${sizeText(done)} / ${sizeText(total)}`];
    if (speed.rate > 0) {
      parts.push(`${sizeText(speed.rate)}/s`);
      const eta = durationText((total - done) / speed.rate);
      if (eta) parts.push(`剩余约 ${eta}`);
    }
    ui.status.textContent = parts.join(' · ');
  }

  function viaText(via) {
    return via === 'p2p' ? '直连' : via === 'relay' ? '经路由器中转' : '';
  }

  async function relayClosed(transfer) {
    // 对方取消时，删除分块的 HTTP 请求可能比邮箱中的 stop/cancel 先到。
    // 等终止消息决定状态，避免把主动取消误标成失败；后台轮询最长 8 秒。
    hurry(12000);
    const deadline = Date.now() + 10000;
    while (!transfer.ended && Date.now() < deadline) await sleep(100);
    throw new Error('对方已取消或离开');
  }

  // ---------- 发送 ----------
  class Outgoing {
    constructor(peer, files) {
      this.peerId = peer.id;
      this.peerName = peer.name;
      do { this.bid = randomU32(); } while (outgoing.has(this.bid));
      this.files = files;
      this.total = files.reduce((sum, f) => sum + f.size, 0);
      this.sent = 0;
      this.via = null;
      this.rid = null;
      this.chunk = server.chunk;
      this.seq = 0;
      this.phase = 'connect';
      this.ended = false;
      this.waits = { accept: deferred(), done: deferred() };
      this.speed = new Speed();
      this.ui = makeCard('out');
      this.ui.card.dataset.state = 'active';
      this.ui.title.textContent = `发给 ${peer.name}`;
      fileRows(this.ui, files);
      this.renderMeta();
      this.buttons();
      outgoing.set(this.bid, this);
      this.status('正在连接…');
      this.run();
    }
    renderMeta() {
      this.ui.meta.textContent = [`${this.files.length} 个文件`, sizeText(this.total), viaText(this.via)].filter(Boolean).join(' · ');
    }
    status(text) { this.ui.status.textContent = text; }
    buttons() {
      const { actions } = this.ui;
      actions.replaceChildren();
      if (!this.ended) {
        actions.append(h('button', { class: 'btn ghost small danger', type: 'button', onclick: () => this.cancel() }, '取消'));
      } else if (this.endState !== 'done' && peers.has(this.peerId)) {
        actions.append(h('button', { class: 'btn small', type: 'button', onclick: () => { actions.replaceChildren(); sendFiles(this.peerId, this.files); } }, '重新发送'));
      }
    }
    check() {
      if (this.ended) throw new Error(this.endText || '已取消');
    }
    async control(msg) {
      if (this.via === 'p2p') {
        linkFor(this.peerId).send(msg);
      } else {
        await call('send', { to: this.peerId, k: 'ctl', d: msg });
        hurry();
      }
    }
    async run() {
      const hint = setTimeout(() => {
        if (this.phase === 'connect' && !this.ended) this.status('等待对方页面响应…请让对方把邻传页面切到前台');
      }, 6000);
      try {
        const direct = await linkFor(this.peerId).connect().finally(() => clearTimeout(hint));
        this.check();
        this.via = direct ? 'p2p' : 'relay';
        if (!direct) {
          this.status('无法直连，改为经路由器中转…');
          const r = await call('ropen', { to: this.peerId });
          this.check();
          this.rid = r.rid;
          this.chunk = Number.isInteger(r.chunk) && r.chunk > 0 ? r.chunk : server.chunk;
        }
        this.renderMeta();
        this.phase = 'offer';
        this.status(`等待 ${this.peerName} 接收…`);
        await this.control({
          t: 'offer', bid: this.bid, via: this.via, rid: this.rid, chunk: this.chunk, name: me.name,
          files: this.files.map(f => ({ name: f.name, size: f.size }))
        });
        await withTimeout(this.waits.accept.promise, ACCEPT_TIMEOUT, '对方一直没有回应，已取消');
        this.phase = 'send';
        this.speed.start();
        for (let i = 0; i < this.files.length; i++) {
          this.row(i, 'active');
          await (this.via === 'p2p' ? this.sendDirect(i) : this.sendRelay(i));
        }
        this.phase = 'confirm';
        this.status('等待对方确认…');
        await withTimeout(this.waits.done.promise, DONE_TIMEOUT, '对方没有确认收到');
        for (let i = 0; i < this.files.length; i++) this.row(i, 'done');
        this.end('done', `已送达 ${this.files.length} 个文件`);
      } catch (e) {
        this.end('failed', e.message || '发送失败');
      }
    }
    async sendDirect(i) {
      const file = this.files[i], link = linkFor(this.peerId), dc = link.dc;
      if (!link.open) throw new Error('直连已断开，请重试');
      const payload = link.packet - HEADER;
      let crc = 0;
      for (let offset = 0; offset < file.size;) {
        const buf = new Uint8Array(await readSlice(file.slice(offset, offset + SLICE), file.name));
        this.check();
        if (dc.readyState !== 'open') throw new Error('直连已断开，请重试');
        if (!buf.length) throw new Error(`读取「${file.name}」失败`);
        crc = crc32(crc, buf);
        for (let p = 0; p < buf.length; p += payload) {
          if (dc.bufferedAmount > HIGH_WATER) await drain(dc);
          this.check();
          const part = buf.subarray(p, p + payload);
          const packet = new Uint8Array(HEADER + part.length);
          new DataView(packet.buffer).setUint32(0, this.bid);
          packet.set(part, HEADER);
          dc.send(packet);
          this.progress(part.length);
        }
        offset += buf.length;
      }
      link.send({ t: 'eof', bid: this.bid, i, crc });
    }
    async sendRelay(i) {
      const file = this.files[i];
      const pending = [];
      let crc = 0;
      try {
        for (let offset = 0; offset < file.size;) {
          if (pending.length >= RELAY_INFLIGHT) await pending.shift();
          this.check();
          const buf = new Uint8Array(await readSlice(file.slice(offset, offset + this.chunk), file.name));
          this.check();
          if (!buf.length) throw new Error(`读取「${file.name}」失败`);
          crc = crc32(crc, buf);
          // 序号在发起请求前固定；重试不能读到下一块的序号。
          const upload = this.put(buf, offset + buf.length >= file.size ? crc : null, this.seq++)
            .then(() => { this.check(); this.progress(buf.length); });
          upload.catch(() => {});  // 后一块可能先失败，排到它时再传播错误
          pending.push(upload);
          offset += buf.length;
        }
        await Promise.all(pending);
      } finally {
        // 失败/取消时收拢在途请求，避免未处理的 rejection。
        await Promise.allSettled(pending);
      }
    }
    async put(buf, crc, seq) {
      const query = `?a=put&id=${me.id}&key=${me.key}&r=${this.rid}&n=${seq}` + (crc === null ? '' : `&c=${hex8(crc)}`);
      const since = Date.now();
      for (let attempt = 0; ;) {
        this.check();
        let res;
        try {
          res = await post(null, { query, binary: buf, timeout: 60000 });
        } catch (e) {
          if (++attempt > 4) throw e;
          await sleep(800 * attempt);
          continue;
        }
        if (res.ok) return;
        if (res.status === 429 || res.status === 503) {
          if (Date.now() - since > STALL_TIMEOUT) throw new Error('对方长时间没有接收，已停止');
          await sleep(150);
          continue;
        }
        if (res.status === 404) await relayClosed(this);
        throw await errorOf(res);
      }
    }
    progress(n) {
      this.sent += n;
      this.speed.add(n);
      markDirty(this);
    }
    paint() {
      if (this.ended || this.phase !== 'send') return;
      paintProgress(this.ui, this.sent, this.total, this.speed, '发送中');
    }
    row(i, state) {
      const row = this.ui.rows[i];
      if (!row) return;
      row.state.replaceChildren(state === 'done' ? icon('check') : '');
      row.li.classList.toggle('active', state === 'active');
    }
    onControl(msg) {
      if (this.ended) return;
      if (msg.t === 'accept' && this.phase === 'offer') {
        this.waits.accept.resolve();
      } else if (msg.t === 'reject') {
        const reason = cleanText(msg.reason, 100);
        this.end('rejected', reason ? `对方拒绝了：${reason}` : '对方拒绝了接收');
      } else if (msg.t === 'got' && Number.isInteger(msg.i)) {
        this.row(msg.i, 'done');
      } else if (msg.t === 'done') {
        this.waits.done.resolve();
      } else if (msg.t === 'cancel') {
        this.end('cancelled', '对方取消了接收');
      }
    }
    cancel() {
      if (this.ended) return;
      if (this.phase !== 'connect') Promise.resolve().then(() => this.control({ t: 'stop', bid: this.bid })).catch(() => {});
      this.end('cancelled', '已取消');
    }
    end(state, text) {
      if (this.ended) return;
      this.ended = true;
      this.endState = state;
      this.endText = text;
      this.waits.accept.reject(new Error(text));
      this.waits.done.reject(new Error(text));
      if (this.rid) call('rclose', { r: this.rid }).catch(() => {});
      outgoing.delete(this.bid);
      dirty.delete(this);
      this.ui.card.dataset.state = state;
      if (state === 'done') {
        this.ui.bar.firstChild.style.transform = 'scaleX(1)';
        this.ui.bar.setAttribute('aria-valuenow', '100');
      }
      this.status(text);
      this.buttons();
      renderPeerProgress();
      toast(`${this.peerName}：${text}`, state === 'failed' || state === 'rejected');
    }
  }

  function drain(dc) {
    return new Promise((resolve, reject) => {
      const finish = err => {
        clearTimeout(timer);
        dc.removeEventListener('bufferedamountlow', low);
        dc.removeEventListener('close', closed);
        if (err) reject(err); else resolve();
      };
      const low = () => finish();
      const closed = () => finish(new Error('直连已断开，请重试'));
      const timer = setTimeout(() => finish(new Error('发送停滞，连接可能已中断')), STALL_TIMEOUT);
      dc.addEventListener('bufferedamountlow', low);
      dc.addEventListener('close', closed);
      if (dc.bufferedAmount <= LOW_WATER) finish();
    });
  }

  function sendFiles(peerId, list) {
    const peer = peers.get(peerId);
    if (!peer) return toast('对方已经离开', true);
    let files = Array.from(list).filter(f => f instanceof Blob && typeof f.name === 'string');
    if (!files.length) return;
    if (files.length > BATCH_MAX) {
      toast(`一次最多发送 ${BATCH_MAX} 个文件，已选前 ${BATCH_MAX} 个`, true);
      files = files.slice(0, BATCH_MAX);
    }
    const total = files.reduce((sum, f) => sum + f.size, 0);
    if (!Number.isSafeInteger(total)) return toast('文件总大小无法准确表示，请分批发送', true);
    if (peer.max && total > peer.max) {
      toast(`${peer.name} 的页面仍限制接收 ${sizeText(peer.max)}，请让对方刷新到新版后再发送`, true);
      return;
    }
    new Outgoing(peer, files);
  }

  // ---------- 接收 ----------
  class Incoming {
    constructor(peerId, msg, via, files, total) {
      this.peerId = peerId;
      this.bid = msg.bid;
      this.key = `${peerId}:${msg.bid}`;
      this.via = via;
      this.rid = via === 'relay' ? msg.rid : null;
      this.chunk = msg.chunk;
      this.files = files;
      this.total = total;
      this.peerName = peers.get(peerId)?.name || cleanName(msg.name) || '对方';
      this.state = 'ask';
      this.ended = false;
      this.received = 0;
      this.cur = 0;
      this.fileBytes = 0;
      this.crc = 0;
      this.pending = [];
      this.pendingBytes = 0;
      this.parts = [];
      this.speed = new Speed();
      incoming.set(this.key, this);
      this.ui = makeCard('in');
      this.ui.card.dataset.state = 'ask';
      this.ui.title.textContent = `来自 ${this.peerName}`;
      this.ui.meta.textContent = [`${files.length} 个文件`, sizeText(total), viaText(via)].join(' · ');
      fileRows(this.ui, files);
      this.buttons();
      this.ui.status.textContent = '等待你确认接收';
      this.expire = setTimeout(() => this.decline('等待确认超时'), ACCEPT_TIMEOUT);
      if (via === 'relay') hurry();
    }
    reply(msg) {
      if (this.via === 'p2p') {
        try {
          linkFor(this.peerId).send(msg);
          return Promise.resolve();
        } catch (e) {
          return Promise.reject(e);
        }
      }
      return call('send', { to: this.peerId, k: 'ctl', d: msg }).then(() => hurry());
    }
    buttons() {
      const { actions } = this.ui;
      actions.replaceChildren();
      if (this.state === 'ask') {
        actions.append(
          h('button', { class: 'btn small', type: 'button', onclick: () => this.decline() }, '拒绝'),
          h('button', { class: 'btn primary small', type: 'button', onclick: () => this.accept() }, '接收'));
      } else if (this.state === 'receiving') {
        actions.append(h('button', { class: 'btn ghost small danger', type: 'button', onclick: () => this.fail('已取消接收', true, 'cancelled') }, '取消'));
      }
      const ready = this.files.filter(f => f.url);
      if (ready.length > 1) {
        actions.append(
          h('button', { class: 'btn small', type: 'button', onclick: () => saveAll(ready) }, '全部保存'),
          h('button', { class: 'btn small', type: 'button', onclick: () => saveZip(ready) }, '打包 ZIP'));
      }
      if (ready.length && this.ended) {
        actions.append(h('button', { class: 'btn ghost small', type: 'button', onclick: () => this.clear() }, '清除'));
      }
    }
    accept() {
      if (this.state !== 'ask') return;
      clearTimeout(this.expire);
      dropPrompt(this);
      this.state = 'receiving';
      this.ui.card.dataset.state = 'active';
      this.lastData = Date.now();
      this.speed.start();
      this.buttons();
      this.ui.status.textContent = '正在接收…';
      this.reply({ t: 'accept', bid: this.bid }).catch(e => this.fail(e.message || '无法回复对方', false));
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastData > STALL_TIMEOUT) this.fail('对方停止了发送，未完成的文件已丢弃', true);
      }, 5000);
      if (this.via === 'relay') this.relayLoop();
    }
    decline(reason = '') {
      if (this.state !== 'ask') return;
      Promise.resolve().then(() => this.reply({ t: 'reject', bid: this.bid, reason })).catch(() => {});
      this.finish('rejected', reason ? `已拒绝：${reason}` : '已拒绝');
    }
    onBytes(bytes) {
      if (this.state !== 'receiving') return;
      const file = this.files[this.cur];
      if (!file || this.fileBytes + bytes.length > file.size) {
        this.fail('收到的数据超出文件大小，已停止', true);
        return;
      }
      this.take(bytes);
    }
    take(bytes) {
      this.crc = crc32(this.crc, bytes);
      this.pending.push(bytes);
      this.pendingBytes += bytes.length;
      this.fileBytes += bytes.length;
      this.received += bytes.length;
      this.lastData = Date.now();
      if (this.pendingBytes >= CONSOLIDATE) this.flush();
      this.speed.add(bytes.length);
      markDirty(this);
    }
    flush() {
      if (!this.pending.length) return;
      this.parts.push(new Blob(this.pending));
      this.pending = [];
      this.pendingBytes = 0;
    }
    completeFile(crc) {
      const i = this.cur, file = this.files[i];
      if (this.fileBytes !== file.size || this.crc !== crc) {
        this.fail(`「${file.name}」校验失败，已丢弃，请重新发送`, true);
        return;
      }
      this.flush();
      file.blob = new Blob(this.parts, { type: mimeOf(file.name) });
      file.crc = this.crc;
      file.url = URL.createObjectURL(file.blob);
      this.parts = [];
      this.crc = 0;
      this.fileBytes = 0;
      this.cur++;
      this.readyRow(i);
      if (autoSave) saveFile(file);
      if (this.via === 'p2p') Promise.resolve().then(() => this.reply({ t: 'got', bid: this.bid, i })).catch(() => {});
      if (this.cur === this.files.length) {
        Promise.resolve().then(() => this.reply({ t: 'done', bid: this.bid })).catch(() => {});
        this.finish('done', `已收到 ${this.files.length} 个文件${autoSave ? '，已开始保存' : '，点“保存”存到本机'}`);
      }
    }
    readyRow(i) {
      const file = this.files[i], row = this.ui.rows[i];
      if (!row) return;
      row.state.replaceChildren(icon('check'));
      if (isPreviewable(file.name) && file.size <= 30 * MiB) {
        row.thumb.replaceWith(row.thumb = h('img', { class: 'thumb', src: file.url, alt: '' }));
      }
      row.extra.replaceChildren(h('button', { class: 'btn ghost small', type: 'button', onclick: () => saveFile(file) }, '保存'));
      this.buttons();
    }
    onControl(msg) {
      if (this.ended) return;
      if (msg.t === 'eof' && this.via === 'p2p' && this.state === 'receiving') {
        if (msg.i !== this.cur || !Number.isInteger(msg.crc)) {
          this.fail('文件顺序错乱，已停止', true);
          return;
        }
        this.completeFile(msg.crc >>> 0);
      } else if (msg.t === 'stop') {
        this.fail(this.state === 'ask' ? '对方取消了发送' : '对方取消了发送，未完成的文件已丢弃', false, 'cancelled');
      }
    }
    async relayLoop() {
      let n = 0;
      try {
        while (this.state === 'receiving' && this.cur < this.files.length) {
          const file = this.files[this.cur];
          if (file.size === 0) {
            this.completeFile(0);
            continue;
          }
          const count = Math.ceil(file.size / this.chunk);
          for (let c = 0; c < count; c++, n++) {
            const expect = Math.min(this.chunk, file.size - c * this.chunk);
            const { bytes, crc } = await this.fetchChunk(n, expect);
            if (this.state !== 'receiving') return;
            this.take(bytes);
            if (c === count - 1) {
              if (crc === null) throw new Error(`「${file.name}」缺少校验信息`);
              this.completeFile(crc);
            }
          }
        }
      } catch (e) {
        this.fail(e.message || '中转失败', true);
      }
    }
    async fetchChunk(n, expect) {
      for (let attempt = 0; ;) {
        if (this.state !== 'receiving') throw new Error('已取消');
        let res;
        try {
          res = await post({ a: 'get', id: me.id, key: me.key, r: this.rid, n }, { timeout: 60000 });
        } catch (e) {
          if (++attempt > 4) throw e;
          await sleep(800 * attempt);
          continue;
        }
        if (res.status === 204) {
          if (Date.now() - this.lastData > STALL_TIMEOUT) throw new Error('对方停止了发送，未完成的文件已丢弃');
          continue;
        }
        if (res.status === 404) await relayClosed(this);
        if (!res.ok) throw await errorOf(res);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length !== expect) throw new Error('中转数据不完整');
        const header = res.headers.get('X-Crc');
        return { bytes, crc: header && /^[0-9a-f]{8}$/.test(header) ? parseInt(header, 16) : null };
      }
    }
    paint() {
      if (this.state !== 'receiving') return;
      paintProgress(this.ui, this.received, this.total, this.speed, '接收中');
    }
    fail(text, notify, state = 'failed') {
      if (this.ended) return;
      if (notify && this.state === 'receiving') Promise.resolve().then(() => this.reply({ t: 'cancel', bid: this.bid })).catch(() => {});
      this.finish(this.state === 'ask' ? 'cancelled' : state, text);
    }
    finish(state, text) {
      if (this.ended) return;
      this.ended = true;
      this.state = state;
      clearTimeout(this.expire);
      clearInterval(this.watchdog);
      this.pending = [];
      this.parts = [];
      if (this.rid) call('rclose', { r: this.rid }).catch(() => {});
      incoming.delete(this.key);
      dirty.delete(this);
      dropPrompt(this);
      if (this.files.some(f => f.url)) kept.add(this);
      this.ui.card.dataset.state = state;
      if (state === 'done') {
        this.ui.bar.firstChild.style.transform = 'scaleX(1)';
        this.ui.bar.setAttribute('aria-valuenow', '100');
      }
      this.ui.status.textContent = text;
      this.buttons();
      renderPeerProgress();
      if (state === 'done' || state === 'failed') toast(`${this.peerName}：${text}`, state === 'failed');
    }
    clear() {
      for (const file of this.files) releaseFile(file);
      kept.delete(this);
      this.ui.card.remove();
      if (!$('transfers').children.length) $('history').hidden = true;
    }
  }

  function releaseFile(file) {
    if (!file.url) return;
    URL.revokeObjectURL(file.url);
    file.url = null;
    file.blob = null;
  }

  function saveFile(file) {
    if (!file.url) return;
    file.saved = true;
    const a = h('a', { href: file.url, download: file.name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
  }
  function saveAll(files) {
    files.forEach((file, i) => setTimeout(() => saveFile(file), i * 400));
  }

  // 仅存储（不压缩）的 ZIP：CRC 已在接收时算好，打包不用再读一遍文件
  function zipBlob(files) {
    const enc = new TextEncoder(), parts = [], central = [], used = new Set();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    for (const file of files) {
      let name = file.name, n = 2;
      const dot = name.lastIndexOf('.');
      while (used.has(name.toLowerCase())) name = dot > 0 ? `${file.name.slice(0, dot)} (${n++})${file.name.slice(dot)}` : `${file.name} (${n++})`;
      used.add(name.toLowerCase());
      const bytes = enc.encode(name);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);            // 文件名为 UTF-8
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, file.crc >>> 0, true);
      local.setUint32(18, file.size, true);
      local.setUint32(22, file.size, true);
      local.setUint16(26, bytes.length, true);
      parts.push(local.buffer, bytes, file.blob);
      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(12, time, true);
      entry.setUint16(14, date, true);
      entry.setUint32(16, file.crc >>> 0, true);
      entry.setUint32(20, file.size, true);
      entry.setUint32(24, file.size, true);
      entry.setUint16(28, bytes.length, true);
      entry.setUint32(42, offset, true);
      central.push(entry.buffer, bytes);
      offset += 30 + bytes.length + file.size;
    }
    const size = central.reduce((sum, p) => sum + p.byteLength, 0);
    // 包含 UTF-8 文件名和重名后缀的真实目录长度；不能只按文件正文估算 ZIP32 边界。
    if (offset + size >= 0xffffffff || files.length >= 0xffff)
      throw new Error('文件太多或太大，无法打包，请逐个保存');
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  function saveZip(files) {
    const total = files.reduce((sum, f) => sum + f.size + 100, 0);
    if (total >= 0xffffffff || files.length >= 0xffff) return toast('文件太多或太大，无法打包，请逐个保存', true);
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    let url;
    try { url = URL.createObjectURL(zipBlob(files)); }
    catch (e) { return toast(e.message || '浏览器无法打包，请逐个保存', true); }
    const a = h('a', { href: url, download: `邻传-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------- 接收确认队列 ----------
  const prompts = [];
  let promptOpen = null;
  function queuePrompt(t) {
    prompts.push(t);
    attention();
    nextPrompt();
  }
  function nextPrompt() {
    if (promptOpen || !prompts.length) return;
    const t = prompts.shift();
    if (t.ended || t.state !== 'ask') return nextPrompt();
    const list = h('ul', { class: 'file-peek' }, t.files.slice(0, 5).map(f =>
      h('li', {}, icon('file'), h('span', { class: 'fname', text: f.name }), h('span', { class: 'fsize', text: sizeText(f.size) }))));
    const body = [list];
    if (t.files.length > 5) body.push(h('p', { class: 'muted', text: `等共 ${t.files.length} 个文件` }));
    if (t.via === 'relay') body.push(h('p', { class: 'note', text: '两台设备无法直连，将经路由器中转，速度会慢一些。' }));
    promptOpen = t;
    t.dialog = openDialog({
      title: `${t.peerName} 想发给你 ${t.files.length} 个文件（${sizeText(t.total)}）`,
      body,
      actions: [
        { label: '拒绝', onClick: () => t.decline() },
        { label: '接收', primary: true, onClick: () => t.accept() }
      ],
      onClose: () => { promptOpen = null; t.dialog = null; setTimeout(nextPrompt, 0); }
    });
  }
  function dropPrompt(t) {
    const i = prompts.indexOf(t);
    if (i >= 0) prompts.splice(i, 1);
    if (t.dialog) t.dialog.close();
  }

  // ---------- 文字 ----------
  function onText(from, d) {
    const text = d && typeof d.text === 'string' ? d.text.slice(0, TEXT_MAX) : '';
    if (!text.trim()) return;
    const name = peers.get(from)?.name || cleanName(d.name) || '对方';
    textCard('in', name, text);
    attention();
    const body = [h('div', { class: 'message', text, tabindex: '0' })];
    const actions = [{ label: '关闭' }];
    const url = text.trim();
    if (/^https?:\/\/[^\s]+$/i.test(url)) {
      actions.unshift({ label: '打开链接', onClick: () => window.open(url, '_blank', 'noopener,noreferrer') });
    }
    actions.unshift({ label: '复制', primary: true, keep: true, onClick: async () => toast(await copyText(text) ? '已复制' : '浏览器不允许复制，请长按文字手动复制', false) });
    openDialog({ title: `${name} 发来文字`, body, actions });
  }

  function textCard(dir, name, text) {
    const content = h('div', { class: 'xfer-text', text });
    const actions = h('div', { class: 'xfer-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: async () => toast(await copyText(text) ? '已复制' : '浏览器不允许复制，请手动复制', false) }, '复制'));
    const time = new Date().toTimeString().slice(0, 5);
    const card = h('article', { class: `xfer ${dir}`, 'data-dir': dir, 'data-state': 'done', 'data-kind': 'text' },
      h('div', { class: 'xfer-head' }, icon('text', 'xfer-icon'),
        h('div', { class: 'xfer-title' }, h('strong', { text: dir === 'out' ? `发给 ${name} 的文字` : `来自 ${name} 的文字` }), h('span', { class: 'xfer-meta', text: `${time} · ${text.length} 字` })),
        actions),
      content);
    if (text.split('\n').length > 6 || text.length > 300) {
      const more = h('button', { class: 'btn ghost small more', type: 'button', text: '展开全文' });
      more.addEventListener('click', () => { content.classList.add('open'); more.remove(); });
      card.append(more);
    }
    $('transfers').prepend(card);
    $('history').hidden = false;
  }

  function composeText(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return toast('对方已经离开', true);
    const area = h('textarea', { maxlength: String(TEXT_MAX), placeholder: '输入文字、链接或验证码…', 'aria-label': `发给 ${peer.name} 的文字` });
    const counter = h('span', { class: 'counter', text: `0 / ${TEXT_MAX}` });
    area.addEventListener('input', () => { counter.textContent = `${area.value.length} / ${TEXT_MAX}`; });
    const send = async (dlg, btn) => {
      const text = area.value;
      if (!text.trim()) { area.focus(); return; }
      btn.disabled = true;
      try {
        await call('send', { to: peerId, k: 'txt', d: { text, name: me.name } });
        dlg.close();
        textCard('out', peer.name, text);
        toast('已发送');
      } catch (e) {
        btn.disabled = false;
        toast(e.message, true);
      }
    };
    const dlg = openDialog({
      title: `发文字给 ${peer.name}`,
      body: [area, counter],
      focus: area,
      actions: [{ label: '取消' }, { label: '发送', primary: true, keep: true, onClick: send }]
    });
    area.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(dlg, dlg.buttons[1]);
    });
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* 退回 execCommand */ }
    const area = h('textarea', { class: 'offscreen', readonly: true });
    area.value = text;
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    area.remove();
    return ok;
  }

  // ---------- 对话框 ----------
  const dialogs = [];
  function openDialog({ title, body, actions, focus, onClose }) {
    const opener = document.activeElement;
    const titleId = `dlg-${randomHex(4)}`;
    const buttons = [];
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      h('h2', { id: titleId, text: title }),
      h('div', { class: 'dialog-body' }, body),
      h('div', { class: 'dialog-actions' }, actions.map(action => {
        const btn = h('button', { class: `btn${action.primary ? ' primary' : ''}`, type: 'button', text: action.label });
        btn.addEventListener('click', () => {
          if (action.onClick) action.onClick(dlg, btn);
          if (!action.keep) dlg.close();
        });
        buttons.push(btn);
        return btn;
      })));
    const overlay = h('div', { class: 'overlay' }, box);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) dlg.close(); });
    const dlg = {
      buttons,
      close() {
        if (!overlay.isConnected) return;
        overlay.remove();
        dialogs.splice(dialogs.indexOf(dlg), 1);
        if (onClose) onClose();
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      },
      box
    };
    dialogs.push(dlg);
    document.body.append(overlay);
    (focus || buttons[buttons.length - 1] || box).focus();
    return dlg;
  }
  document.addEventListener('keydown', e => {
    const top = dialogs[dialogs.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); top.close(); return; }
    if (e.key === 'Tab') {
      // 焦点留在最上层对话框内
      const items = [...top.box.querySelectorAll('button, textarea, input, a[href], [tabindex="0"]')].filter(el => !el.disabled);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!top.box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  });

  let toastTimer = 0;
  function toast(text, error = false) {
    const el = $('toast');
    el.textContent = text;
    el.classList.toggle('error', !!error);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), error ? 5000 : 3200);
  }

  function showBanner(text, label, action) {
    const el = $('banner');
    el.replaceChildren(h('span', { text }), label ? h('button', { class: 'btn small', type: 'button', onclick: action }, label) : '');
    el.hidden = false;
  }

  // 页面在后台时，在标题上提示有新请求
  let unseen = 0;
  const baseTitle = document.title;
  function attention() {
    if (!document.hidden) return;
    unseen++;
    document.title = `（${unseen}）新消息 · ${baseTitle}`;
  }

  // ---------- 渲染 ----------
  function setOnline(ok, message) {
    const el = $('net');
    el.classList.toggle('online', ok);
    el.classList.toggle('offline', !ok);
    el.lastElementChild.textContent = ok ? '路由器已连接' : (message || '连接中断');
    el.title = ok ? '已连接到路由器上的互传服务' : `${message || '连接中断'}，正在重试`;
  }

  function renderMe() {
    $('me-icon').replaceChildren(icon(device.kind));
    $('me-name').textContent = me.name;
    $('me-dev').textContent = [devLabel(device), me.ip].filter(Boolean).join(' · ');
  }

  function renderPeers() {
    const list = [...peers.values()].sort((a, b) => (a.since - b.since) || (a.id < b.id ? -1 : 1));
    const grid = $('peer-list');
    for (const [id, tile] of tiles) {
      if (!peers.has(id)) { tile.li.remove(); tiles.delete(id); }
    }
    list.forEach((peer, index) => {
      const tile = tileFor(peer);
      if (grid.children[index] !== tile.li) grid.insertBefore(tile.li, grid.children[index] || null);
    });
    $('empty').hidden = list.length > 0;
    $('peer-count').textContent = list.length ? `${list.length} 台` : '';
    renderPeerProgress();
  }

  function tileFor(peer) {
    let tile = tiles.get(peer.id);
    if (!tile) {
      const id = peer.id;
      tile = {
        avatar: h('span', { class: 'avatar' }),
        name: h('span', { class: 'peer-name' }),
        meta: h('span', { class: 'peer-meta' }),
        tags: h('span', { class: 'peer-tags' }),
        bar: h('span', { class: 'peer-bar', hidden: true }, h('i')),
        file: h('button', { class: 'btn primary', type: 'button', onclick: () => pickFiles(id) }, icon('up'), '发文件'),
        text: h('button', { class: 'btn', type: 'button', onclick: () => composeText(id) }, icon('text'), '发文字')
      };
      tile.li = h('li', { class: 'peer', 'data-peer': id },
        h('div', { class: 'peer-top' }, tile.avatar, h('div', { class: 'peer-text' }, tile.name, tile.meta, tile.tags)),
        tile.bar,
        h('div', { class: 'peer-actions' }, tile.file, tile.text));
      attachDrop(tile.li, id);
      tiles.set(id, tile);
    }
    if (tile.kind !== peer.dev.kind) {
      tile.kind = peer.dev.kind;
      tile.avatar.replaceChildren(icon(peer.dev.kind));
    }
    tile.name.textContent = peer.name;
    tile.meta.textContent = devLabel(peer.dev);
    tile.file.setAttribute('aria-label', `给 ${peer.name} 发文件`);
    tile.text.setAttribute('aria-label', `给 ${peer.name} 发文字`);
    const tags = [];
    if (peer.same) tags.push(h('span', { class: 'tag', title: '同一台设备上打开的另一个页面', text: '本机' }));
    const link = links.get(peer.id);
    if (link && link.open) tags.push(h('span', { class: 'tag direct', text: '直连' }));
    else if (link && link.busy) tags.push(h('span', { class: 'tag busy', text: '连接中' }));
    else if (!peer.rtc || !RTC || (link && Date.now() - link.failedAt < 60000)) tags.push(h('span', { class: 'tag relay', text: '经路由器中转' }));
    tile.tags.replaceChildren(...tags);
    return tile;
  }

  function renderPeerProgress() {
    for (const [id, tile] of tiles) {
      let done = 0, total = 0;
      for (const t of outgoing.values()) if (t.peerId === id && t.phase === 'send') { done += t.sent; total += t.total; }
      for (const t of incoming.values()) if (t.peerId === id && t.state === 'receiving') { done += t.received; total += t.total; }
      tile.bar.hidden = !total;
      if (total) tile.bar.firstChild.style.transform = `scaleX(${Math.min(1, done / total)})`;
    }
  }

  // ---------- 选文件与拖拽 ----------
  let pickTarget = null;
  function pickFiles(peerId) {
    pickTarget = peerId;
    linkFor(peerId).connect().catch(() => {});   // 选文件的同时预热直连
    const input = $('file-input');
    input.value = '';
    input.click();
  }
  $('file-input').addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (pickTarget && files.length) sendFiles(pickTarget, files);
  });

  const hasFiles = e => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  function droppedFiles(e) {
    const entries = Array.from(e.dataTransfer.items || []).filter(item => item.kind === 'file');
    const files = Array.from(e.dataTransfer.files || []);
    const keep = files.filter((file, i) => {
      const entry = entries[i] && entries[i].webkitGetAsEntry ? entries[i].webkitGetAsEntry() : null;
      return !(entry && entry.isDirectory);
    });
    if (keep.length < files.length) toast('暂不支持直接发送文件夹，请先压缩成一个文件', true);
    return keep;
  }
  function attachDrop(el, peerId) {
    el.addEventListener('dragenter', e => { if (hasFiles(e)) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
    el.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop');
      const files = droppedFiles(e);
      if (files.length) sendFiles(peerId, files);
    });
  }
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = droppedFiles(e);
    if (!files.length) return;
    if (peers.size === 1) sendFiles([...peers.keys()][0], files);
    else toast(peers.size ? '请把文件拖到要发送的设备上' : '还没有发现其他设备', true);
  });

  // ---------- 邀请 ----------
  const pageUrl = () => `${location.protocol}//${location.host}/`;
  function qrNode(label) {
    try { return window.LtQr ? window.LtQr.svg(pageUrl(), label) : null; } catch (_) { return null; }
  }
  function showInvite() {
    const url = pageUrl();
    const qr = qrNode('本页地址二维码');
    openDialog({
      title: '在其他设备打开邻传',
      body: [
        qr ? h('div', { class: 'qr-large' }, qr) : null,
        h('p', { class: 'url', text: url }),
        h('p', { class: 'muted', text: '手机连上同一个 Wi-Fi 后，用相机或浏览器扫码打开；电脑直接在浏览器输入这个地址。' })
      ],
      actions: [
        { label: '复制地址', keep: true, onClick: async () => toast(await copyText(url) ? '地址已复制' : '请手动复制地址', false) },
        { label: '完成', primary: true }
      ]
    });
  }

  function renameSelf() {
    const input = h('input', { type: 'text', maxlength: String(NAME_MAX), 'aria-label': '本机名称', autocomplete: 'off' });
    input.value = me.name;
    const save = async dlg => {
      const name = cleanName(input.value);
      if (!name) { input.focus(); return; }
      me.name = name;
      storage.set('lt-name', name);
      renderMe();
      dlg.close();
      try { await hello(); } catch (e) { toast(e.message, true); }
    };
    const dlg = openDialog({
      title: '修改本机名称',
      body: [input, h('p', { class: 'muted', text: '其他设备会看到这个名字。' })],
      focus: input,
      actions: [{ label: '取消' }, { label: '保存', primary: true, keep: true, onClick: save }]
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(dlg); });
    input.select();
  }

  // ---------- 启动 ----------
  $('invite').addEventListener('click', showInvite);
  $('rename').addEventListener('click', renameSelf);
  $('empty-copy').addEventListener('click', async () => toast(await copyText(pageUrl()) ? '地址已复制' : '请手动复制地址', false));
  $('empty-url').textContent = pageUrl();
  const emptyQr = qrNode('本页地址二维码');
  if (emptyQr) $('empty-qr').append(emptyQr); else $('empty-qr').hidden = true;
  $('auto-save').checked = autoSave;
  $('auto-save').addEventListener('change', e => {
    autoSave = e.target.checked;
    storage.set('lt-autosave', autoSave ? '1' : '0');
  });
  $('clear-history').addEventListener('click', () => {
    const unsaved = [...kept].reduce((sum, t) => sum + t.files.filter(f => f.url && !f.saved).length, 0);
    const clear = () => {
      for (const t of [...kept]) t.clear();
      for (const card of [...$('transfers').children]) {
        if (card.dataset.state !== 'active' && card.dataset.state !== 'ask') card.remove();
      }
      if (!$('transfers').children.length) $('history').hidden = true;
    };
    if (!unsaved) return clear();
    openDialog({
      title: `还有 ${unsaved} 个收到的文件没有保存`,
      body: [h('p', { class: 'muted', text: '清除后这些文件会从浏览器里删除，需要对方重新发送。' })],
      actions: [{ label: '取消' }, { label: '仍然清除', primary: true, onClick: clear }]
    });
  });
  if (device.inApp) showBanner(`你正在${device.browser}里打开，可能无法保存收到的文件。请点右上角「…」，选择「在浏览器打开」。`);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      unseen = 0;
      document.title = baseTitle;
      schedule(0);
    }
  });
  window.addEventListener('beforeunload', e => {
    const active = [...outgoing.values()].some(t => !t.ended) || [...incoming.values()].some(t => t.state === 'receiving');
    if (active) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pageshow', e => { if (e.persisted) schedule(0); });
  window.addEventListener('pagehide', () => {
    if (me.id) post({ a: 'bye', id: me.id, key: me.key }, { keepalive: true }).catch(() => {});
    storage.sset('lt-session', '');
    for (const link of links.values()) link.teardown();
  });

  renderMe();
  renderPeers();
  poll();
})();
