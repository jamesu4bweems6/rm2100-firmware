#!/usr/bin/ucode
// 邻传常驻 HTTP：同源入口、连接复用、非阻塞收发，保留原 API 与中转协议。
'use strict';
import * as socket from 'socket';
import { readfile, readlink, mkdir, writefile, rename } from 'fs';
import { request } from './api.uc';

const addr = ARGV[0];
const requested_port = int(ARGV[1] || '8080');
const ROOT = ARGV[2] || '/tmp/lan-transfer';
const WWW = ARGV[3] || '/usr/share/lan-transfer/www';
const BLOCK = 65536;
const CHUNK = 1048576;
const MAX_CLIENTS = 32;
const MAX_BUFFERED = 8388608; // 请求正文、待中转上传、慢下载合计最多 8 MiB，另有原来的 12 MiB tmpfs 窗口。
let clients = [], buffered = 0;
const chunks = {};
function millis() { let t = clock(true); return t[0] * 1000 + t[1] / 1000000; }
// 地址用对象形式：ucode 解析 "IP:端口" 字符串时结尾 NUL 错位一字节，会随机报「Unable to parse IP address」。
// 对象形式的空地址会绑定 0.0.0.0（含 WAN），所以先确认 addr 非空。
const listener = socket.create(socket.AF_INET, socket.SOCK_STREAM | socket.SOCK_NONBLOCK);
if (!addr || !listener || !listener.setopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, true)
    || !listener.bind({ family: socket.AF_INET, address: addr, port: requested_port }) || !listener.listen(MAX_CLIENTS))
	die('lan-transfer: bind failed: ' + socket.error() + '\n');
const port = listener.sockname().port;
const assets = {};
for (let name in ['index.html', 'app.js', 'qr.js', 'style.css', 'speed.html', 'speed.js']) {
	assets['/' + name] = readfile(WWW + '/' + name);
	if (assets['/' + name] == null) die('lan-transfer: missing asset: ' + name + '\n');
}
mkdir(ROOT, 448);
writefile(ROOT + '/http.json.tmp', sprintf('%J', { address: addr, port: port, pid: int(readlink('/proc/self')) }));
rename(ROOT + '/http.json.tmp', ROOT + '/http.json');

function release(c) { buffered -= c.hold || 0; c.hold = 0; }
function reserve(c, size) {
	// 大块不能占满所有缓冲，给发现、信令和取消留至少 1 MiB。
	let limit = size > 81920 ? MAX_BUFFERED - CHUNK : MAX_BUFFERED;
	if (buffered - (c.hold || 0) + size > limit) return false;
	release(c); c.hold = size; buffered += size; return true;
}
function close(c) {
	if (c.closed) return;
	release(c); c.sock.close(); c.closed = true; c.body = ''; c.parts = []; c.data = ''; c.out = '';
}
function retry() { let err = socket.error(true); return err == 11 || err == 4; }
function respond(c, code, data, ctype, extra) {
	c.body = ''; c.parts = []; c.env = null;
	if (!reserve(c, length(data))) { code = 503; data = '{"error":"服务繁忙，请重试"}'; ctype = 'application/json'; c.end = true; release(c); }
	c.out = sprintf('HTTP/1.1 %d %s\r\nContent-Length: %d\r\nContent-Type: %s\r\nCache-Control: no-store, no-transform\r\nX-Content-Type-Options: nosniff\r\nConnection: %s\r\n',
		code, code == 200 ? 'OK' : code == 204 ? 'No Content' : 'Response', length(data), ctype, c.end ? 'close' : 'keep-alive');
	if (extra) c.out += extra;
	c.out += '\r\n'; c.data = c.head ? '' : data; c.offset = 0; c.phase = 'write';
}
function fail(c, code, message) { c.end = true; respond(c, code, sprintf('%J', { error: message }), 'application/json'); }
function dispatch(c) {
	let r;
	if (c.path == '/cgi-bin/speed') {
		let info;
		try { info = json(readfile(ROOT + '/speed.json')); } catch (e) { info = null; }
		if (!info || info.address != addr || info.webport != port || info.chunk != 4194304 ||
		    info.port < 1 || info.port > 65535 || !readfile('/proc/' + info.pid + '/cmdline')) {
			fail(c, 400, '常驻测速服务未就绪，请重启邻传'); return;
		}
		r = { code: 200, body: info };
	}
	else r = request(c.env, c.body, ROOT, 0, chunks);
	// 等块和等待窗口腾空均停放连接，不能在事件循环里 sleep 或持状态锁。
	if ((r.code == 204 || (r.code == 429 && c.put)) && millis() < c.wait_until) {
		c.phase = 'wait'; c.next = millis() + 50; return;
	}
	respond(c, r.code, r.raw != null ? r.raw : r.body != null ? sprintf('%J', r.body) : '',
		r.raw != null ? 'application/octet-stream' : 'application/json; charset=utf-8',
		r.crc != null ? 'X-Crc: ' + r.crc + '\r\n' : null);
}
function parse(c) {
	let end = index(c.buf, '\r\n\r\n');
	if (end < 0) { if (length(c.buf) > 8192) fail(c, 431, '请求头过长'); return; }
	if (end > 8192) { fail(c, 431, '请求头过长'); return; }
	let lines = split(substr(c.buf, 0, end), '\r\n');
	let req = match(shift(lines), /^(POST|GET|HEAD) ([^ ]+) HTTP\/1\.([01])$/);
	if (!req) { fail(c, 405, '无效的请求'); return; }
	let h = {};
	for (let line in lines) {
		let m = match(line, /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/);
		if (!m || h[lc(m[1])] != null) { fail(c, 400, '无效或重复的请求头'); return; }
		h[lc(m[1])] = trim(m[2]);
	}
	let host = h.host || '', hm = match(host, /^([a-z0-9.-]+):([0-9]+)$/);
	if (!hm || hm[2] != '' + port || (hm[1] != addr && !match(hm[1], /^[a-z0-9-]+(\.lan)?$/))) {
		fail(c, 403, '请用路由器内网地址访问'); return;
	}
	c.end = lc(h.connection || '') == 'close' || req[3] == '0';
	if (h['transfer-encoding'] != null || h.expect != null) { fail(c, 400, '不支持分块请求或 Expect'); return; }
	c.path = split(req[2], '?')[0];
	if (req[1] != 'POST') {
		if ((h['content-length'] != null && h['content-length'] != '0') || length(c.buf) > end + 4) { fail(c, 400, '不支持请求正文'); return; }
		c.head = req[1] == 'HEAD';
		let path = c.path == '/' ? '/index.html' : c.path;
		if (assets[path] == null) { fail(c, c.path == '/cgi-bin/api' ? 405 : 404, '页面不存在'); return; }
		let ctype = match(path, /\.html$/) ? 'text/html; charset=utf-8' : match(path, /\.js$/) ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
		respond(c, 200, assets[path], ctype); c.buf = ''; return;
	}
	if (c.path != '/cgi-bin/api' && c.path != '/cgi-bin/speed') { fail(c, 404, '操作不存在'); return; }
	if (h.origin != 'http://' + host) { fail(c, 403, '请从路由器内网页面访问'); return; }
	if (!match(h['content-length'] || '', /^[0-9]{1,8}$/)) { fail(c, 411, '缺少请求长度'); return; }
	c.total = int(h['content-length']);
	let query = index(req[2], '?') >= 0 ? substr(req[2], index(req[2], '?') + 1) : '';
	c.put = c.path == '/cgi-bin/api' && match(query, /(^|&)a=put(&|$)/) != null;
	if (c.total > (c.put ? CHUNK : 81920)) { fail(c, 413, '请求太大'); return; }
	if (c.put ? h['content-type'] != 'application/octet-stream' : c.path == '/cgi-bin/api' && substr(h['content-type'] || '', 0, 16) != 'application/json') {
		fail(c, 415, '请求类型不正确'); return;
	}
	if (c.path == '/cgi-bin/speed' && (query != 'a=endpoint' || c.total || h['content-type'] != 'application/octet-stream')) {
		fail(c, 400, '无效的测速操作'); return;
	}
	if (!reserve(c, c.total)) { fail(c, 503, '服务繁忙，请重试'); return; }
	c.env = { REQUEST_METHOD: 'POST', QUERY_STRING: query, CONTENT_TYPE: h['content-type'], CONTENT_LENGTH: '' + c.total,
		HTTP_HOST: host, HTTP_ORIGIN: h.origin, SERVER_ADDR: addr, SERVER_PORT: '' + port, REMOTE_ADDR: c.ip };
	let first = substr(c.buf, end + 4); c.buf = ''; c.phase = 'body';
	c.parts = [first]; c.received = length(first);
	if (c.received > c.total) { fail(c, 400, '请求长度不正确'); return; }
	if (c.received == c.total) { c.body = first; c.parts = []; c.wait_until = millis() + 800; dispatch(c); }
}
function read(c) {
	for (let i = 0; i < 16 && (c.phase == 'headers' || c.phase == 'body'); i++) {
		let data = c.sock.recv(BLOCK);
		if (data == null) { if (!retry()) close(c); return; }
		if (!length(data)) { close(c); return; }
		if (c.phase == 'headers') {
			if (!length(c.buf)) c.deadline = millis() + 30000;
			c.buf += data; parse(c);
		}
		else {
			push(c.parts, data); c.received += length(data);
			if (c.received > c.total) { fail(c, 400, '请求长度不正确'); return; }
			if (c.received == c.total) { c.body = join('', c.parts); c.parts = []; c.wait_until = millis() + 800; dispatch(c); }
		}
	}
}
function write(c) {
	for (let i = 0; i < 16; i++) {
		if (!length(c.out)) {
			if (c.offset >= length(c.data)) {
				release(c); c.data = '';
				if (c.end) close(c);
				else { c.phase = 'headers'; c.buf = ''; c.head = false; c.deadline = millis() + 15000; }
				return;
			}
			c.out = substr(c.data, c.offset, BLOCK); c.offset += length(c.out);
		}
		let n = c.sock.send(c.out);
		if (n == null) { if (!retry()) close(c); return; }
		if (!n) { close(c); return; }
		c.out = substr(c.out, n);
	}
}
while (true) {
	clients = filter(clients, c => !c.closed);
	let specs = [[listener, socket.POLLIN]], waiting = false;
	for (let c in clients) {
		waiting ||= c.phase == 'wait';
		push(specs, [c.sock, c.phase == 'write' ? socket.POLLOUT : socket.POLLIN, c]);
	}
	let events = socket.poll(waiting ? 50 : 1000, ...specs);
	for (let event in events || []) {
		let flags = event[1], c = event[2];
		if (!c && (flags & socket.POLLIN)) {
			let address = {}, peer = listener.accept(address, socket.SOCK_NONBLOCK);
			if (!peer) continue;
			if (length(clients) >= MAX_CLIENTS) { peer.close(); continue; }
			peer.setopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, true);
			push(clients, { sock: peer, ip: address.address, phase: 'headers', buf: '', hold: 0, deadline: millis() + 15000 });
		}
		else if (c && !c.closed) {
			if (flags & (socket.POLLERR | socket.POLLHUP | socket.POLLNVAL)) close(c);
			else if (flags & socket.POLLIN) {
				if (c.phase == 'wait') close(c); // 不支持 HTTP pipelining；浏览器使用顺序复用。
				else read(c);
			}
			else if (flags & socket.POLLOUT) write(c);
		}
	}
	for (let c in clients) if (!c.closed) {
		if (millis() > c.deadline) close(c);
		else if (c.phase == 'wait' && millis() >= c.next) dispatch(c);
	}
}
