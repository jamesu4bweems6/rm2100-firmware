// 在路由器本机隔离测试 HTTP 中转开销；串行 put/get，不代表真实 Wi-Fi 两端速度。
'use strict';
import * as socket from 'socket';
const addr = ARGV[0] || '192.168.1.1';
const port = int(ARGV[1] || '18080');
const count = int(ARGV[2] || '32');
let block = 'abcdefghijklmnopqrstuvwxyz012345';
while (length(block) < 1048576) block += block;
let conn = null;
function post(data, query, binary) {
	if (!conn) {
		conn = socket.connect(addr, port);
		if (!conn) die('connect failed\n');
		conn.setopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, true);
	}
	let body = binary ? data : sprintf('%J', data);
	let out = sprintf('POST /cgi-bin/api%s HTTP/1.1\r\nHost: %s:%d\r\nOrigin: http://%s:%d\r\nContent-Type: %s\r\nContent-Length: %d\r\n\r\n',
		query || '', addr, port, addr, port, binary ? 'application/octet-stream' : 'application/json', length(body)) + body;
	for (let offset = 0; offset < length(out);) {
		let n = conn.send(substr(out, offset, 65536));
		if (!n) die('send failed\n');
		offset += n;
	}
	let buf = '', end;
	while ((end = index(buf, '\r\n\r\n')) < 0) {
		let part = conn.recv(65536);
		if (!length(part)) die('headers failed\n');
		buf += part;
	}
	let head = substr(buf, 0, end), size = int(match(head, /[Cc]ontent-[Ll]ength: ([0-9]+)/)[1]);
	if (!match(head, /^HTTP\/1\.[01] 200 /)) die(head + '\n' + substr(buf, end + 4) + '\n');
	let raw = substr(buf, end + 4);
	while (length(raw) < size) {
		let part = conn.recv(65536);
		if (!length(part)) die('body failed\n');
		raw += part;
	}
	if (match(head, /[Cc]onnection: close/)) { conn.close(); conn = null; }
	return match(head, /[Cc]ontent-[Tt]ype: application\/json/) ? json(raw) : raw;
}
let a = post({ a: 'hello', name: 'router bench sender', rtc: 0 });
let b = post({ a: 'hello', name: 'router bench receiver', rtc: 0 });
let rid = post({ a: 'ropen', id: a.id, key: a.key, to: b.id }).rid;
let start = clock(true);
for (let n = 0; n < count; n++) {
	post(block, sprintf('?a=put&id=%s&key=%s&r=%s&n=%d', a.id, a.key, rid, n), true);
	let data = post({ a: 'get', id: b.id, key: b.key, r: rid, n: n });
	if (data != block) die('data mismatch\n');
}
let end = clock(true), elapsed = end[0] - start[0] + (end[1] - start[1]) / 1e9;
post({ a: 'rclose', id: a.id, key: a.key, r: rid });
post({ a: 'bye', id: a.id, key: a.key });
post({ a: 'bye', id: b.id, key: b.key });
if (conn) conn.close();
printf('%J\n', { port: port, bytes: count * length(block), seconds: elapsed, MB_s: count * length(block) / elapsed / 1e6, verified: true });
