#!/usr/bin/ucode
// 远程开机：路由器主动与巴法云（bemfa.com）保持一条 TCP 长连接，收到 on 指令就唤醒对应电脑。
//
// 为什么这样做：路由器在校园网 NAT 后面，没有公网 IP，外面连不进来；
// 反过来由路由器连出去订阅主题，手机 App、小程序或米家（小爱同学）向主题发 on，云端再推给路由器。
//
// 用法：bemfa.uc <服务器> <端口> <私钥> <同步状态 0|1> <主题>=<MAC> [<主题>=<MAC> ...]
// 参数由 /etc/init.d/remote-wol 校验后传入；这里再校验一遍，任何一项不合法就直接退出。
//
// 协议（https://cloud.bemfa.com/docs/src/tcp.html）：每条指令以 \r\n 结尾，字段用 & 分隔。
//   订阅：cmd=1&uid=<私钥>&topic=a,b      应答 cmd=1&res=1（单次最多 8 个主题）
//   推送：cmd=2&uid=<私钥>&topic=a&msg=on
//   发布：cmd=2&uid=<私钥>&topic=a/up&msg=off   主题加 /up 只更新云端状态，不推送给订阅者
//   心跳：ping                            应答 cmd=0&res=1；超过 65 秒不发任何数据会被断开
// 只用 cmd=1：cmd=3 会在订阅时补发最后一条历史消息，断线重连就会误开机。
//
// 米家状态同步：米家里显示的开关状态是主题的最后一条消息。只靠用户发的指令，
// 电脑自己关机、开机失败时米家会一直显示「已开启」。所以路由器定时探测电脑是否在线，
// 与云端不一致时用 /up 把真实的 on/off 写回（不推送给订阅者，不会触发唤醒）。
'use strict';

import * as socket from 'socket';
import { mkdir, readfile, writefile, rename } from 'fs';

const STATE_DIR = '/tmp/remote-wol';
const WAKE = '/usr/share/remote-wol/wake';
const ARP = '/proc/net/arp';
const LEASES = '/tmp/dhcp.leases';
const PING_EVERY = 30;      // 秒；官方建议 60 秒内至少一次，留足余量
const IDLE_LIMIT = 75;      // 秒；连 ping 的应答都收不到，说明连接已经死了
const TICK = 1000;          // 毫秒；poll 等待上限，保证心跳、探测与超时检查准时
const RETRY_MIN = 5;        // 秒；重连间隔下限
const RETRY_MAX = 120;      // 秒；重连间隔上限
const WAKE_GAP = 5;         // 秒；同一台电脑短时间内重复的指令只执行一次
const PROBE_FIRST = 10;     // 秒；第一次探测后多久读取结果（ARP 解析失败最长约 8 秒）
const PROBE_EVERY = 30;     // 秒；之后每隔多久探测一次在线状态
const GRACE = 180;          // 秒；收到指令后给电脑开机/关机留的时间，期间不改写云端状态
const MAX_HOSTS = 8;
const MAX_LINE = 4096;
const MAX_HISTORY = 10;

function log(msg) {
	warn('remote-wol: ' + msg + '\n');
}

function now() {
	return clock(true)[0];
}

const server = ARGV[0], port = int(ARGV[1]), uid = ARGV[2], sync = ARGV[3] == '1';
const hosts = {}, topics = [];

// int(null) 得到 NaN，NaN 与任何数比较都为假，所以端口先用正则把关
if (!match(server, /^[A-Za-z0-9.-]{1,253}$/) || !match(ARGV[1], /^[0-9]{1,5}$/) || port < 1 || port > 65535
    || !match(uid, /^[A-Za-z0-9]{1,64}$/) || !match(ARGV[3], /^[01]$/)) {
	log('服务器、端口、私钥或同步参数无效');
	exit(2);
}
for (let i = 4; i < length(ARGV); i++) {
	let m = match(ARGV[i], /^([A-Za-z0-9]{1,64})=([0-9A-F]{2}(:[0-9A-F]{2}){5})$/);
	if (!m || hosts[m[1]] || length(topics) >= MAX_HOSTS) {
		log('主机参数无效或重复：' + ARGV[i]);
		exit(2);
	}
	hosts[m[1]] = m[2];
	push(topics, m[1]);
}
if (!length(topics)) {
	log('没有可唤醒的主机');
	exit(2);
}

// 每台电脑的探测状态：online 为 null 表示还没有结果；published 是认为云端当前保存的状态
const probe = {};
for (let t in topics)
	probe[t] = { ip: null, online: null, probed: false, published: null, grace: 0 };

const status = {
	state: 'connecting', since: time(), alive: null, error: null,
	server: server, port: port, topics: topics, sync: sync, hosts: {}, wakes: []
};

function save() {
	mkdir(STATE_DIR, 448);
	if (writefile(STATE_DIR + '/status.json.tmp', sprintf('%J', status)) != null)
		rename(STATE_DIR + '/status.json.tmp', STATE_DIR + '/status.json');
}

function set_state(state, error) {
	if (status.state != state || status.error != error) {
		status.state = state;
		status.since = time();
		status.error = error;
		if (error) log(error);
		save();
	}
}

function parse(line) {
	let f = {};
	for (let kv in split(line, '&')) {
		let i = index(kv, '=');
		if (i > 0) f[substr(kv, 0, i)] = substr(kv, i + 1);
	}
	return f;
}

// ---- 在线探测 ----
// 不用 ping：Windows 防火墙默认不回 ICMP。ARP 是二层协议，电脑开着就一定会应答。
// 做法：向电脑 IP 的 UDP 9 端口（discard）发 1 字节，内核为此重新确认 ARP；
// 下一轮读 /proc/net/arp：标志含 0x2（已解析）说明电脑在线，解析失败的条目 MAC 会变成全 0。

const udp = sync ? socket.create(socket.AF_INET, socket.SOCK_DGRAM) : null;
let next_probe = 0;

function ipv4(s) {
	return match(s, /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/) ? s : null;
}

function read_arp() {
	let r = {};
	for (let line in split(readfile(ARP) ?? '', '\n')) {
		let f = split(trim(line), /[ \t]+/);
		if (length(f) >= 4 && ipv4(f[0]) && match(f[2], /^0x[0-9a-fA-F]+$/))
			r[uc(f[3])] = { ip: f[0], complete: (hex(substr(f[2], 2)) & 2) != 0 };
	}
	return r;
}

// dnsmasq 租约：<到期时间> <MAC> <IP> <主机名> <客户端 ID>
function read_leases() {
	let r = {};
	for (let line in split(readfile(LEASES) ?? '', '\n')) {
		let f = split(trim(line), ' ');
		if (length(f) >= 3 && ipv4(f[2]))
			r[uc(f[1])] = f[2];
	}
	return r;
}

function run_probe() {
	let arp = read_arp(), leases = read_leases(), changed = false;
	for (let t in topics) {
		let p = probe[t], a = arp[hosts[t]];
		// 先读上一轮探测的结果，再发下一轮
		if (p.probed) {
			let online = !!(a && a.complete);
			if (online !== p.online) {
				p.online = online;
				changed = true;
			}
		}
		let ip = (a && a.ip) || leases[hosts[t]] || p.ip;
		if (ip != p.ip) {
			p.ip = ip;
			changed = true;
		}
		if (ip) {
			udp.send('\0', 0, { family: socket.AF_INET, address: ip, port: 9 });
			p.probed = true;
		}
		else if (p.online == null) {
			// 开机以来没见过这台电脑，也没有 DHCP 租约：视为离线
			p.online = false;
			changed = true;
		}
		status.hosts[t] = { online: p.online, ip: p.ip };
	}
	if (changed)
		save();
}

// 写回云端：只在与云端不一致、且不在指令宽限期内时发送
function publish_states(conn) {
	for (let t in topics) {
		let p = probe[t];
		if (p.online == null || now() < p.grace)
			continue;
		let want = p.online ? 'on' : 'off';
		if (p.published == want)
			continue;
		if (conn.send(sprintf('cmd=2&uid=%s&topic=%s/up&msg=%s\r\n', uid, t, want)) == null)
			return false;
		p.published = want;
		log(sprintf('同步状态到云端：%s 为 %s', t, want));
	}
	return true;
}

// ---- 指令处理 ----

const last_wake = {};

function wake(topic, msg) {
	let t = now();
	if (last_wake[topic] != null && t - last_wake[topic] < WAKE_GAP)
		return;
	last_wake[topic] = t;
	// 数组形式直接 exec，不经过 shell；MAC 已在启动时校验
	let rc = system([WAKE, hosts[topic]], 5000);
	log(sprintf('主题 %s 收到 %s，唤醒 %s：%s', topic, msg, hosts[topic], rc == 0 ? '已发送魔术包' : '失败（退出码 ' + rc + '）'));
	unshift(status.wakes, { topic: topic, mac: hosts[topic], time: time(), ok: rc == 0 });
	if (length(status.wakes) > MAX_HISTORY)
		status.wakes = slice(status.wakes, 0, MAX_HISTORY);
	save();
}

// 返回 false 表示应当断开重连
function handle(line) {
	let f = parse(line);
	if (f.cmd == '1') {
		if (f.res != '1') {
			set_state('error', '订阅被拒绝，请检查巴法云私钥和主题是否已在控制台创建');
			return false;
		}
		set_state('online', null);
	}
	else if (f.cmd == '2' && f.topic != null && f.msg != null) {
		// 主题可能带 /set 之类的后缀；消息可能是 on、on#参数，或 off
		let topic = split(f.topic, '/')[0], msg = lc(trim(f.msg));
		if (!hosts[topic])
			return true;
		let on = msg == 'on' || substr(msg, 0, 3) == 'on#';
		if (on || msg == 'off' || substr(msg, 0, 4) == 'off#') {
			// 云端状态已被这条指令改写；宽限期过后若与实际不符再写回
			probe[topic].published = on ? 'on' : 'off';
			probe[topic].grace = now() + GRACE;
		}
		if (on)
			wake(topic, msg);
	}
	return true;
}

function session() {
	let conn = socket.connect(server, port, { socktype: socket.SOCK_STREAM }, 10000);
	if (!conn) {
		set_state('offline', '连接 ' + server + ':' + port + ' 失败：' + socket.error());
		return false;
	}
	let online = false, buf = '', last_rx = now(), last_tx = now();
	// 断线期间云端状态可能被改过，重连后重新写一次
	for (let t in topics)
		probe[t].published = null;
	if (conn.send(sprintf('cmd=1&uid=%s&topic=%s\r\n', uid, join(',', topics))) == null) {
		conn.close();
		set_state('offline', '发送订阅失败：' + socket.error());
		return false;
	}
	while (true) {
		let events = socket.poll(TICK, [conn, socket.POLLIN]);
		if (events == null) {
			set_state('offline', 'poll 失败：' + socket.error());
			break;
		}
		let flags = events[0]?.[1] ?? 0;
		if (flags & (socket.POLLIN | socket.POLLHUP | socket.POLLERR | socket.POLLNVAL)) {
			let data = conn.recv(4096);
			if (data == null || data == '') {
				set_state('offline', data == null ? '接收失败：' + socket.error() : '服务器关闭了连接');
				break;
			}
			last_rx = now();
			buf += data;
			let ok = true, i;
			while (ok && (i = index(buf, '\n')) >= 0) {
				let line = trim(substr(buf, 0, i));
				buf = substr(buf, i + 1);
				if (line != '')
					ok = handle(line);
			}
			if (!ok)
				break;
			if (length(buf) > MAX_LINE) {
				set_state('offline', '服务器返回了无法识别的数据');
				break;
			}
			if (status.state == 'online') {
				online = true;
				status.alive = time();
				save();
			}
		}
		if (sync && now() >= next_probe) {
			run_probe();
			next_probe = now() + (next_probe == 0 ? PROBE_FIRST : PROBE_EVERY);
		}
		if (sync && status.state == 'online' && !publish_states(conn)) {
			set_state('offline', '同步状态失败：' + socket.error());
			break;
		}
		if (now() - last_tx >= PING_EVERY) {
			if (conn.send('ping\r\n') == null) {
				set_state('offline', '发送心跳失败：' + socket.error());
				break;
			}
			last_tx = now();
		}
		if (now() - last_rx > IDLE_LIMIT) {
			set_state('offline', '超过 ' + IDLE_LIMIT + ' 秒没有收到服务器数据');
			break;
		}
	}
	conn.close();
	return online;
}

if (sync && !udp) {
	log('无法创建探测用 UDP 套接字：' + socket.error());
	exit(1);
}

save();
log(sprintf('启动，服务器 %s:%d，主题 %s，米家状态同步%s', server, port, join(',', topics), sync ? '开启' : '关闭'));

// 断网（如校园网未认证）时指数退避，最长 2 分钟重试一次；私钥被拒绝时直接按最长间隔重试
let delay = 0;
while (true) {
	if (status.state != 'connecting' && status.state != 'error')
		set_state('connecting', status.error);
	if (session())
		delay = RETRY_MIN;
	else if (status.state == 'error')
		delay = RETRY_MAX;
	else
		delay = min(max(delay * 2, RETRY_MIN), RETRY_MAX);
	sleep(delay * 1000);
}
