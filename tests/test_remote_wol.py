"""远程开机回归测试。

python tests/test_remote_wol.py
init 脚本与唤醒脚本用 BusyBox ash / dash 实跑（Windows 用 Git for Windows 自带的 dash）；
守护进程需原生 ucode + socket 模块（CI），对着本机假巴法云服务器跑真实 TCP。
"""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest

from test_lan_transfer import native_socket_module, shell, ucode_command

ROOT = Path(__file__).resolve().parents[1]
INIT = ROOT / 'files/etc/init.d/remote-wol'
DEFAULTS = ROOT / 'files/etc/uci-defaults/90-remote-wol'
DAEMON = ROOT / 'files/usr/share/remote-wol/bemfa.uc'
WAKE = ROOT / 'files/usr/share/remote-wol/wake'
VIEW = ROOT / 'files/www/luci-static/resources/view/remote-wol-v3.js'
ACL = ROOT / 'files/usr/share/rpcd/acl.d/luci-app-remote-wol.json'
MENU = ROOT / 'files/usr/share/luci/menu.d/luci-app-remote-wol.json'
UCITRACK = ROOT / 'files/usr/share/ucitrack/remote-wol.json'
CONFIG = ROOT / 'files/etc/config/remote-wol'


def run_sh(sh, text, temp, env=None):
    script = Path(temp) / 'run.sh'
    script.write_text(text, encoding='utf-8', newline='\n')
    environ = {k: v for k, v in os.environ.items() if not k.startswith('CFG_')}
    environ.update(env or {})
    return subprocess.run(sh + [script.as_posix()], capture_output=True, encoding='utf-8', env=environ, timeout=20)


class InitTests(unittest.TestCase):
    """用桩函数代替 uci/procd，核对 init 脚本最终交给 procd 的命令行。"""

    STUBS = r"""
config_load() { :; }
config_get() {
	eval "__v=\${CFG_$2_$3-__unset__}"
	[ "$__v" = __unset__ ] && __v=$4
	eval "$1=\$__v"
}
config_get_bool() {
	config_get "$@"
	eval "__v=\$$1"
	case "$__v" in 1|on|true|yes|enabled) eval "$1=1" ;; *) eval "$1=0" ;; esac
}
config_foreach() { for __s in $SECTIONS; do "$1" "$__s"; done; }
logger() { echo "log $*"; }
procd_open_instance() { echo "open $1"; }
procd_set_param() { echo "param $*"; }
procd_close_instance() { echo "close"; }
procd_add_reload_trigger() { echo "reload-trigger $*"; }
"""

    def setUp(self):
        self.sh = shell()
        if not self.sh:
            self.skipTest('需要 busybox ash 或 dash')
        self.temp = tempfile.TemporaryDirectory(prefix='remote-wol-init-')
        self.addCleanup(self.temp.cleanup)

    def run_init(self, **env):
        body = INIT.read_text(encoding='utf-8').replace('#!/bin/sh /etc/rc.common\n', '')
        base = {'CFG_main_enabled': '1', 'CFG_main_uid': 'abc123', 'SECTIONS': 'h1',
                'CFG_h1_mac': 'aa:bb:cc:dd:ee:0f', 'CFG_h1_topic': 'pc001'}
        base.update(env)
        result = run_sh(self.sh, self.STUBS + body + '\nstart_service\nservice_triggers\n', self.temp.name,
                        {k: v for k, v in base.items() if v is not None})
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def command(self, out):
        lines = [line for line in out.splitlines() if line.startswith('param command ')]
        return lines[0][len('param command '):].split() if lines else None

    def test_default_command_and_trigger(self):
        out = self.run_init()
        self.assertEqual(self.command(out), ['/usr/bin/ucode', '/usr/share/remote-wol/bemfa.uc', 'bemfa.com', '8344',
                                             'abc123', '1', 'pc001=AA:BB:CC:DD:EE:0F'])
        self.assertEqual(self.command(self.run_init(CFG_main_sync_state='0'))[5], '0', '可关闭米家状态同步')
        self.assertEqual(out.count('open '), 1)
        self.assertIn('param respawn', out)
        self.assertIn('reload-trigger remote-wol', out)

    def test_disabled_or_incomplete_does_not_start(self):
        for env in [{'CFG_main_enabled': None}, {'CFG_main_enabled': '0'}, {'CFG_main_uid': ''},
                    {'CFG_main_uid': 'abc;reboot'}, {'CFG_main_uid': 'a b'}, {'CFG_main_uid': 'a' * 65},
                    {'SECTIONS': ''}, {'CFG_h1_mac': 'zz:bb:cc:dd:ee:ff'}, {'CFG_h1_topic': 'pc/001'}]:
            with self.subTest(env=env):
                self.assertNotIn('open ', self.run_init(**env))

    def test_host_validation_dedupe_and_limit(self):
        env = {'SECTIONS': ' '.join(f'h{i}' for i in range(1, 13))}
        for i in range(1, 13):
            env[f'CFG_h{i}_mac'] = f'00-11-22-33-44-{i:02x}'
            env[f'CFG_h{i}_topic'] = f'pc{i:03d}'
        env.update({'CFG_h2_topic': 'pc001', 'CFG_h3_enabled': '0', 'CFG_h4_mac': '00:11:22:33:44',
                    'CFG_h5_topic': 'pc 005', 'CFG_h6_topic': 'x' * 65})
        cmd = self.command(self.run_init(**env))
        hosts = cmd[6:]
        self.assertEqual(hosts, ['pc001=00:11:22:33:44:01', 'pc007=00:11:22:33:44:07', 'pc008=00:11:22:33:44:08',
                                 'pc009=00:11:22:33:44:09', 'pc010=00:11:22:33:44:0A', 'pc011=00:11:22:33:44:0B',
                                 'pc012=00:11:22:33:44:0C'])
        env['SECTIONS'] = ' '.join(f'h{i}' for i in (1, 7, 8, 9, 10, 11, 12)) + ' ' + ' '.join(f'x{i}' for i in range(3))
        for i in range(3):
            env[f'CFG_x{i}_mac'] = '00:11:22:33:55:0%d' % i
            env[f'CFG_x{i}_topic'] = f'nas{i}'
        out = self.run_init(**env)
        self.assertEqual(len(self.command(out)) - 6, 8, '巴法云单次订阅最多 8 个主题')
        self.assertIn('最多 8 台电脑', out)

    def test_server_and_port_fallback(self):
        for server, port, expect in [('bemfa.com', '8340', ['bemfa.com', '8340']), ('evil;host', '0', ['bemfa.com', '8344']),
                                     ('', 'abc', ['bemfa.com', '8344']), ('example.org', '70000', ['example.org', '8344'])]:
            with self.subTest(server=server, port=port):
                cmd = self.command(self.run_init(CFG_main_server=server, CFG_main_port=port))
                self.assertEqual(cmd[2:4], expect)

    def test_shell_syntax(self):
        for path in [INIT, DEFAULTS, WAKE]:
            result = subprocess.run(self.sh + ['-n', path.as_posix()], capture_output=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, f'{path.name}: {result.stderr}')


class WakeScriptTests(unittest.TestCase):
    def setUp(self):
        self.sh = shell()
        if not self.sh:
            self.skipTest('需要 busybox ash 或 dash')
        self.temp = tempfile.TemporaryDirectory(prefix='remote-wol-wake-')
        self.addCleanup(self.temp.cleanup)
        self.log = Path(self.temp.name) / 'etherwake.log'
        fake = Path(self.temp.name) / 'etherwake'
        fake.write_text(f'#!/bin/sh\necho "$@" >> {self.log.as_posix()}\n', encoding='utf-8', newline='\n')
        self.fake = fake

    def run_wake(self, mac, network=None):
        body = WAKE.read_text(encoding='utf-8').replace('exec /usr/bin/etherwake', 'exec sh ' + self.fake.as_posix())
        if network is None:
            body = body.replace('/lib/functions/network.sh', Path(self.temp.name, 'missing.sh').as_posix())
        else:
            lib = Path(self.temp.name) / 'network.sh'
            lib.write_text(network, encoding='utf-8', newline='\n')
            body = body.replace('/lib/functions/network.sh', lib.as_posix())
        return run_sh(self.sh, body.replace('"$1"', '"$WAKE_MAC"', 1), self.temp.name, {'WAKE_MAC': mac})

    def test_normalizes_mac_and_uses_lan_device(self):
        result = self.run_wake('aa-bb-cc-dd-ee-0f', 'network_get_device() { eval "$1=br-test"; }\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text().split(), ['-b', '-i', 'br-test', 'AA:BB:CC:DD:EE:0F'])

    def test_falls_back_to_br_lan(self):
        result = self.run_wake('00:11:22:33:44:55')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text().split(), ['-b', '-i', 'br-lan', '00:11:22:33:44:55'])

    def test_rejects_invalid_mac(self):
        for mac in ['', '00:11:22:33:44', '00:11:22:33:44:55:66', 'gg:11:22:33:44:55', '00:11:22:33:44:55;reboot',
                    '-i eth0', '0:1:2:3:4:5']:
            with self.subTest(mac=mac):
                result = self.run_wake(mac)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.log.exists(), '无效 MAC 不能调用 etherwake')


class FakeBemfa:
    """最小的巴法云 TCP 服务器：记录客户端发来的每一行，可主动推送、断开。"""

    def __init__(self, sub_reply='cmd=1&res=1'):
        self.sub_reply = sub_reply
        self.lines = []
        self.conns = []
        self.answer_ping = True
        self.lock = threading.Condition()
        self.server = socket.socket()
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(('127.0.0.1', 0))
        self.server.listen()
        self.port = self.server.getsockname()[1]
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with self.lock:
                self.conns.append(conn)
                self.lock.notify_all()
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def serve(self, conn):
        buf = b''
        while True:
            try:
                data = conn.recv(4096)
            except OSError:
                return
            if not data:
                return
            buf += data
            while b'\r\n' in buf:
                line, buf = buf.split(b'\r\n', 1)
                line = line.decode()
                with self.lock:
                    self.lines.append(line)
                    self.lock.notify_all()
                try:
                    if line.startswith('cmd=1&'):
                        conn.sendall(self.sub_reply.encode() + b'\r\n')
                    elif line.startswith('cmd=2&'):
                        conn.sendall(b'cmd=2&res=1\r\n')
                    elif line == 'ping' and self.answer_ping:
                        conn.sendall(b'cmd=0&res=1\r\n')
                except OSError:
                    return

    def push(self, raw):
        with self.lock:
            self.conns[-1].sendall(raw.encode())

    def wait(self, predicate, timeout=15):
        with self.lock:
            return self.lock.wait_for(lambda: predicate(self), timeout)

    def close_clients(self):
        with self.lock:
            for conn in self.conns:
                try:
                    conn.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                conn.close()

    def close(self):
        self.server.close()
        self.close_clients()


class DaemonTests(unittest.TestCase):
    """原生 ucode 实跑守护进程，对着本机假服务器走真实 TCP（仅 CI）。"""

    UID = '0123456789abcdef0123456789abcdef'

    def setUp(self):
        if not native_socket_module():
            self.skipTest('需要带 socket 模块的原生 ucode')
        self.temp = tempfile.TemporaryDirectory(prefix='remote-wol-daemon-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.state = root / 'state'
        self.log = root / 'wake.log'
        fake = root / 'wake'
        fake.write_text(f'#!/bin/sh\necho "$@" >> {self.log}\n', encoding='utf-8', newline='\n')
        fake.chmod(0o755)
        self.arp = root / 'arp'
        self.leases = root / 'leases'
        self.set_arp()
        self.leases.write_text('', encoding='utf-8')
        source = DAEMON.read_text(encoding='utf-8')
        # 缩短心跳与超时，测试不必等 30 秒
        for old, new in [("'/tmp/remote-wol'", json.dumps(str(self.state))), ("'/usr/share/remote-wol/wake'", json.dumps(str(fake))),
                         ('PING_EVERY = 30;', 'PING_EVERY = 1;'), ('TICK = 1000;', 'TICK = 200;'), ('IDLE_LIMIT = 75;', 'IDLE_LIMIT = 3;'),
                         ('RETRY_MIN = 5;', 'RETRY_MIN = 1;'), ("'/proc/net/arp'", json.dumps(str(self.arp))),
                         ("'/tmp/dhcp.leases'", json.dumps(str(self.leases))), ('PROBE_FIRST = 10;', 'PROBE_FIRST = 1;'),
                         ('PROBE_EVERY = 30;', 'PROBE_EVERY = 1;'), ('GRACE = 180;', 'GRACE = 5;')]:
            self.assertIn(old, source)
            source = source.replace(old, new)
        self.script = root / 'bemfa.uc'
        self.script.write_text(source, encoding='utf-8', newline='\n')

    def set_arp(self, *entries):
        # 与 /proc/net/arp 同格式：IP、硬件类型、标志、MAC、掩码、设备
        lines = ['IP address       HW type     Flags       HW address            Mask     Device']
        lines += [f'{ip:<16} 0x1         {flags:<11} {mac:<21} *        br-lan' for ip, flags, mac in entries]
        tmp = self.arp.with_suffix('.tmp')
        tmp.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        os.replace(tmp, self.arp)

    def start(self, server, *hosts, sync='0'):
        process = subprocess.Popen(ucode_command() + [str(self.script), '127.0.0.1', str(server.port), self.UID, sync, *hosts],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is None and (process.kill(), process.communicate()))
        return process

    def status(self):
        try:
            return json.loads((self.state / 'status.json').read_text())
        except (OSError, ValueError):
            return {}

    def wait_for(self, predicate, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return True
            time.sleep(.05)
        return False

    def wakes(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def server(self, **kw):
        server = FakeBemfa(**kw)
        self.addCleanup(server.close)
        return server

    def test_subscribe_wake_and_filtering(self):
        server = self.server()
        self.start(server, 'pc001=AA:BB:CC:DD:EE:01', 'nas001=AA:BB:CC:DD:EE:02')
        self.assertTrue(server.wait(lambda s: s.lines))
        self.assertEqual(server.lines[0], f'cmd=1&uid={self.UID}&topic=pc001,nas001')
        self.assertTrue(self.wait_for(lambda: self.status().get('state') == 'online'), self.status())
        for msg in ['off', 'onx', 'ON ']:
            server.push(f'cmd=2&uid={self.UID}&topic=pc001&msg={msg}\r\n')
        server.push(f'cmd=2&uid={self.UID}&topic=other&msg=on\r\ncmd=3&uid={self.UID}&topic=nas001&msg=on\r\n')
        self.assertTrue(self.wait_for(lambda: self.wakes()), '大小写和空白不影响 on 指令')
        # 一条推送拆成两段到达，且紧接着重复一次（5 秒内去重）
        server.push(f'cmd=2&uid={self.UID}&topic=nas0')
        time.sleep(.2)
        server.push(f'01/set&msg=on#1\ncmd=2&uid={self.UID}&topic=nas001&msg=on\r\n')
        self.assertTrue(self.wait_for(lambda: len(self.wakes()) >= 2))
        time.sleep(1)
        self.assertEqual(self.wakes(), ['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02'])
        status = self.status()
        self.assertEqual([(w['topic'], w['ok']) for w in status['wakes']], [('nas001', True), ('pc001', True)])
        self.assertNotIn(self.UID, json.dumps(status), '状态文件不能泄露私钥')
        self.assertFalse([line for line in server.lines if '/up' in line], '关闭同步时不写回状态')

    def up(self, server, topic, msg):
        return server.lines.count(f'cmd=2&uid={self.UID}&topic={topic}/up&msg={msg}')

    def test_state_sync_for_mijia(self):
        # pc001 在 ARP 表里已解析（在线）；nas001 只有 DHCP 租约、ARP 解析不到（离线）；tv001 从没出现过
        self.set_arp(('127.0.0.2', '0x2', 'aa:bb:cc:dd:ee:01'), ('127.0.0.9', '0x0', '00:00:00:00:00:00'))
        self.leases.write_text('9999999999 aa:bb:cc:dd:ee:02 127.0.0.3 nas *\n', encoding='utf-8')
        server = self.server()
        self.start(server, 'pc001=AA:BB:CC:DD:EE:01', 'nas001=AA:BB:CC:DD:EE:02', 'tv001=AA:BB:CC:DD:EE:03', sync='1')
        self.assertTrue(server.wait(lambda s: self.up(s, 'pc001', 'on') and self.up(s, 'nas001', 'off')
                                    and self.up(s, 'tv001', 'off')), server.lines)
        hosts = self.status()['hosts']
        self.assertEqual(hosts['pc001'], {'online': True, 'ip': '127.0.0.2'})
        self.assertEqual(hosts['nas001'], {'online': False, 'ip': '127.0.0.3'})
        self.assertEqual(hosts['tv001'], {'online': False, 'ip': None})
        # 状态不变就不重复写
        time.sleep(2.5)
        self.assertEqual((self.up(server, 'pc001', 'on'), self.up(server, 'nas001', 'off')), (1, 1))
        # pc001 关机：ARP 解析失败
        self.set_arp(('127.0.0.2', '0x0', '00:00:00:00:00:00'))
        self.assertTrue(server.wait(lambda s: self.up(s, 'pc001', 'off') == 1), server.lines)
        self.assertEqual(self.status()['hosts']['pc001'], {'online': False, 'ip': '127.0.0.2'}, '保留最后已知 IP 继续探测')
        # 米家发 on 唤醒 nas001，但它没开起来：宽限期内不改写，过后写回 off
        server.push(f'cmd=2&uid={self.UID}&topic=nas001&msg=on\r\n')
        self.assertTrue(self.wait_for(lambda: self.wakes() == ['AA:BB:CC:DD:EE:02']))
        time.sleep(1.5)
        self.assertEqual(self.up(server, 'nas001', 'off'), 1, '宽限期内不改写云端状态')
        self.assertTrue(server.wait(lambda s: self.up(s, 'nas001', 'off') == 2, timeout=10), server.lines)
        # pc001 开机后写回 on
        self.set_arp(('127.0.0.2', '0x2', 'AA:BB:CC:DD:EE:01'))
        self.assertTrue(server.wait(lambda s: self.up(s, 'pc001', 'on') == 2), server.lines)
        # 断线重连后重新写一遍全部状态
        server.close_clients()
        self.assertTrue(server.wait(lambda s: self.up(s, 'pc001', 'on') == 3 and self.up(s, 'tv001', 'off') == 2), server.lines)
        self.assertEqual(self.wakes(), ['AA:BB:CC:DD:EE:02'], '同步状态不能触发开机')

    def test_heartbeat_reconnect_and_resubscribe(self):
        server = self.server()
        process = self.start(server, 'pc001=AA:BB:CC:DD:EE:01')
        self.assertTrue(server.wait(lambda s: 'ping' in s.lines), '应定时发送心跳')
        server.close_clients()
        self.assertTrue(server.wait(lambda s: s.lines.count(f'cmd=1&uid={self.UID}&topic=pc001') >= 2),
                        '断线后应重连并重新订阅')
        self.assertTrue(self.wait_for(lambda: self.status().get('state') == 'online'))
        # 服务器不再应答：超过 IDLE_LIMIT 判定连接已死，主动重连
        server.answer_ping = False
        count = server.lines.count(f'cmd=1&uid={self.UID}&topic=pc001')
        self.assertTrue(server.wait(lambda s: s.lines.count(f'cmd=1&uid={self.UID}&topic=pc001') > count, timeout=20))
        self.assertIsNone(process.poll())
        self.assertEqual(self.wakes(), [], '重连不能触发开机')

    def test_rejected_subscription(self):
        server = self.server(sub_reply='cmd=1&res=0')
        self.start(server, 'pc001=AA:BB:CC:DD:EE:01')
        self.assertTrue(self.wait_for(lambda: self.status().get('state') == 'error'), self.status())
        self.assertIn('私钥', self.status()['error'])

    def test_unreachable_server_backs_off(self):
        # 占住一个端口但不 listen：连接会被立即拒绝。不能用关闭监听套接字来模拟，
        # Linux 上另一线程里阻塞的 accept() 不会因 close() 中断，仍会接受连接。
        holder = socket.socket()
        self.addCleanup(holder.close)
        holder.bind(('127.0.0.1', 0))

        class Closed:
            port = holder.getsockname()[1]

        process = self.start(Closed, 'pc001=AA:BB:CC:DD:EE:01')
        self.assertTrue(self.wait_for(lambda: self.status().get('state') in ('offline', 'connecting')
                                      and self.status().get('error')), self.status())
        self.assertIn('失败', self.status()['error'])
        self.assertIsNone(process.poll(), '连不上服务器时守护进程应常驻重试')

    def test_rejects_bad_arguments(self):
        server = self.server()
        for args in [[], ['pc001=aa:bb:cc:dd:ee:01'], ['pc/1=AA:BB:CC:DD:EE:01'], ['pc001=AA:BB:CC:DD:EE'],
                     ['pc001=AA:BB:CC:DD:EE:01', 'pc001=AA:BB:CC:DD:EE:02'],
                     [f'pc{i}=AA:BB:CC:DD:EE:0{i}' for i in range(9)]]:
            with self.subTest(args=args):
                process = self.start(server, *args)
                self.assertEqual(process.wait(timeout=10), 2)
        for argv in [['127.0.0.1', 'x', self.UID, '0'], ['127.0.0.1', '8344', 'bad uid', '0'],
                     ['bad host!', '8344', self.UID, '0'], ['127.0.0.1', '8344', self.UID, '2']]:
            with self.subTest(argv=argv):
                process = subprocess.run(ucode_command() + [str(self.script), *argv, 'pc001=AA:BB:CC:DD:EE:01'],
                                         capture_output=True, timeout=10)
                self.assertEqual(process.returncode, 2)


class FileTests(unittest.TestCase):
    WEB = ROOT / 'files/www/remote-wol'
    FILES = [INIT, DEFAULTS, DAEMON, WAKE, VIEW, ACL, MENU, UCITRACK, CONFIG, ROOT / 'docs/remote-wol.md',
             WEB / 'index.html', WEB / 'app.js', WEB / 'bemfa.js', ROOT / 'tests/test_remote_wol_web.cjs',
             ROOT / 'ios/project.yml', ROOT / '.github/workflows/ios.yml',
             *sorted((ROOT / 'ios').rglob('*.swift')), *sorted((ROOT / 'ios').rglob('Contents.json'))]

    def test_text_files(self):
        for path in self.FILES:
            with self.subTest(path=path.name):
                raw = path.read_bytes()
                text = raw.decode('utf-8')
                self.assertNotIn('�', text)
                self.assertNotIn(b'\r\n', raw)
                if path.suffix == '.json':
                    json.loads(text)

    def test_luci_view_and_acl(self):
        check = 'new Function(require("fs").readFileSync(process.argv[1], "utf8"))'
        result = subprocess.run(['node', '-e', check, str(VIEW)], capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        view = VIEW.read_text(encoding='utf-8')
        self.assertEqual(re.findall(r'validate = function\(([^)]*)\)', view), ['section_id, value'] * 2)
        acl = json.loads(ACL.read_text(encoding='utf-8'))['luci-app-remote-wol']
        # 只放行唤醒脚本，且只放行带参数的调用；其他命令、私钥文件都不开放
        self.assertEqual(acl['write']['file'], {'/usr/share/remote-wol/wake *': ['exec']})
        self.assertEqual(acl['read']['file'], {'/tmp/remote-wol/status.json': ['read']})
        self.assertIn("fs.exec('/usr/share/remote-wol/wake', [ mac ])", view)
        self.assertIn("fs.read('/tmp/remote-wol/status.json')", view)
        # 固件内文件的修改时间固定为 OpenWrt 发布日期、LuCI 视图地址的 ?v= 也不随本固件变，
        # 浏览器会长期使用缓存里的旧视图；视图改动时必须换文件名，菜单指向新文件，且不留旧文件
        path = json.loads(MENU.read_text(encoding='utf-8'))['admin/services/remote-wol']['action']['path']
        self.assertEqual(ROOT / f'files/www/luci-static/resources/view/{path}.js', VIEW)
        views = sorted(p.name for p in (ROOT / 'files/www/luci-static/resources/view').glob('remote-wol*.js'))
        self.assertEqual(views, [VIEW.name])
        version = re.search(r'var BEMFA_VERSION = (\d+);', view)[1]
        self.assertEqual(VIEW.name, f'remote-wol-v{version}.js', '视图文件名带诊断脚本版本，改动时一起升级')

    def test_paths_are_consistent(self):
        daemon = DAEMON.read_text(encoding='utf-8')
        init = INIT.read_text(encoding='utf-8')
        defaults = DEFAULTS.read_text(encoding='utf-8')
        self.assertIn("const WAKE = '/usr/share/remote-wol/wake';", daemon)
        self.assertIn("const STATE_DIR = '/tmp/remote-wol';", daemon)
        self.assertIn('STATUS=/tmp/remote-wol/status.json', init)
        self.assertIn('DAEMON=/usr/share/remote-wol/bemfa.uc', init)
        for path in ['/etc/init.d/remote-wol', '/usr/share/remote-wol/bemfa.uc', '/usr/share/remote-wol/wake']:
            self.assertIn(path, defaults)
        self.assertIn('chmod 0600 /etc/config/remote-wol', defaults)
        self.assertIn("option enabled '0'", CONFIG.read_text(encoding='utf-8'), '默认关闭')
        self.assertNotIn('cmd=3', re.sub(r'//.*', '', daemon), '订阅不能拉取历史消息，否则重连会误开机')

    def test_build_installs_and_verifies(self):
        build = (ROOT / '.github/workflows/build.yml').read_text(encoding='utf-8')
        self.assertIn('python3 tests/test_remote_wol.py', build)
        self.assertRegex(build, r'PKGS="\$PKGS[^"]*\betherwake\b')
        for path in ['etc/init.d/remote-wol', 'etc/uci-defaults/90-remote-wol', 'usr/share/remote-wol/bemfa.uc',
                     'usr/share/remote-wol/wake']:
            self.assertIn('ib/files/' + path, build)
        self.assertIn('node tests/test_remote_wol_web.cjs', build)
        for path in ['www/remote-wol/index.html', 'www/remote-wol/app.js', 'www/remote-wol/bemfa.js']:
            self.assertIn(path, build, '镜像核对要包含远程开机网页')

    def test_web_page_assets(self):
        html = (self.WEB / 'index.html').read_text(encoding='utf-8')
        version = re.search(r'const VERSION = (\d+);', (self.WEB / 'bemfa.js').read_text(encoding='utf-8'))[1]
        # 脚本地址带版本号，固件升级后浏览器不会继续用缓存里的旧脚本
        self.assertEqual(re.findall(r'<script src="([^"]+)"', html), [f'bemfa.js?v={version}', f'app.js?v={version}'])
        self.assertIn(f'var BEMFA_VERSION = {version};', VIEW.read_text(encoding='utf-8'), 'LuCI 要求的诊断脚本版本与实际一致')
        # 网页只允许连巴法云，脚本只能来自同源
        csp = re.search(r'Content-Security-Policy" content="([^"]+)"', html)[1]
        self.assertIn("default-src 'self'", csp)
        self.assertIn('connect-src https://apis.bemfa.com', csp)
        self.assertNotIn('unsafe-eval', csp)
        for name in ['bemfa.js', 'app.js']:
            result = subprocess.run(['node', '--check', str(self.WEB / name)], capture_output=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stderr)
        app = (self.WEB / 'app.js').read_text(encoding='utf-8')
        self.assertNotIn('innerHTML', app, '巴法云返回的昵称必须按文本显示')
        self.assertIn("'/remote-wol/bemfa.js?t=' + Date.now()", VIEW.read_text(encoding='utf-8'), 'LuCI 与网页共用同一份诊断脚本，且每次绕过缓存加载')

    def test_ios_project(self):
        project = (ROOT / 'ios/project.yml').read_text(encoding='utf-8')
        self.assertIn('PRODUCT_BUNDLE_IDENTIFIER: com.rm2100.remotewol', project)
        self.assertIn('CFBundleDisplayName: 远程开机', project)
        workflow = (ROOT / '.github/workflows/ios.yml').read_text(encoding='utf-8')
        self.assertIn('CODE_SIGNING_ALLOWED=NO', workflow, 'IPA 不签名，由用户自签')
        self.assertIn('xcodebuild test', workflow)
        swift = '\n'.join(p.read_text(encoding='utf-8') for p in (ROOT / 'ios').rglob('*.swift'))
        # App 与网页使用同一组巴法云接口和米家规则
        for needle in ['vb/api/v2/allTopic', 'va/postJsonMsg', '"type": Bemfa.tcp', '"001": "插座"', '"006": "开关"']:
            self.assertIn(needle, swift)
        self.assertIn('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly', swift, '私钥存钥匙串且不随备份迁移')
        icon = (ROOT / 'ios/RemoteWOL/Assets.xcassets/AppIcon.appiconset/icon.png').read_bytes()
        self.assertEqual(icon[:8], b'\x89PNG\r\n\x1a\n')
        self.assertEqual(int.from_bytes(icon[16:20], 'big'), 1024)


if __name__ == '__main__':
    unittest.main()
