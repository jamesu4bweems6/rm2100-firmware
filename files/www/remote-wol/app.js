/* 远程开机网页：列出巴法云 TCP 设备云里的主题（每台电脑一个），显示开关机状态并发送开机指令。 */
(function () {
  'use strict';
  const W = window.RemoteWol;
  const KEY = 'remote-wol-uid';
  const $ = id => document.getElementById(id);
  let uid = '';
  let timer = null;
  let fastUntil = 0;
  const pending = {};

  function store(value) {
    try { value ? localStorage.setItem(KEY, value) : localStorage.removeItem(KEY); } catch (e) { /* 隐私模式 */ }
  }
  function load() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function say(id, text, error) {
    const el = $(id);
    el.textContent = text || '';
    el.classList.toggle('error', !!error);
  }
  function ago(unix) {
    if (!unix) return '';
    const s = Math.max(0, Math.round(Date.now() / 1000 - unix));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return new Date(unix * 1000).toLocaleString();
  }

  function render(topics) {
    const box = $('pcs');
    box.replaceChildren();
    if (!topics.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'TCP 设备云里还没有主题。请先在巴法云控制台新建主题（例如 pc001），并在路由器「远程开机」页面填同一个主题。';
      box.append(p);
      return;
    }
    for (const t of topics) {
      const state = W.powerState(t);
      const row = document.createElement('div');
      row.className = 'pc';
      const dot = document.createElement('span');
      dot.className = 'dot' + (state === 'on' ? ' on' : '');
      const main = document.createElement('div');
      main.className = 'pc-main';
      const name = document.createElement('div');
      name.className = 'pc-name';
      name.textContent = t.name || t.topic;
      const meta = document.createElement('div');
      meta.className = 'pc-meta';
      const label = state === 'on' ? '已开机' : state === 'off' ? '已关机' : '状态未知';
      meta.append((t.name ? t.topic + ' · ' : '') + label + (t.unix ? ' · ' + ago(t.unix) : '') + ' · ');
      const router = document.createElement('span');
      router.textContent = t.online ? '路由器在线' : '路由器离线';
      if (!t.online) router.className = 'bad';
      meta.append(router);
      main.append(name, meta);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = pending[t.topic] ? '发送中…' : '开机';
      btn.disabled = !!pending[t.topic];
      btn.addEventListener('click', () => power(t, btn));
      row.append(dot, main, btn);
      box.append(row);
    }
  }

  async function refresh() {
    if (!uid) return;
    try {
      const topics = await W.listTopics(uid, W.TCP);
      topics.sort((a, b) => (W.miKind(b.topic) ? 1 : 0) - (W.miKind(a.topic) ? 1 : 0) || a.topic.localeCompare(b.topic));
      render(topics);
      // 只清掉上次的错误；「已发送开机指令」这类提示要留着
      if ($('pcs-msg').classList.contains('error')) say('pcs-msg', '');
      $('pcs-card').hidden = false;
      $('diag-card').hidden = false;
    } catch (e) {
      $('pcs-card').hidden = false;
      say('pcs-msg', e.message, true);
    }
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (!uid || document.hidden) return;
    // 刚发过开机指令的两分钟内每 5 秒刷新，平时 20 秒
    timer = setTimeout(refresh, Date.now() < fastUntil ? 5000 : 20000);
  }

  async function power(t, btn) {
    pending[t.topic] = true;
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      await W.wake(uid, t.topic);
      say('pcs-msg', '已向「' + (t.name || t.topic) + '」发送开机指令' + (t.online ? '' : '，但路由器当前离线，指令可能送不到') + '。');
      fastUntil = Date.now() + 120000;
    } catch (e) {
      say('pcs-msg', '开机失败：' + e.message, true);
    } finally {
      delete pending[t.topic];
      refresh();
    }
  }

  async function check() {
    const list = $('diag');
    list.replaceChildren();
    $('check').disabled = true;
    try {
      // 查询失败要如实显示，不能当成「没有主题」
      const tcp = await W.listTopics(uid, W.TCP);
      const mqtt = await W.listTopics(uid, W.MQTT).catch(() => null);
      for (const item of W.diagnose(tcp, mqtt)) {
        const li = document.createElement('li');
        li.className = item.level;
        li.textContent = item.text;
        list.append(li);
      }
    } catch (e) {
      const li = document.createElement('li');
      li.className = 'error';
      li.textContent = e.message;
      list.append(li);
    } finally {
      $('check').disabled = false;
    }
  }

  function setUid(value) {
    uid = value;
    $('forget').hidden = !uid;
    if (!uid) {
      $('pcs-card').hidden = $('diag-card').hidden = true;
      clearTimeout(timer);
      return;
    }
    refresh();
  }

  $('save').addEventListener('click', () => {
    const value = $('uid').value.trim();
    if (!W.validUid(value)) { say('setup-msg', '私钥只包含字母和数字', true); return; }
    store(value);
    $('uid').value = '';
    $('uid').placeholder = '已保存（重新输入可替换）';
    say('setup-msg', '已保存在这台设备上。');
    setUid(value);
  });
  $('uid').addEventListener('keydown', e => { if (e.key === 'Enter') $('save').click(); });
  $('refresh').addEventListener('click', refresh);
  $('check').addEventListener('click', check);
  $('forget').addEventListener('click', () => {
    store('');
    $('uid').placeholder = '32 位字母和数字';
    say('setup-msg', '已清除。');
    setUid('');
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else clearTimeout(timer); });

  const saved = load();
  if (saved && W.validUid(saved)) {
    $('uid').placeholder = '已保存（重新输入可替换）';
    setUid(saved);
  }
})();
