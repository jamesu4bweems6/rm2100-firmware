'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require fs';
'require ui';
'require poll';

var callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

var STATES = {
	connecting: _('正在连接巴法云…'),
	online: _('已连接，随时可以远程开机'),
	offline: _('连接断开，稍后自动重试'),
	error: _('巴法云拒绝了订阅')
};

function fmtTime(t) {
	return t ? new Date(t * 1000).toLocaleString() : '-';
}

function readStatus() {
	return Promise.all([
		L.resolveDefault(callServiceList('remote-wol'), {}),
		L.resolveDefault(fs.read('/tmp/remote-wol/status.json'), null)
	]).then(function(res) {
		var instances = ((res[0] || {})['remote-wol'] || {}).instances || {},
		    running = Object.keys(instances).some(function(k) { return instances[k].running; }),
		    status = null;
		try { status = res[1] ? JSON.parse(res[1]) : null; } catch (e) {}
		return { running: running, status: running ? status : null };
	});
}

// 本地开机：直接调用唤醒脚本发魔术包，不经过巴法云，路由器没连上云也能用
function wakeLocal(name, mac, btn) {
	btn.disabled = true;
	return fs.exec('/usr/share/remote-wol/wake', [ mac ]).then(function(res) {
		if (res.code == 0)
			ui.addNotification(null, E('p', {}, [ _('已向“%s”（%s）发送开机魔术包，电脑通常 30 秒到 1 分钟内开机。').format(name, mac) ]), 'info');
		else
			ui.addNotification(null, E('p', {}, [ _('开机失败：%s').format(res.stderr || res.code) ]), 'error');
	}).catch(function(err) {
		ui.addNotification(null, E('p', {}, [ _('开机失败：%s').format(err) ]), 'error');
	}).finally(function() {
		btn.disabled = false;
	});
}

// 巴法云接口与诊断规则和手机网页共用一份：/www/remote-wol/bemfa.js
var bemfaReady = null;
function loadBemfa() {
	if (!bemfaReady)
		bemfaReady = new Promise(function(resolve, reject) {
			if (window.RemoteWol)
				return resolve(window.RemoteWol);
			var script = E('script', { 'src': '/remote-wol/bemfa.js' });
			script.onload = function() { window.RemoteWol ? resolve(window.RemoteWol) : reject(new Error(_('诊断脚本加载失败'))); };
			script.onerror = function() { bemfaReady = null; reject(new Error(_('诊断脚本加载失败'))); };
			document.head.appendChild(script);
		});
	return bemfaReady;
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('remote-wol'),
			L.resolveDefault(callHostHints(), {}),
			readStatus()
		]);
	},

	renderPower: function(info) {
		var s = info.status, hosts = [];

		uci.sections('remote-wol', 'host', function(h) {
			if (h.mac && h.enabled != '0')
				hosts.push(h);
		});
		if (!hosts.length)
			return E('p', {}, [ _('还没有添加电脑。在下方“电脑”表格里填写名称、MAC 地址和巴法云主题，保存并应用后这里会出现开机按钮。') ]);

		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, [ _('电脑') ]),
				E('th', { 'class': 'th' }, [ _('状态') ]),
				E('th', { 'class': 'th' }, [ _('MAC 地址') ]),
				E('th', { 'class': 'th' }, [ ' ' ])
			])
		].concat(hosts.map(function(h) {
			var name = h.name || h.topic || h.mac,
			    probe = (s && s.sync && s.hosts) ? s.hosts[h.topic] : null,
			    state, color;
			if (!probe)
				state = s && !s.sync ? _('未开启状态同步') : _('未知');
			else if (probe.online == null)
				state = _('检测中…');
			else
				state = probe.online ? _('已开机') : _('已关机');
			color = probe && probe.online ? '#16a34a' : 'inherit';
			var btn = E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': function(ev) { return wakeLocal(name, h.mac, ev.currentTarget); }
			}, [ _('开机') ]);
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'data-title': _('电脑') }, [ E('strong', {}, [ name ]) ]),
				E('td', { 'class': 'td', 'data-title': _('状态'), 'style': 'color:' + color }, [
					state + (probe && probe.ip ? '（' + probe.ip + '）' : '')
				]),
				E('td', { 'class': 'td', 'data-title': _('MAC 地址') }, [ h.mac ]),
				E('td', { 'class': 'td cbi-section-actions' }, [ btn ])
			]);
		})));
	},

	checkBemfa: function(box, btn) {
		var uid = uci.get('remote-wol', 'main', 'uid') || '',
		    configured = [];
		uci.sections('remote-wol', 'host', function(h) {
			if (h.topic && h.enabled != '0') configured.push(h.topic);
		});
		var show = function(items) {
			box.replaceChildren.apply(box, items.map(function(i) {
				var colors = { ok: '#16a34a', info: '#6b7280', warn: '#d97706', error: '#dc2626' };
				return E('li', { 'style': 'margin:6px 0;padding-left:8px;border-left:4px solid ' + (colors[i.level] || '#6b7280') }, [ i.text ]);
			}));
		};
		if (!uid) {
			show([ { level: 'error', text: _('请先在上面填写巴法云私钥，保存并应用后再检查。') } ]);
			return Promise.resolve();
		}
		btn.disabled = true;
		show([ { level: 'info', text: _('正在查询巴法云…') } ]);
		return loadBemfa().then(function(W) {
			return Promise.all([
				W.listTopics(uid, W.TCP).catch(function(e) { if (/私钥/.test(e.message)) return []; throw e; }),
				W.listTopics(uid, W.MQTT).catch(function() { return null; })
			]).then(function(res) {
				var items = [], names = res[0].map(function(t) { return t.topic; });
				// 路由器订阅不会自动在控制台建主题；没建的主题米家里也不会有
				configured.forEach(function(t) {
					if (names.indexOf(t) < 0)
						items.push({ level: 'error', text: _('路由器里填的主题 %s 在巴法云“TCP 设备云”里不存在：请到控制台新建同名主题，再到米家里同步设备。').format(t) });
				});
				show(items.concat(W.diagnose(res[0], res[1])));
			});
		}).catch(function(e) {
			show([ { level: 'error', text: e.message } ]);
		}).finally(function() {
			btn.disabled = false;
		});
	},

	renderStatus: function(info) {
		var names = {}, rows = [], s = info.status;

		uci.sections('remote-wol', 'host', function(h) {
			if (h.topic) names[h.topic] = h.name || h.topic;
		});

		if (!info.running) {
			var why = uci.get('remote-wol', 'main', 'enabled') != '1'
				? _('未启用。填好巴法云私钥、添加电脑并勾选“启用”，保存并应用后开始工作。')
				: _('未运行：请检查私钥和电脑的 MAC、主题是否填写正确（系统日志里搜索 remote-wol 可看到原因）。');
			return E('p', {}, [ why ]);
		}
		if (!s)
			return E('p', {}, [ _('服务已启动，正在等待状态…') ]);

		rows.push(E('p', {}, [
			E('strong', {}, [ STATES[s.state] || s.state ]),
			' ', _('（自 %s 起）').format(fmtTime(s.since))
		]));
		if (s.error && s.state != 'online')
			rows.push(E('p', {}, [ _('原因：%s').format(s.error) ]));
		if (s.alive)
			rows.push(E('p', {}, [ _('最后一次收到服务器数据：%s').format(fmtTime(s.alive)) ]));
		if (s.sync && s.hosts)
			rows.push(E('ul', {}, (s.topics || []).map(function(t) {
				var h = s.hosts[t] || {},
				    state = h.online == null ? _('检测中…') : (h.online ? _('开机') : _('关机'));
				return E('li', {}, [ _('%s：%s%s').format(names[t] || t, state, h.ip ? '（' + h.ip + '）' : '') ]);
			})));
		if (s.wakes && s.wakes.length)
			rows.push(E('ul', {}, s.wakes.map(function(w) {
				return E('li', {}, [ _('%s　%s（%s）%s').format(fmtTime(w.time), names[w.topic] || w.topic, w.mac,
					w.ok ? _('已发送魔术包') : _('发送失败')) ]);
			})));
		else
			rows.push(E('p', {}, [ _('还没有收到过远程开机指令。') ]));
		return E('div', {}, rows);
	},

	render: function(data) {
		var hints = data[1] || {},
		    self = this,
		    statusBox = E('div', {}, [ this.renderStatus(data[2]) ]),
		    powerBox = E('div', {}, [ this.renderPower(data[2]) ]),
		    diagBox = E('ul', { 'class': 'remote-wol-diag' }),
		    m, s, o;

		// 页面标题和说明放在开机卡片上方，表单本身不再重复标题
		m = new form.Map('remote-wol');

		s = m.section(form.NamedSection, 'main', 'remote-wol', _('巴法云'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('启用'));
		o.rmempty = false;

		o = s.option(form.Value, 'uid', _('私钥'),
			_('登录 <a href="https://cloud.bemfa.com/" target="_blank" rel="noopener noreferrer">cloud.bemfa.com</a> 控制台，复制左上角的私钥（UID）。'));
		o.password = true;
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (value == '')
				return true;
			return /^[A-Za-z0-9]{1,64}$/.test(value) ? true : _('私钥只包含字母和数字');
		};

		o = s.option(form.Flag, 'sync_state', _('同步开关状态到米家'),
			_('每 30 秒探测一次电脑是否开机（ARP，不受 Windows 防火墙影响），把真实状态写回巴法云。这样电脑自己关机或开机失败后，米家和小爱同学显示的开关状态也是对的。'));
		o.default = '1';
		o.rmempty = false;

		s = m.section(form.GridSection, 'host', _('电脑'),
			_('主题需先在巴法云控制台“TCP 设备云”中创建。以 001 结尾（如 pc001）会被识别为插座，接入米家后可以说“小爱同学，打开电脑”。最多 8 台。'));
		s.addremove = true;
		s.anonymous = true;
		s.nodescriptions = true;

		o = s.option(form.Flag, 'enabled', _('启用'));
		o.default = '1';
		o.rmempty = false;
		o.editable = true;

		o = s.option(form.Value, 'name', _('名称'));
		o.placeholder = _('我的电脑');

		o = s.option(form.Value, 'mac', _('MAC 地址'));
		o.datatype = 'macaddr';
		o.rmempty = false;
		Object.keys(hints).sort().forEach(function(mac) {
			var h = hints[mac], label = h.name || (h.ipaddrs || h.ipv4 || [])[0];
			// 主机名来自 DHCP，用文本节点拼接，不当 HTML 解析
			o.value(mac, label ? E([], [ mac, ' (', E('strong', {}, [ label ]), ')' ]) : mac);
		});

		o = s.option(form.Value, 'topic', _('巴法云主题'));
		o.placeholder = 'pc001';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (!/^[A-Za-z0-9]{1,64}$/.test(value))
				return _('主题只能用字母和数字');
			var dup = uci.sections('remote-wol', 'host').some(function(h) {
				return h['.name'] != section_id && h.topic == value;
			});
			return dup ? _('主题不能重复') : true;
		};

		poll.add(function() {
			return readStatus().then(function(info) {
				statusBox.replaceChildren(self.renderStatus(info));
				powerBox.replaceChildren(self.renderPower(info));
			});
		}, 5);

		return m.render().then(function(mapEl) {
			var webUrl = window.location.protocol + '//' + window.location.host + '/remote-wol/',
			    checkBtn = E('button', { 'class': 'btn cbi-button cbi-button-action' }, [ _('检查巴法云') ]);
			checkBtn.addEventListener('click', function() { return self.checkBemfa(diagBox, checkBtn); });
			return E([], [
				E('h2', { 'name': 'content' }, [ _('远程开机') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('路由器主动连接巴法云并订阅主题，不需要公网 IP。在手机网页、巴法云 App 或米家（小爱同学）里发出开机指令，路由器就向对应电脑发送网络唤醒（WoL）魔术包。电脑需用网线连接路由器，并在 BIOS 和网卡设置中开启网络唤醒。')
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, [ _('开机') ]),
					powerBox,
					E('p', { 'class': 'cbi-section-descr' }, [
						_('这里的“开机”直接从路由器发魔术包，不经过巴法云。人不在家时用手机打开远程开机网页：'),
						E('a', { 'href': webUrl, 'target': '_blank', 'rel': 'noopener noreferrer' }, [ webUrl ]),
						_('（局域网内可直接打开；人在外面时用 iOS App）。')
					])
				]),
				E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('运行状态') ]), statusBox ]),
				mapEl,
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, [ _('接入米家 / 小爱同学') ]),
					E('ol', {}, [
						E('li', {}, [ _('在巴法云控制台“TCP 设备云”里创建以 001 结尾的主题（如 pc001），点主题旁的“设置”把昵称改成“电脑”。昵称就是小爱同学认的设备名。') ]),
						E('li', {}, [ _('在上面的“电脑”表格里填同一个主题，保存并应用，等“运行状态”显示已连接。') ]),
						E('li', {}, [ _('打开米家 App：我的 → 连接其他平台（或“其他平台设备”）→ 添加 → 选择“巴法”，用巴法云账号登录授权，然后点“同步设备”。') ]),
						E('li', {}, [ _('设备列表里出现“电脑”插座后，点开它就能远程开机，也可以说“小爱同学，打开电脑”。') ])
					]),
					E('p', { 'class': 'cbi-section-descr' }, [
						_('米家里点“关闭”或说“关闭电脑”不会关机：路由器无法替电脑关机，开启状态同步时，3 分钟后开关会变回电脑的真实状态。改了巴法云里的主题或昵称后，需要在米家里重新“同步设备”。')
					]),
					E('h4', {}, [ _('米家里看不到设备？') ]),
					E('p', { 'class': 'cbi-section-descr' }, [
						_('点下面的按钮，用已保存的私钥查询巴法云，检查主题是否存在、命名是否符合米家规则、是否设置了昵称、路由器是否在线订阅。')
					]),
					E('p', {}, [ checkBtn ]),
					diagBox
				])
			]);
		});
	}
});
