'use strict';
'require view';
'require fs';
'require ui';
'require poll';

// WiFi 仅内网：按 SSID 一键禁止上网（只通内网），网线设备不受影响。
// 文件名带版本号：固件内文件修改时间固定、LuCI 视图地址的 ?v= 不随本固件变化，改动视图时要换文件名，
// 否则浏览器会继续用缓存里的旧版本。
var CTL = '/usr/libexec/wifi-lanonly/ctl';

function readStatus() {
	return fs.exec(CTL, [ 'status' ]).then(function(res) {
		if (res.code != 0)
			throw new Error(res.stderr || res.code);
		return JSON.parse(res.stdout);
	});
}

return view.extend({
	load: function() {
		return L.resolveDefault(readStatus(), null);
	},

	toggle: function(ssid, on, btn) {
		btn.disabled = true;
		return fs.exec(CTL, [ 'set', ssid, on ? '1' : '0' ]).then(function(res) {
			if (res.code != 0)
				throw new Error(res.stderr || _('退出码 %s').format(res.code));
			ui.addNotification(null, E('p', {}, [
				on ? _('已禁止“%s”上网：连这个 WiFi 的设备现在只能访问内网。').format(ssid)
				   : _('已恢复“%s”上网。').format(ssid)
			]), 'info');
		}).catch(function(err) {
			ui.addNotification(null, E('p', {}, [ _('操作失败：%s').format(err.message || err) ]), 'error');
		}).then(L.bind(this.refresh, this));
	},

	renderTable: function(st) {
		var self = this;
		if (!st)
			return E('p', {}, [ _('无法读取状态，请确认已安装 WiFi 仅内网模块。') ]);
		if (!st.ssids.length)
			return E('p', {}, [ _('没有找到 WiFi。请先在“网络 → 无线”里启用并配置 WiFi。') ]);

		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, [ _('WiFi 名称（SSID）') ]),
				E('th', { 'class': 'th' }, [ _('当前') ]),
				E('th', { 'class': 'th' }, [ _('在线设备') ]),
				E('th', { 'class': 'th' }, [ ' ' ])
			])
		].concat(st.ssids.map(function(s) {
			var state = s.lanonly
				? (s.ifnames.length ? _('仅内网（已禁止上网）') : _('仅内网（WiFi 未开启）'))
				: (s.disabled ? _('WiFi 未开启') : _('可以上网'));
			var btn = E('button', {
				'class': 'btn cbi-button ' + (s.lanonly ? 'cbi-button-apply' : 'cbi-button-negative'),
				'click': function(ev) { return self.toggle(s.ssid, !s.lanonly, ev.currentTarget); }
			}, [ s.lanonly ? _('恢复上网') : _('禁止上网') ]);
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'data-title': _('WiFi 名称（SSID）') }, [ E('strong', {}, [ s.ssid ]), s.radio ? ' (' + s.radio + ')' : '' ]),
				E('td', { 'class': 'td', 'data-title': _('当前'), 'style': s.lanonly ? 'color:#d97706' : '' }, [ state ]),
				E('td', { 'class': 'td', 'data-title': _('在线设备') }, [ s.ifnames.length ? String(s.stations) : '-' ]),
				E('td', { 'class': 'td cbi-section-actions' }, [ btn ])
			]);
		})));
	},

	refresh: function() {
		var self = this;
		return L.resolveDefault(readStatus(), null).then(function(st) {
			self.box.replaceChildren(self.renderTable(st));
			self.counter.textContent = st
				? _('已拦截发往外网的数据包：%s').format(st.blocked) + (st.active ? '' : _('（当前没有 WiFi 被限制）'))
				: '';
		});
	},

	render: function(st) {
		this.box = E('div', {}, [ this.renderTable(st) ]);
		this.counter = E('p', { 'class': 'cbi-section-descr' });
		poll.add(L.bind(this.refresh, this), 10);
		this.refresh();
		return E([], [
			E('h2', { 'name': 'content' }, [ _('WiFi 仅内网') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('一键让某个 WiFi 只能访问内网：连这个 WiFi 的手机、电脑仍能访问路由器、网线连接的设备和同一 WiFi 下的其他设备（例如邻传、局域网共享、投屏），但不能上外网。网线连接的设备和其他 WiFi 不受影响。点按钮立即生效，已建立的外网连接会被切断；设置在重启和 WiFi 重启后保持。')
			]),
			E('div', { 'class': 'cbi-section' }, [ this.box, this.counter ]),
			E('div', { 'class': 'cbi-section' }, [
				E('p', { 'class': 'cbi-section-descr' }, [
					_('按 WiFi 名称生效：两个频段用同一个名称时会一起限制；在“无线”里给 WiFi 改名后，需要对新名称重新设置。')
				])
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
