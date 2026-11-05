/* 远程开机：巴法云 HTTP 接口与米家诊断（网页、路由器 LuCI 页面共用）。
 * 巴法云接口返回 Access-Control-Allow-Origin: *，浏览器可以直接调用，不经过路由器。
 * 私钥只保存在本机浏览器（localStorage）或路由器配置里，不会发到巴法云以外的地方。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteWol = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // 脚本版本：页面据此判断浏览器是否还在用缓存里的旧脚本（固件升级后 uhttpd 不发 Cache-Control）
  const VERSION = 3;
  const API = 'https://apis.bemfa.com';
  const TCP = 3;    // 路由器连的是 bemfa.com:8344，对应接口里的 type=3
  const MQTT = 1;
  // 主题名后三位决定米家里的设备类型；其他名字不会同步到米家
  const KINDS = { '001': '插座', '002': '灯', '003': '风扇', '004': '传感器', '005': '空调', '006': '开关', '009': '窗帘' };

  function miKind(topic) {
    return KINDS[String(topic || '').slice(-3)] || null;
  }

  function validUid(uid) {
    return /^[A-Za-z0-9]{1,64}$/.test(uid || '');
  }

  async function getJson(fetcher, url, init) {
    let response;
    try {
      response = await fetcher(url, Object.assign({ cache: 'no-store' }, init || {}));
    } catch (e) {
      throw new Error('连不上巴法云，请检查网络');
    }
    let data;
    try { data = await response.json(); } catch (e) { throw new Error('巴法云返回了无法识别的数据（HTTP ' + response.status + '）'); }
    return data;
  }

  // 列出账号下某个云的全部主题：[{ topic, name, msg, online, unix, time }]
  async function listTopics(uid, type, fetcher) {
    if (!validUid(uid)) throw new Error('私钥只包含字母和数字');
    const url = API + '/vb/api/v2/allTopic?openID=' + encodeURIComponent(uid) + '&type=' + (type || TCP);
    const data = await getJson(fetcher || fetch, url);
    if (data.code !== 0) throw new Error(data.code === -1 ? '获取主题失败：私钥不正确，或这个云里还没有主题' : (data.msg || data.message || '获取主题失败'));
    return topicList(data).map(normalize).filter(t => t.topic);
  }

  // 实际返回是 {"code":0,"data":{"data":[…]}}，比官方文档示例多包一层；两种都接受
  function topicList(data) {
    const raw = data && data.data;
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.data)) return raw.data;
    return [];
  }

  // 单独确认某个主题是否存在：读它的最后一条消息。主题列表接口格式变化时用它复核，避免误报「不存在」。
  // 返回 true（存在）、false（巴法云明确说主题或私钥不对）、null（查不到结论，例如网络错误）
  async function topicExists(uid, topic, fetcher) {
    if (!validUid(uid) || !/^[A-Za-z0-9]{1,64}$/.test(topic || '')) return false;
    try {
      const data = await getJson(fetcher || fetch, API + '/va/getmsg?uid=' + encodeURIComponent(uid) + '&topic=' + encodeURIComponent(topic) + '&type=' + TCP);
      if (data.code === 0) return true;
      if (data.code === 40004) return false;
      return null;
    } catch (e) {
      return null;
    }
  }

  function normalize(t) {
    t = t || {};
    const unix = Number(t.unix);
    return {
      topic: String(t.topic || ''),
      name: String(t.name || ''),
      msg: String(t.msg == null ? '' : t.msg),
      online: t.online === true || t.online === 'true' || t.online === 1,
      unix: Number.isFinite(unix) && unix > 0 ? unix : null
    };
  }

  // 向主题发 on：路由器收到后唤醒对应电脑
  async function wake(uid, topic, fetcher) {
    if (!validUid(uid)) throw new Error('私钥只包含字母和数字');
    if (!/^[A-Za-z0-9]{1,64}$/.test(topic || '')) throw new Error('主题只能是字母和数字');
    const data = await getJson(fetcher || fetch, API + '/va/postJsonMsg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: uid, topic: topic, type: TCP, msg: 'on' })
    });
    if (data.code !== 0) throw new Error(data.message || data.msg || ('发送失败（' + data.code + '）'));
    return true;
  }

  // 主题里最后一条消息就是电脑状态：路由器开启状态同步时每 30 秒写回 on/off
  function powerState(t) {
    const msg = String(t.msg || '').trim().toLowerCase();
    if (msg === 'on' || msg.indexOf('on#') === 0) return 'on';
    if (msg === 'off' || msg.indexOf('off#') === 0) return 'off';
    return 'unknown';
  }

  // 检查账号设置，找出米家里看不到设备、远程开机不生效的原因。
  // tcp / mqtt：listTopics 的结果；mqtt 可为 null（查询失败时）。
  function diagnose(tcp, mqtt) {
    const items = [];
    const add = (level, text) => items.push({ level: level, text: text });
    tcp = tcp || [];
    if (!tcp.length) {
      add('error', 'TCP 设备云里没有查到主题（也可能是私钥填错了）。请核对私钥，并在巴法云控制台「TCP 设备云」新建主题，名字以 001 结尾（例如 pc001），路由器「远程开机」里填同一个主题。');
    }
    let mijia = 0;
    for (const t of tcp) {
      const kind = miKind(t.topic);
      const label = t.name ? '「' + t.name + '」（' + t.topic + '）' : t.topic;
      if (!kind) {
        add('error', label + '：主题名后三位不是 001、002 这类设备代码，不会同步到米家。请新建以 001 结尾的主题（例如 ' + t.topic + '001），路由器里也改成新主题。');
      } else {
        mijia++;
        if (kind !== '插座' && kind !== '开关') add('info', label + '：在米家里会显示为「' + kind + '」。电脑建议用 001（插座）或 006（开关）。');
        if (!t.name) add('warn', t.topic + '：没有设置昵称。米家和小爱同学用昵称作设备名，建议在巴法云控制台把昵称设为「电脑」。');
      }
      if (!t.online) add('warn', label + '：路由器没有在线订阅这个主题，远程开机指令送不到。请确认路由器「远程开机」已启用、填了这个主题，且运行状态显示已连接。');
    }
    for (const t of mqtt || []) {
      if (miKind(t.topic)) add('info', 'MQTT 设备云里的 ' + t.topic + ' 也会同步到米家，但路由器只接收 TCP 设备云的指令。远程开机请用 TCP 设备云里的主题。');
    }
    if (mijia) {
      add(items.some(i => i.level === 'error') ? 'info' : 'ok',
        '有 ' + mijia + ' 个主题符合米家同步规则。若米家里仍看不到：米家 App →「我的」→「其他平台设备」（新版为「连接其他平台」）→「巴法」→「同步设备」；同步来的设备可能只出现在「巴法」这个列表里，不在首页。新建或改名主题后都要重新同步。还要确认米家里登录的巴法账号就是这个私钥所属的账号：手机号登录和微信登录可能是两个不同的巴法账号。仍不行就解绑巴法后重新绑定。');
    }
    return items;
  }

  return { VERSION, API, TCP, MQTT, KINDS, miKind, validUid, listTopics, topicExists, wake, powerState, diagnose, normalize, topicList };
});
