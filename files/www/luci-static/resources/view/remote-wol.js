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

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('remote-wol'),
			L.resolveDefault(callHostHints(), {}),
			readStatus()
		]);
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
		    m, s, o;

		m = new form.Map('remote-wol', _('远程开机'),
			_('路由器主动连接巴法云并订阅主题，不需要公网 IP。在巴法云 App、微信小程序或米家（小爱同学）里向主题发送“on”，路由器就向对应电脑发送网络唤醒（WoL）魔术包。电脑需用网线连接路由器，并在 BIOS 和网卡设置中开启网络唤醒。'));

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

		o = s.option(form.Button, '_wake', _('本地测试'));
		o.inputtitle = _('立即唤醒');
		o.inputstyle = 'apply';
		o.modalonly = false;
		o.onclick = function(ev, section_id) {
			var mac = this.section.formvalue(section_id, 'mac') || uci.get('remote-wol', section_id, 'mac');
			if (!mac)
				return ui.addNotification(null, E('p', {}, [ _('请先填写 MAC 地址') ]), 'warning');
			return fs.exec('/usr/share/remote-wol/wake', [ mac ]).then(function(res) {
				if (res.code == 0)
					ui.addNotification(null, E('p', {}, [ _('已向 %s 发送魔术包').format(mac) ]), 'info');
				else
					ui.addNotification(null, E('p', {}, [ _('发送失败：%s').format(res.stderr || res.code) ]), 'error');
			}).catch(function(err) {
				ui.addNotification(null, E('p', {}, [ _('发送失败：%s').format(err) ]), 'error');
			});
		};

		poll.add(function() {
			return readStatus().then(function(info) {
				statusBox.replaceChildren(self.renderStatus(info));
			});
		}, 5);

		return m.render().then(function(mapEl) {
			return E([], [
				mapEl,
				E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('运行状态') ]), statusBox ]),
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
					])
				])
			]);
		});
	}
});
