// 邻传共享后端：设备发现、信令与有界内存盘中转。
'use strict';

import { readfile, writefile, mkdir, rmdir, open, rename, unlink, glob, stat, stdin } from 'fs';

let ROOT = '/tmp/lan-transfer';
const API = 1;
const PEER_TTL = 35;            // 秒：页面在后台时 8 秒轮询一次，留足余量
const PEER_MAX = 48;
const PEER_PER_IP = 8;
const MAIL_MAX = 48;            // 每台设备待取的消息条数
const MAIL_BYTES = 196608;
const MSG_BYTES = 65536;        // 单条消息：SDP、批量文件清单或一段文字
const REQ_BYTES = 81920;
const CHUNK = 1048576;          // 中转分块
const RELAY_MAX = 4;            // 同时进行的中转传输
const RELAY_WINDOW = 4;         // 每个中转最多暂存的分块数
const RELAY_BYTES = 12582912;   // 所有中转分块占用内存盘的上限（12 MiB）
const RELAY_TTL = 60;
let WAIT_MS = 800;
const WAIT_STEP = 50;
const REASONS = {
	'200': 'OK', '204': 'No Content', '400': 'Bad Request', '401': 'Unauthorized',
	'403': 'Forbidden', '404': 'Not Found', '405': 'Method Not Allowed',
	'411': 'Length Required', '413': 'Payload Too Large', '415': 'Unsupported Media Type',
	'429': 'Too Many Requests', '500': 'Internal Server Error', '503': 'Service Unavailable',
	'507': 'Insufficient Storage'
};

// 单调时钟：首刷时系统时间可能差十几个月，NTP 校时还会跳变
let now = 0;
let env = {}, request_body = null, memory_chunks = null;
let lockfh = null;
function request_env(name) { return env[name]; }

function reply(code, body) {
	return { code: code, body: body };
}

function fail(code, message) {
	return { code: code, body: { error: message } };
}

function emit(r) {
	let head = sprintf('Status: %d %s\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n',
		r.code, REASONS[r.code]);
	if (r.raw != null) {
		head += sprintf('Content-Type: application/octet-stream\r\nContent-Length: %d\r\n', length(r.raw));
		if (r.crc != null)
			head += 'X-Crc: ' + r.crc + '\r\n';
		print(head, '\r\n', r.raw);
	}
	else if (r.body != null) {
		let data = sprintf('%J', r.body);
		print(head, sprintf('Content-Type: application/json; charset=utf-8\r\nContent-Length: %d\r\n\r\n', length(data)), data);
	}
	else
		print(head, '\r\n');
}

function token() {
	let raw = readfile('/proc/sys/kernel/random/uuid');
	return (type(raw) == 'string') ? replace(trim(raw), /-/g, '') : null;
}

function is_token(v) {
	return type(v) == 'string' && match(v, /^[0-9a-f]{32}$/) != null;
}

function is_text(v, max) {
	return type(v) == 'string' && length(v) > 0 && length(v) <= max;
}

function load(path) {
	let raw = readfile(path), v = null;
	if (type(raw) != 'string' || raw == '')
		return null;
	try {
		v = json(raw);
	}
	catch (e) {
		v = null;
	}
	return (type(v) == 'object') ? v : null;
}

// 先写临时文件再改名：进程被 -t 超时杀掉也不会留下半截 JSON
function store(path, data) {
	let raw = sprintf('%J', data), tmp = path + '.tmp';
	if (writefile(tmp, raw) != length(raw) || !rename(tmp, path)) {
		unlink(tmp);
		return false;
	}
	return true;
}

function peer_file(id) {
	return ROOT + '/peers/' + id + '.json';
}

function mail_file(id) {
	return ROOT + '/mail/' + id + '.json';
}

function relay_dir(rid) {
	return ROOT + '/relay/' + rid;
}

function remove_tree(dir) {
	if (memory_chunks != null)
		for (let path in memory_chunks)
			if (substr(path, 0, length(dir) + 1) == dir + '/') delete memory_chunks[path];
	let files = glob(dir + '/*');
	for (let i = 0; i < length(files); i++)
		unlink(files[i]);
	rmdir(dir);
}

function acquire() {
	mkdir(ROOT, 448);               // 0700
	mkdir(ROOT + '/peers', 448);
	mkdir(ROOT + '/mail', 448);
	mkdir(ROOT + '/relay', 448);
	lockfh = open(ROOT + '/lock', 'a', 384);    // 0600
	return lockfh != null && lockfh.lock('x') == true;
}

// 等待分块时放开全局锁，别让一个慢传输卡住其他设备的轮询
function pause() {
	lockfh.lock('u');
	sleep(WAIT_STEP);
	lockfh.lock('x');
}

// 读取在线设备，顺手清理过期的设备、邮箱和中转
function live_peers() {
	let peers = {}, paths = glob(ROOT + '/peers/*.json');
	for (let i = 0; i < length(paths); i++) {
		let p = load(paths[i]);
		if (p != null && is_token(p.id) && paths[i] == peer_file(p.id)
		    && type(p.seen) == 'int' && p.seen + PEER_TTL >= now) {
			peers[p.id] = p;
			continue;
		}
		unlink(paths[i]);
		let m = match(paths[i], /([0-9a-f]{32})\.json$/);
		if (m != null)
			unlink(mail_file(m[1]));
	}
	let dirs = glob(ROOT + '/relay/*');
	for (let i = 0; i < length(dirs); i++) {
		let r = load(dirs[i] + '/meta.json');
		if (r == null || type(r.t) != 'int' || r.t + RELAY_TTL < now
		    || peers[r.from] == null || peers[r.to] == null)
			remove_tree(dirs[i]);
	}
	return peers;
}

function auth(peers, d) {
	let p = is_token(d.id) ? peers[d.id] : null;
	return (p != null && is_token(d.key) && p.key == d.key) ? p : null;
}

// 中转请求频繁，只核对本设备，不做全量清理
function auth_one(id, key) {
	if (!is_token(id) || !is_token(key))
		return null;
	let p = load(peer_file(id));
	return (p != null && p.key == key && type(p.seen) == 'int' && p.seen + PEER_TTL >= now) ? p : null;
}

function stun_port() {
	let s = load(ROOT + '/stun.json');
	if (s == null || type(s.port) != 'int' || type(s.pid) != 'int')
		return null;
	return (stat('/proc/' + s.pid) != null) ? s.port : null;
}

function mailbox(id) {
	let box = load(mail_file(id));
	return (box != null && type(box.n) == 'int' && type(box.msgs) == 'array') ? box : { n: 0, msgs: [] };
}

function act_hello(d) {
	let peers = live_peers();
	if (!is_text(d.name, 64) || !(d.dev == null || (type(d.dev) == 'string' && length(d.dev) <= 96)))
		return fail(400, '设备名称不正确');
	let ip = request_env('REMOTE_ADDR') || '';
	let p = auth(peers, d);
	if (p == null) {
		let total = 0, own = 0;
		for (let k in peers) {
			total++;
			if (peers[k].ip == ip)
				own++;
		}
		if (total >= PEER_MAX || own >= PEER_PER_IP)
			return fail(429, '打开的互传页面太多了，请关掉不用的页面再试');
		p = { id: token(), key: token(), since: now };
		if (p.id == null || p.key == null)
			return fail(500, '无法生成设备编号');
	}
	p.name = d.name;
	p.dev = d.dev || '';
	p.rtc = d.rtc ? 1 : 0;
	p.max = (type(d.max) == 'int' && d.max > 0) ? d.max : 0;
	p.ip = ip;
	p.seen = now;
	if (!store(peer_file(p.id), p))
		return fail(507, '路由器存储空间不足');
	return reply(200, { id: p.id, key: p.key, v: API, ip: ip, ttl: PEER_TTL, chunk: CHUNK, stun: stun_port() });
}

function act_poll(d) {
	let peers = live_peers(), p = auth(peers, d);
	if (p == null)
		return fail(401, '会话已过期，正在重新连接');
	p.seen = now;
	store(peer_file(p.id), p);
	let box = mailbox(p.id);
	if (type(d.ack) == 'int' && length(box.msgs) > 0 && box.msgs[0].n <= d.ack) {
		let ack = d.ack;
		box.msgs = filter(box.msgs, (m) => m.n > ack);
		store(mail_file(p.id), box);
	}
	let list = [];
	for (let k in peers) {
		let q = peers[k];
		if (k != p.id)
			push(list, { id: k, name: q.name, dev: q.dev, rtc: q.rtc, max: q.max, since: q.since, same: (q.ip == p.ip) ? 1 : 0 });
	}
	return reply(200, { peers: list, msgs: box.msgs, stun: stun_port() });
}

function act_send(d) {
	let peers = live_peers(), p = auth(peers, d);
	if (p == null)
		return fail(401, '会话已过期，正在重新连接');
	let to = is_token(d.to) ? peers[d.to] : null;
	if (to == null || to.id == p.id)
		return fail(404, '对方已经离开');
	if (d.k != 'sig' && d.k != 'ctl' && d.k != 'txt')
		return fail(400, '无效的消息类型');
	if (d.d == null)
		return fail(400, '消息内容为空');
	let size = length(sprintf('%J', d.d));
	if (size > MSG_BYTES)
		return fail(413, '消息太大');
	let box = mailbox(to.id);
	if (length(box.msgs) >= MAIL_MAX || length(sprintf('%J', box.msgs)) + size > MAIL_BYTES)
		return fail(429, '对方暂时收不到消息，请稍后再试');
	box.n++;
	push(box.msgs, { n: box.n, f: p.id, k: d.k, d: d.d });
	if (!store(mail_file(to.id), box))
		return fail(507, '路由器存储空间不足');
	return reply(200, { ok: true });
}

function act_bye(d) {
	let peers = live_peers(), p = auth(peers, d);
	if (p != null) {
		unlink(peer_file(p.id));
		unlink(mail_file(p.id));
		let dirs = glob(ROOT + '/relay/*');
		for (let i = 0; i < length(dirs); i++) {
			let r = load(dirs[i] + '/meta.json');
			if (r != null && (r.from == p.id || r.to == p.id))
				remove_tree(dirs[i]);
		}
	}
	return reply(200, { ok: true });
}

function act_ropen(d) {
	let peers = live_peers(), p = auth(peers, d);
	if (p == null)
		return fail(401, '会话已过期，正在重新连接');
	let to = is_token(d.to) ? peers[d.to] : null;
	if (to == null || to.id == p.id)
		return fail(404, '对方已经离开');
	if (length(glob(ROOT + '/relay/*')) >= RELAY_MAX)
		return fail(503, '路由器中转通道已满，请稍后再试');
	let rid = token();
	if (rid == null)
		return fail(500, '无法生成传输编号');
	let dir = relay_dir(rid);
	if (!mkdir(dir, 448) || !store(dir + '/meta.json', { from: p.id, to: to.id, t: now, low: 0 })) {
		remove_tree(dir);
		return fail(507, '路由器存储空间不足');
	}
	return reply(200, { rid: rid, chunk: CHUNK });
}

function relay_open(d, role) {
	let p = auth_one(d.id, d.key);
	if (p == null)
		return { err: fail(401, '会话已过期，正在重新连接') };
	if (!is_token(d.r))
		return { err: fail(400, '无效的传输编号') };
	let meta = load(relay_dir(d.r) + '/meta.json');
	if (meta == null || meta[role] != p.id)
		return { err: fail(404, '传输已结束') };
	// 分块收发本身就证明页面在线：后台标签页轮询变慢时不至于过期
	p.seen = now;
	store(peer_file(p.id), p);
	return { meta: meta, dir: relay_dir(d.r) };
}

function chunk_count(dir) {
	if (memory_chunks != null) {
		let count = 0;
		for (let path in memory_chunks)
			if (substr(path, 0, length(dir) + 1) == dir + '/') count++;
		return count;
	}
	let count = 0, files = glob(dir + '/*');
	for (let i = 0; i < length(files); i++)
		if (match(files[i], /\/[0-9]+$/) != null)
			count++;
	return count;
}

function relay_bytes() {
	if (memory_chunks != null) {
		let total = 0;
		for (let path in memory_chunks) total += length(memory_chunks[path].data);
		return total;
	}
	let total = 0, files = glob(ROOT + '/relay/*/*');
	for (let i = 0; i < length(files); i++) {
		if (match(files[i], /\/[0-9]+$/) == null)
			continue;
		let s = stat(files[i]);
		if (s != null)
			total += s.size;
	}
	return total;
}

function chunk_exists(path) { return memory_chunks != null ? memory_chunks[path] != null : stat(path) != null; }
function chunk_remove(path) {
	if (memory_chunks != null) delete memory_chunks[path];
	else { unlink(path); unlink(path + '.c'); }
}

function act_put(q, body) {
	if (type(q.n) != 'string' || match(q.n, /^[0-9]{1,16}$/) == null
	    || (q.c != null && match(q.c, /^[0-9a-f]{8}$/) == null))
		return fail(400, '无效的分块参数');
	let n = int(q.n);
	if (n > 9007199254740991)
		return fail(400, '无效的分块参数');
	let r = relay_open(q, 'from');
	if (r.err != null)
		return r.err;
	let meta = r.meta, dir = r.dir;
	// 重复提交（上次应答丢了）：已收下或已被取走都算成功
	if (n < meta.low || chunk_exists(dir + '/' + n))
		return reply(200, { ok: true });
	if (n > meta.low + RELAY_WINDOW * 2)
		return fail(400, '分块顺序不正确');
	for (let waited = 0; chunk_count(dir) >= RELAY_WINDOW || relay_bytes() + length(body) > RELAY_BYTES; waited += WAIT_STEP) {
		if (waited >= WAIT_MS)
			return fail(429, '对方接收较慢，稍后继续');
		pause();
		meta = load(dir + '/meta.json');
		if (meta == null)
			return fail(404, '传输已结束');
	}
	let path = dir + '/' + n;
	if (memory_chunks != null) {
		// 常驻服务直接保留收到的字节串，避免整块写 tmpfs 后再读出复制。
		memory_chunks[path] = { data: body, crc: q.c };
		meta.t = now;
		store(dir + '/meta.json', meta);
		return reply(200, { ok: true });
	}
	// 校验值先落盘，接收方看到分块时它一定已经在了
	if (q.c != null && writefile(path + '.c', q.c) != 8)
		return fail(507, '路由器存储空间不足');
	if (writefile(path + '.part', body) != length(body) || !rename(path + '.part', path)) {
		unlink(path + '.part');
		unlink(path + '.c');
		return fail(507, '路由器内存不足，请稍后再试');
	}
	meta.t = now;
	store(dir + '/meta.json', meta);
	return reply(200, { ok: true });
}

function act_get(d) {
	if (type(d.n) != 'int' || d.n < 0 || d.n > 9007199254740991)
		return fail(400, '无效的分块序号');
	let r = relay_open(d, 'to');
	if (r.err != null)
		return r.err;
	let meta = r.meta, dir = r.dir, n = d.n;
	if (n < meta.low || n > meta.low + RELAY_WINDOW)
		return fail(400, '分块顺序不正确');
	// 取第 n 块即确认之前的都已收到，删掉腾出窗口；第 n 块留到下次请求，应答丢了还能重取
	for (let i = meta.low; i < n; i++) {
		chunk_remove(dir + '/' + i);
	}
	meta.low = n;
	meta.t = now;
	store(dir + '/meta.json', meta);
	let path = dir + '/' + n;
	for (let waited = 0; !chunk_exists(path); waited += WAIT_STEP) {
		if (waited >= WAIT_MS)
			return reply(204, null);
		pause();
		if (stat(dir + '/meta.json') == null)
			return fail(404, '传输已结束');
	}
	if (memory_chunks != null) {
		let chunk = memory_chunks[path];
		return { code: 200, raw: chunk.data, crc: chunk.crc };
	}
	let data = readfile(path);
	if (type(data) != 'string')
		return fail(500, '读取分块失败');
	let crc = readfile(path + '.c');
	return { code: 200, raw: data, crc: (type(crc) == 'string' && length(crc) == 8) ? crc : null };
}

function act_rclose(d) {
	let p = auth_one(d.id, d.key);
	if (p == null)
		return fail(401, '会话已过期，正在重新连接');
	if (!is_token(d.r))
		return fail(400, '无效的传输编号');
	let dir = relay_dir(d.r), meta = load(dir + '/meta.json');
	if (meta != null && (meta.from == p.id || meta.to == p.id))
		remove_tree(dir);
	return reply(200, { ok: true });
}

// 精确比对 Host/Origin：挡住跨站请求与 DNS 重绑定
function same_origin() {
	let host = request_env('HTTP_HOST'), origin = request_env('HTTP_ORIGIN');
	if (type(host) != 'string' || origin != 'http://' + host)
		return false;
	let port = request_env('SERVER_PORT');
	if (host == request_env('SERVER_ADDR') + ':' + port)
		return true;
	// openwrt.lan 这类名字由 dnsmasq 本地解析（local=/lan/ + domain-needed），外部 DNS 无法冒充
	let m = match(host, /^[a-z0-9-]+(\.lan)?:([0-9]+)$/);
	return m != null && m[2] == port;
}

function parse_query(qs) {
	let q = {};
	if (type(qs) != 'string')
		return q;
	let parts = split(qs, '&');
	for (let i = 0; i < length(parts); i++) {
		let kv = match(parts[i], /^([a-z]{1,3})=([0-9a-z]{1,64})$/);
		if (kv != null)
			q[kv[1]] = kv[2];
	}
	return q;
}

function main() {
	if (request_env('REQUEST_METHOD') != 'POST')
		return fail(405, '仅支持 POST 请求');
	if (!same_origin())
		return fail(403, '请直接用路由器内网地址打开互传页面');
	let len = request_env('CONTENT_LENGTH'), ctype = request_env('CONTENT_TYPE') || '';
	if (type(len) != 'string' || match(len, /^[0-9]{1,8}$/) == null)
		return fail(411, '缺少请求长度');
	len = int(len);
	let q = parse_query(request_env('QUERY_STRING'));
	if (q.a == 'put') {
		if (ctype != 'application/octet-stream')
			return fail(415, '需要二进制分块');
		if (len < 1 || len > CHUNK)
			return fail(413, '分块大小不正确');
		// 先读完正文再加锁：慢速上传不能占着全局锁
		let body = request_body == null ? stdin.read(len) : request_body;
		if (type(body) != 'string' || length(body) != len)
			return fail(400, '分块不完整');
		if (!acquire())
			return fail(503, '服务繁忙，请重试');
		return act_put(q, body);
	}
	if (substr(ctype, 0, 16) != 'application/json')
		return fail(415, '需要 JSON 请求');
	if (len < 2 || len > REQ_BYTES)
		return fail(413, '请求太大');
	let raw = request_body == null ? stdin.read(len) : request_body, d = null;
	try {
		d = json(raw);
	}
	catch (e) {
		d = null;
	}
	if (type(d) != 'object')
		return fail(400, '无效的请求');
	if (!acquire())
		return fail(503, '服务繁忙，请重试');
	switch (d.a) {
	case 'hello':
		return act_hello(d);
	case 'poll':
		return act_poll(d);
	case 'send':
		return act_send(d);
	case 'bye':
		return act_bye(d);
	case 'ropen':
		return act_ropen(d);
	case 'get':
		return act_get(d);
	case 'rclose':
		return act_rclose(d);
	}
	return fail(400, '未知操作');
}

// CGI 和常驻 HTTP 服务共用协议、权限、窗口与磁盘状态。一次调用只处理一个请求。
function request(environment, body, root, wait, chunks) {
	env = environment;
	request_body = body;
	memory_chunks = chunks;
	ROOT = root || '/tmp/lan-transfer';
	WAIT_MS = wait == null ? 800 : wait;
	now = clock(true)[0];
	let result;
	try { result = main(); }
	catch (e) {
		warn(sprintf('lan-transfer: %s\n', e));
		result = fail(500, '服务内部错误');
	}
	// 慢下载不能持共享锁；常驻模式每次请求也必须关闭文件句柄。
	if (lockfh != null) { lockfh.lock('u'); lockfh.close(); lockfh = null; }
	request_body = null;
	env = {};
	return result;
}

export { request, emit };
