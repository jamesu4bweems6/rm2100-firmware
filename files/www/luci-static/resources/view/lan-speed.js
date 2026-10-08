'use strict';
'require view';
'require uci';
'require network';

return view.extend({
	load: function() { return Promise.all([uci.load('lan-transfer'), network.getNetwork('lan')]); },
	render: function(data) {
		var lan = data[1], ip = lan ? lan.getIPAddr() : null,
		    enabled = uci.get('lan-transfer', 'main', 'enabled') != '0',
		    port = uci.get('lan-transfer', 'main', 'port') || '8080',
		    url = ip ? 'http://' + ip + ':' + port + '/speed.html' : null;
		return E('div', { 'class': 'cbi-section' }, [
			E('h2', {}, [ _('内网测速') ]),
			E('p', {}, [ _('测量当前手机或电脑与路由器之间的下载、上传速度和往返延迟。只产生内网流量，不需要另一台设备。') ]),
			url && enabled ? E('p', {}, [ E('a', { 'class': 'btn cbi-button cbi-button-action', 'href': url, 'target': '_blank', 'rel': 'noopener noreferrer' }, [ _('打开测速页面') ]) ])
				: E('p', {}, [ enabled ? _('LAN 口暂无 IPv4 地址，请检查网络设置。') : _('服务已关闭，请在“内网文件互传”中启用并保存应用。') ]),
			E('p', { 'class': 'cbi-section-descr' }, [ _('测速服务与内网文件互传共用页面端口。结果受连接质量、浏览器和路由器 CPU 性能影响，延迟包含 HTTP 请求处理时间。') ])
		]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
