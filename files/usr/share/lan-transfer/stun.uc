#!/usr/bin/ucode
// 邻传内网 STUN 应答器：只回应 Binding 请求（RFC 5389），告诉浏览器它在内网里的真实地址。
//
// 为什么需要：浏览器默认把 WebRTC 的本机候选地址换成随机的 xxx.local（mDNS），
// 一部分安卓手机、开着防火墙的 Windows 解析不了对方的 .local 名字，直连就会失败。
// 页面向路由器 LAN 地址发一次 STUN 请求，会得到一条带真实内网 IP 的 srflx 候选
// （libwebrtc 在启用 mDNS 混淆时不丢弃与本机地址相同的 srflx），双方都能直接互发连通性检查。
// 只绑定 LAN 地址，不产生任何外网流量。
'use strict';

import * as socket from 'socket';
import { mkdir, readlink, writefile, rename } from 'fs';

const ROOT = '/tmp/lan-transfer';
const addr = ARGV[0];
const port = int(ARGV[1] || '3478');

const CRC = [];
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++)
		c = (c & 1) ? (0xedb88320 ^ (c >> 1)) : (c >> 1);
	push(CRC, c);
}

function crc32(s) {
	let c = 0xffffffff;
	for (let i = 0; i < length(s); i++)
		c = CRC[(c ^ ord(s, i)) & 255] ^ (c >> 8);
	return c ^ 0xffffffff;
}

function be16(v) {
	return chr((v >> 8) & 255, v & 255);
}

function be32(v) {
	return chr((v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
}

function is_binding(req) {
	return length(req) >= 20 && length(req) <= 548
		&& ord(req, 0) == 0 && ord(req, 1) == 1
		&& ((ord(req, 2) << 8) | ord(req, 3)) + 20 == length(req)
		&& ord(req, 4) == 0x21 && ord(req, 5) == 0x12 && ord(req, 6) == 0xa4 && ord(req, 7) == 0x42;
}

// Binding 成功应答：MAPPED-ADDRESS（兼容老客户端）+ XOR-MAPPED-ADDRESS + FINGERPRINT
function answer(req, ip, rport) {
	let xport = rport ^ 0x2112;
	let attrs = be16(0x0001) + be16(8) + chr(0, 1) + be16(rport) + chr(ip[0], ip[1], ip[2], ip[3])
		+ be16(0x0020) + be16(8) + chr(0, 1) + be16(xport)
		+ chr(ip[0] ^ 0x21, ip[1] ^ 0x12, ip[2] ^ 0xa4, ip[3] ^ 0x42);
	// 头部长度要把 FINGERPRINT（8 字节）算进去，校验值覆盖它之前的全部内容
	let msg = be16(0x0101) + be16(length(attrs) + 8) + substr(req, 4, 16) + attrs;
	return msg + be16(0x8028) + be16(4) + be32(crc32(msg) ^ 0x5354554e);
}

// 地址用对象形式：ucode 解析 "IP:端口" 字符串时结尾 NUL 错位一字节，会随机解析失败。
// 对象形式的空地址会绑定 0.0.0.0（含 WAN），所以先确认 addr 非空。
let sock = socket.create(socket.AF_INET, socket.SOCK_DGRAM);
if (!addr || sock == null || !sock.bind({ family: socket.AF_INET, address: addr, port: port })) {
	warn(sprintf('lan-transfer-stun: cannot bind %s:%d: %s\n', addr, port, socket.error()));
	exit(1);
}

// 告诉 CGI 应答器已就绪，页面据此决定是否配置 iceServers
mkdir(ROOT, 448);
let pid = int(readlink('/proc/self'));
if (writefile(ROOT + '/stun.json.tmp', sprintf('%J', { port: port, pid: pid })) > 0)
	rename(ROOT + '/stun.json.tmp', ROOT + '/stun.json');

while (true) {
	let from = {};
	let req = sock.recv(1024, 0, from);
	if (req == null) {
		sleep(100);
		continue;
	}
	if (from.family != socket.AF_INET || !is_binding(req))
		continue;
	let ip = iptoarr(from.address);
	if (length(ip) != 4)
		continue;
	sock.send(answer(req, ip, from.port), 0, from);
}
