#!/usr/bin/ucode
// 常驻内网测速：非阻塞 TCP、连接复用、64 KiB 流式处理，不保存测试数据。
'use strict';
import * as socket from 'socket';
import { mkdir, readlink, readfile, writefile, rename } from 'fs';

const addr = ARGV[0];
const webport = ARGV[1] || '8080';
const ROOT = ARGV[2] || '/tmp/lan-transfer';
const WWW = ARGV[3] || '/usr/share/lan-transfer/www';
const CHUNK = 4194304;
const BLOCK = 65536;
const MAX_CLIENTS = 16;
let block = chr(0);
while (length(block) < BLOCK) block += block;
let clients = [];
const listener = socket.create(socket.AF_INET, socket.SOCK_STREAM | socket.SOCK_NONBLOCK);
if (!listener || !listener.bind(addr + ':0') || !listener.listen(MAX_CLIENTS))
	die('lan-speed: bind failed: ' + socket.error() + '\n');
const port = listener.sockname().port;
const info = { address: addr, port: port, webport: int(webport), chunk: CHUNK, pid: int(readlink('/proc/self')) };
const assets = {};
for (let name in ['speed.html', 'speed.js', 'style.css']) {
	assets['/' + name] = readfile(WWW + '/' + name);
	if (assets['/' + name] == null) die('lan-speed: missing asset: ' + name + '\n');
}
mkdir(ROOT, 448);
if (writefile(ROOT + '/speed.json.tmp', sprintf('%J', info)) > 0)
	rename(ROOT + '/speed.json.tmp', ROOT + '/speed.json');

function close(c) { c.sock.close(); c.closed = true; }
function retry() { let err = socket.error(true); return err == 11 || err == 4; }
function respond(c, code, data, download, ctype, extra) {
	let body = download ? '' : ctype ? data : sprintf('%J', data);
	let reason = code == 200 ? 'OK' : code == 204 ? 'No Content' : 'Rejected';
	c.out = sprintf('HTTP/1.1 %d %s\r\nContent-Length: %d\r\nContent-Type: %s\r\nCache-Control: no-store, no-transform\r\nX-Content-Type-Options: nosniff\r\nConnection: %s\r\n',
		code, reason, download ? CHUNK : length(body), ctype || (download ? 'application/octet-stream' : 'application/json'), c.end ? 'close' : 'keep-alive');
	if (extra) c.out += extra;
	c.out += '\r\n' + (c.head ? '' : body);
	c.left = download ? CHUNK : 0;
	c.phase = 'write';
}
function fail(c, code, message) { c.end = true; respond(c, code, { error: message }, false); }
function parse(c) {
	let end = index(c.buf, '\r\n\r\n');
	if (end < 0) { if (length(c.buf) > 8192) fail(c, 431, '请求头过长'); return; }
	if (end > 8192) { fail(c, 431, '请求头过长'); return; }
	let lines = split(substr(c.buf, 0, end), '\r\n');
	c.buf = substr(c.buf, end + 4);
	let req = match(shift(lines), /^(POST|GET|HEAD) ([^ ]+) HTTP\/1\.([01])$/);
	if (!req) { fail(c, 405, '无效的测速请求'); return; }
	let h = {};
	for (let line in lines) {
		let m = match(line, /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/);
		if (!m || h[lc(m[1])] != null) { fail(c, 400, '无效或重复的请求头'); return; }
		h[lc(m[1])] = trim(m[2]);
	}
	let host = match(h.host || '', /^([a-z0-9.-]+):([0-9]+)$/);
	if (!host || int(host[2]) != port || (host[1] != addr && !match(host[1], /^[a-z0-9-]+(\.lan)?$/))) {
		fail(c, 403, '请用路由器内网地址访问'); return;
	}
	c.end = lc(h.connection || '') == 'close' || req[3] == '0';
	if (h['transfer-encoding'] != null) { fail(c, 400, '不支持分块请求'); return; }
	if (req[1] == 'GET' || req[1] == 'HEAD') {
		if ((h['content-length'] != null && h['content-length'] != '0') || length(c.buf)) { fail(c, 400, '不支持请求正文'); return; }
		c.head = req[1] == 'HEAD';
		let path = split(req[2], '?')[0];
		if (path == '/') {
			respond(c, 302, '', false, 'text/plain', 'Location: http://' + host[1] + ':' + webport + '/\r\n'); return;
		}
		if (assets[path] == null) { fail(c, 404, '页面不存在'); return; }
		let type = path == '/speed.html' ? 'text/html; charset=utf-8' : path == '/speed.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
		respond(c, 200, assets[path], false, type); return;
	}
	let action = match(req[2], /^\/speed\?a=(ping|download|upload)$/);
	let discovery = req[2] == '/cgi-bin/speed?a=endpoint';
	if (!action && !discovery) { fail(c, 404, '无效的测速操作'); return; }
	let origin = match(h.origin || '', /^http:\/\/([a-z0-9.-]+):([0-9]+)$/);
	if (!origin || origin[1] != host[1] || int(origin[2]) != port) {
		fail(c, 403, '请从路由器内网测速页面访问'); return;
	}
	c.origin = h.origin;
	if (!match(h['content-length'] || '', /^[0-9]{1,8}$/)) { fail(c, 411, '缺少请求长度'); return; }
	let size = int(h['content-length']);
	if (size > CHUNK) { fail(c, 413, '每次最多上传 4 MiB'); return; }
	if (h['content-type'] != 'application/octet-stream') { fail(c, 415, '需要二进制测速数据'); return; }
	if (action && action[1] == 'upload') {
		if (!size || length(c.buf) > size) { fail(c, 400, '上传长度不正确'); return; }
		c.received = length(c.buf); c.total = size; c.buf = ''; c.phase = 'upload';
		if (c.received == size) respond(c, 200, { bytes: size }, false);
	}
	else {
		if (size || length(c.buf)) { fail(c, 400, '该操作不需要请求数据'); return; }
		respond(c, 200, discovery ? info : { ok: true }, action && action[1] == 'download');
	}
}
function read(c) {
	for (let i = 0; i < 16 && c.phase != 'write'; i++) {
		let data = c.sock.recv(BLOCK);
		if (data == null) { if (!retry()) close(c); return; }
		if (!length(data)) { close(c); return; }
		if (c.phase == 'headers') {
			if (!length(c.buf)) c.deadline = time() + 30;
			c.buf += data; parse(c);
		}
		else {
			c.received += length(data);
			if (c.received > c.total) { fail(c, 400, '上传长度不正确'); return; }
			if (c.received == c.total) respond(c, 200, { bytes: c.received }, false);
		}
	}
}
function write(c) {
	for (let i = 0; i < 16; i++) {
		if (!length(c.out)) {
			if (!c.left) {
				if (c.end) close(c);
				else { c.phase = 'headers'; c.buf = ''; c.origin = null; c.head = false; c.deadline = time() + 15; }
				return;
			}
			c.out = block; c.left -= BLOCK;
		}
		let n = c.sock.send(c.out);
		if (n == null) { if (!retry()) close(c); return; }
		if (!n) { close(c); return; }
		c.out = substr(c.out, n);
	}
}

while (true) {
	clients = filter(clients, c => !c.closed);
	let specs = [[listener, socket.POLLIN]];
	for (let c in clients) push(specs, [c.sock, c.phase == 'write' ? socket.POLLOUT : socket.POLLIN, c]);
	let events = socket.poll(1000, ...specs);
	for (let event in events || []) {
		let flags = event[1], c = event[2];
		if (!c && (flags & socket.POLLIN)) {
			let peer = listener.accept({}, socket.SOCK_NONBLOCK);
			if (!peer) continue;
			if (length(clients) >= MAX_CLIENTS) { peer.close(); continue; }
			// 小响应和块边界立即发送，避免 Nagle/延迟确认造成额外等待。
			peer.setopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, true);
			push(clients, { sock: peer, phase: 'headers', buf: '', deadline: time() + 15 });
		}
		else if (c) {
			if (flags & (socket.POLLERR | socket.POLLHUP | socket.POLLNVAL)) close(c);
			else if (flags & socket.POLLIN) read(c);
			else if (flags & socket.POLLOUT) write(c);
		}
	}
	for (let c in clients) if (!c.closed && time() > c.deadline) close(c);
}
