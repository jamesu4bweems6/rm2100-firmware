"""邻传后端回归测试：CI 用与固件同版本的原生 ucode，本机（Windows）用 Node 模拟层。

python tests/test_lan_transfer.py                      # 后端测试
python tests/test_lan_transfer.py --serve --port 8765  # 本机预览/浏览器测试用的 CGI 模拟服务器（只监听 127.0.0.1）
环境变量 UCODE_BIN（及可选 UCODE_LIB）选择原生解释器。
"""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import binascii
import json
import os
import shlex
import socket
import struct
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
WWW = ROOT / 'files/usr/share/lan-transfer/www'
STUN = ROOT / 'files/usr/share/lan-transfer/stun.uc'
INIT = ROOT / 'files/etc/init.d/lan-transfer'
CGI = WWW / 'cgi-bin/api'
SPEED = WWW / 'cgi-bin/speed'
SOURCE = CGI.read_text(encoding='utf-8')
NATIVE = os.environ.get('UCODE_BIN') or shutil.which('ucode')
HOST = '127.0.0.1:8765'
LIMIT = {name: int(value) for name, value in re.findall(r'^const ([A-Z_]+) = (\d+);', SOURCE, re.M)}


class Backend:
    """一个隔离的状态目录 + 一份把 ROOT 指向它的 CGI 副本。"""

    def __init__(self, source=SOURCE):
        self.temp = tempfile.TemporaryDirectory(prefix='lan-transfer-')
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.script = self.root / 'api.uc'
        self.script.write_text(source.replace("'/tmp/lan-transfer'", json.dumps(self.state.as_posix())),
                               encoding='utf-8', newline='\n')

    def command(self):
        if NATIVE:
            command = [NATIVE]
            if os.environ.get('UCODE_LIB'):
                command += ['-L', os.environ['UCODE_LIB'] + '/*.so']
            return command + [str(self.script)]
        return ['node', str(ROOT / 'tests/lan_transfer_ucode_shim.cjs'), str(self.script)]

    def run(self, body=b'', query='', method='POST', ctype='application/json', **env):
        environ = dict(os.environ, REQUEST_METHOD=method, QUERY_STRING=query, CONTENT_TYPE=ctype,
                       CONTENT_LENGTH=str(len(body)), HTTP_HOST=HOST, HTTP_ORIGIN='http://' + HOST,
                       SERVER_ADDR='127.0.0.1', SERVER_PORT='8765', REMOTE_ADDR='192.168.1.10')
        for key, value in env.items():
            if value is None:
                environ.pop(key, None)
            else:
                environ[key] = value
        result = subprocess.run(self.command(), input=body, capture_output=True, env=environ, timeout=30)
        if result.returncode:
            raise RuntimeError(result.stderr.decode('utf-8', errors='replace'))
        head, _, payload = result.stdout.partition(b'\r\n\r\n')
        headers = {}
        for line in head.decode('latin1').split('\r\n'):
            name, _, value = line.partition(': ')
            headers[name.lower()] = value
        status = int(headers.pop('status').split(' ')[0])
        return status, headers, payload

    def call(self, data=None, raw=None, **env):
        body = raw if raw is not None else json.dumps(data, ensure_ascii=False).encode('utf-8')
        status, headers, payload = self.run(body, **env)
        if headers.get('content-type', '').startswith('application/json'):
            return status, json.loads(payload.decode('utf-8'))
        return status, payload

    def close(self):
        self.temp.cleanup()


class Case(unittest.TestCase):
    def setUp(self):
        self.backend = Backend()
        self.addCleanup(self.backend.close)

    def call(self, data, **env):
        return self.backend.call(data, **env)

    def hello(self, name='设备', ip='192.168.1.10', **extra):
        status, data = self.call({'a': 'hello', 'name': name, 'dev': 'laptop|Windows|Chrome', 'rtc': 1,
                                  'max': 2147483648, **extra}, REMOTE_ADDR=ip)
        self.assertEqual(status, 200, data)
        return data

    def session(self, peer):
        return {'id': peer['id'], 'key': peer['key']}

    def poll(self, peer, ack=0):
        status, data = self.call({'a': 'poll', **self.session(peer), 'ack': ack})
        self.assertEqual(status, 200, data)
        return data

    def send(self, peer, to, kind='ctl', payload=None):
        return self.call({'a': 'send', **self.session(peer), 'to': to['id'], 'k': kind,
                          'd': payload if payload is not None else {'t': 'ping'}})

    def age_peer(self, peer, seconds):
        path = self.backend.state / 'peers' / (peer['id'] + '.json')
        data = json.loads(path.read_text(encoding='utf-8'))
        data['seen'] -= seconds
        path.write_text(json.dumps(data), encoding='utf-8')


class PresenceTests(Case):
    def test_discovery_and_session_reuse(self):
        a = self.hello('客厅电脑')
        b = self.hello('小明的手机 <b>&', ip='192.168.1.11', rtc=0)
        self.assertRegex(a['id'], r'^[0-9a-f]{32}$')
        self.assertNotEqual(a['id'], b['id'])
        self.assertEqual((a['v'], a['chunk'], a['stun'], a['ip']), (1, LIMIT['CHUNK'], None, '192.168.1.10'))
        peers = self.poll(a)['peers']
        self.assertEqual([(p['id'], p['name'], p['rtc'], p['same']) for p in peers],
                         [(b['id'], '小明的手机 <b>&', 0, 0)])
        self.assertEqual(peers[0]['max'], 2147483648)
        # 带着 id/key 重新 hello：同一身份，只更新名字
        again = self.hello('书房电脑', **self.session(a))
        self.assertEqual((again['id'], again['key']), (a['id'], a['key']))
        self.assertEqual([p['name'] for p in self.poll(b)['peers']], ['书房电脑'])
        self.assertEqual(self.poll(b)['peers'][0]['same'], 0)
        same = self.hello('同机另一个标签页')
        self.assertEqual({p['id']: p['same'] for p in self.poll(same)['peers']}, {a['id']: 1, b['id']: 0})

    def test_foreign_id_cannot_be_hijacked(self):
        a = self.hello()
        other = self.hello('冒充者', id=a['id'], key='0' * 32)
        self.assertNotEqual(other['id'], a['id'])
        self.assertEqual(self.call({'a': 'poll', 'id': a['id'], 'key': '1' * 32})[0], 401)
        self.assertEqual(self.call({'a': 'poll', 'id': '../../etc', 'key': a['key']})[0], 401)

    def test_bye_and_expiry(self):
        a, b, c = self.hello('A'), self.hello('B'), self.hello('C')
        self.assertEqual(self.send(a, b)[0], 200)
        self.assertEqual(self.call({'a': 'bye', **self.session(c)}), (200, {'ok': True}))
        self.assertEqual({p['name'] for p in self.poll(a)['peers']}, {'B'})
        self.age_peer(b, LIMIT['PEER_TTL'] + 1)
        self.assertEqual(self.poll(a)['peers'], [])
        self.assertFalse((self.backend.state / 'mail' / (b['id'] + '.json')).exists())
        self.assertEqual(self.call({'a': 'poll', **self.session(b)})[0], 401)
        self.assertEqual(self.send(a, b)[0], 404)

    def test_peer_quotas(self):
        for index in range(LIMIT['PEER_PER_IP']):
            self.hello(f'页面{index}')
        status, data = self.call({'a': 'hello', 'name': '多余的页面'}, REMOTE_ADDR='192.168.1.10')
        self.assertEqual(status, 429, data)
        for index in range(LIMIT['PEER_MAX'] - LIMIT['PEER_PER_IP']):
            self.hello(f'设备{index}', ip=f'192.168.2.{index + 1}')
        self.assertEqual(self.call({'a': 'hello', 'name': '满员'}, REMOTE_ADDR='192.168.3.1')[0], 429)

    def test_invalid_hello(self):
        for payload in [{'a': 'hello'}, {'a': 'hello', 'name': ''}, {'a': 'hello', 'name': 'x' * 65},
                        {'a': 'hello', 'name': 7}, {'a': 'hello', 'name': 'ok', 'dev': 'x' * 97}]:
            with self.subTest(payload=payload):
                self.assertEqual(self.call(payload)[0], 400)


class MailboxTests(Case):
    def test_delivery_order_and_ack(self):
        a, b = self.hello('A'), self.hello('B')
        sdp = {'t': 'offer', 'lid': 'abcd', 'sdp': {'type': 'offer', 'sdp': 'v=0\r\n中文'}}
        for kind, payload in [('sig', sdp), ('ctl', {'t': 'accept', 'bid': 7}), ('txt', {'text': '你好 <script>'})]:
            self.assertEqual(self.send(a, b, kind, payload), (200, {'ok': True}))
        msgs = self.poll(b)['msgs']
        self.assertEqual([(m['n'], m['f'], m['k']) for m in msgs],
                         [(1, a['id'], 'sig'), (2, a['id'], 'ctl'), (3, a['id'], 'txt')])
        self.assertEqual(msgs[0]['d'], sdp)
        self.assertEqual(msgs[2]['d'], {'text': '你好 <script>'})
        self.assertEqual(len(self.poll(b)['msgs']), 3, '未确认的消息必须重发')
        self.assertEqual([m['n'] for m in self.poll(b, ack=2)['msgs']], [3])
        self.assertEqual(self.poll(b, ack=3)['msgs'], [])
        self.assertEqual(self.send(a, b)[0], 200)
        self.assertEqual([m['n'] for m in self.poll(b, ack=3)['msgs']], [4], '序号不能回退')

    def test_message_validation_and_limits(self):
        a, b = self.hello('A'), self.hello('B')
        self.assertEqual(self.send(a, b, kind='evil')[0], 400)
        self.assertEqual(self.call({'a': 'send', **self.session(a), 'to': b['id'], 'k': 'txt'})[0], 400)
        self.assertEqual(self.send(a, a)[0], 404)
        self.assertEqual(self.send(a, b, 'txt', 'x' * (LIMIT['MSG_BYTES'] + 1))[0], 413)
        for _ in range(LIMIT['MAIL_MAX']):
            self.assertEqual(self.send(a, b)[0], 200)
        self.assertEqual(self.send(a, b)[0], 429)
        self.poll(b, ack=LIMIT['MAIL_MAX'])
        self.assertEqual(self.send(a, b)[0], 200)

    def test_concurrent_senders_get_unique_sequence(self):
        target = self.hello('目标')
        senders = [self.hello(f'S{i}', ip=f'192.168.4.{i}') for i in range(6)]
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda s: self.send(s, target)[0], senders))
        self.assertEqual(results, [200] * 6)
        msgs = self.poll(target)['msgs']
        self.assertEqual(sorted(m['n'] for m in msgs), list(range(1, 7)))
        self.assertEqual({m['f'] for m in msgs}, {s['id'] for s in senders})


class RequestTests(Case):
    def test_origin_method_and_body_checks(self):
        request = {'a': 'hello', 'name': 'x'}
        cases = [({'HTTP_ORIGIN': 'http://evil.example'}, 403),
                 ({'HTTP_ORIGIN': None}, 403),
                 ({'HTTP_ORIGIN': 'null'}, 403),
                 ({'HTTP_HOST': 'evil.example:8765', 'HTTP_ORIGIN': 'http://evil.example:8765'}, 403),
                 ({'HTTP_HOST': 'openwrt.lan:9999', 'HTTP_ORIGIN': 'http://openwrt.lan:9999'}, 403),
                 ({'HTTP_HOST': 'openwrt.lan:8765', 'HTTP_ORIGIN': 'http://openwrt.lan:8765'}, 200),
                 ({'HTTP_HOST': 'router:8765', 'HTTP_ORIGIN': 'http://router:8765'}, 200),
                 ({'method': 'GET'}, 405),
                 ({'ctype': 'text/plain'}, 415)]
        for overrides, expected in cases:
            with self.subTest(overrides=overrides):
                method = overrides.pop('method', 'POST')
                ctype = overrides.pop('ctype', 'application/json')
                status, _, _ = self.backend.run(json.dumps(request).encode(), method=method, ctype=ctype, **overrides)
                self.assertEqual(status, expected)
        self.assertEqual(self.backend.run(b'{}', CONTENT_LENGTH=None)[0], 411)
        self.assertEqual(self.backend.run(b'x' * (LIMIT['REQ_BYTES'] + 1))[0], 413)
        for raw in [b'{ ', b'null', b'[]', b'"hello"']:
            self.assertEqual(self.call(None, raw=raw)[0], 400)
        self.assertEqual(self.call({'a': 'nope'})[0], 400)


class RelayTests(Case):
    def setUp(self):
        super().setUp()
        self.a, self.b = self.hello('发送方'), self.hello('接收方', ip='192.168.1.11')
        status, data = self.call({'a': 'ropen', **self.session(self.a), 'to': self.b['id']})
        self.assertEqual(status, 200, data)
        self.rid = data['rid']

    def put(self, n, body, peer=None, crc=None, rid=None, ctype='application/octet-stream'):
        peer = peer or self.a
        query = f"a=put&id={peer['id']}&key={peer['key']}&r={rid or self.rid}&n={n}" + (f'&c={crc}' if crc else '')
        status, headers, payload = self.backend.run(body, query=query, ctype=ctype)
        return status

    def get(self, n, peer=None):
        peer = peer or self.b
        status, headers, payload = self.backend.run(json.dumps({'a': 'get', **self.session(peer), 'r': self.rid, 'n': n}).encode())
        return status, headers.get('x-crc'), payload

    def test_roundtrip_retry_and_close(self):
        first = bytes(range(256)) * 4 + b'\r\n\x00\xff'
        last = os.urandom(70000)
        self.assertEqual(self.put(0, first), 200)
        self.assertEqual(self.put(1, last, crc='0badc0de'), 200)
        self.assertEqual(self.get(0), (200, None, first))
        self.assertEqual(self.get(0), (200, None, first), '应答丢失后可以重取')
        self.assertEqual(self.get(1), (200, '0badc0de', last))
        self.assertEqual(self.put(0, first), 200, '已被取走的分块重复提交按成功处理')
        self.assertEqual(self.call({'a': 'rclose', **self.session(self.b), 'r': self.rid}), (200, {'ok': True}))
        self.assertEqual(self.put(2, b'late'), 404)
        self.assertEqual(self.get(2)[0], 404)

    def test_permissions_and_validation(self):
        c = self.hello('旁观者', ip='192.168.1.12')
        self.assertEqual(self.put(0, b'x', peer=self.b), 404)
        self.assertEqual(self.put(0, b'x', peer=c), 404)
        self.assertEqual(self.put(0, b'x', rid='0' * 32), 404)
        self.assertEqual(self.put(0, b'x', ctype='application/json'), 415)
        self.assertEqual(self.put(0, b'x' * (LIMIT['CHUNK'] + 1)), 413)
        self.assertEqual(self.put(0, b'x', crc='xyz'), 400)
        self.assertEqual(self.put(LIMIT['RELAY_WINDOW'] * 2 + 1, b'x'), 400)
        self.assertEqual(self.get(0, peer=self.a)[0], 404)
        self.assertEqual(self.get(0, peer=c)[0], 404)
        self.assertEqual(self.get(LIMIT['RELAY_WINDOW'] + 1)[0], 400)
        self.assertEqual(self.call({'a': 'rclose', **self.session(c), 'r': self.rid})[0], 200)
        self.assertEqual(self.put(0, b'still open'), 200, '无关设备不能关闭中转')
        self.assertEqual(self.call({'a': 'ropen', **self.session(self.a), 'to': self.a['id']})[0], 404)
        status, data = self.call({'a': 'ropen', **self.session(self.a), 'to': '0' * 32})
        self.assertEqual(status, 404, data)

    def test_window_backpressure_and_waiting(self):
        started = time.monotonic()
        self.assertEqual(self.get(0)[0], 204)
        self.assertGreaterEqual(time.monotonic() - started, LIMIT['WAIT_MS'] / 1000 * 0.9)
        for n in range(LIMIT['RELAY_WINDOW']):
            self.assertEqual(self.put(n, bytes([n]) * 10), 200)
        started = time.monotonic()
        self.assertEqual(self.put(LIMIT['RELAY_WINDOW'], b'full'), 429)
        self.assertGreaterEqual(time.monotonic() - started, LIMIT['WAIT_MS'] / 1000 * 0.9)
        self.assertEqual(self.get(0)[2], bytes([0]) * 10)
        self.assertEqual(self.put(LIMIT['RELAY_WINDOW'], b'full'), 429, '第 0 块仍保留供重取')
        self.assertEqual(self.get(1)[2], bytes([1]) * 10)
        self.assertEqual(self.put(LIMIT['RELAY_WINDOW'], b'room'), 200)

    def test_get_waits_for_upload_in_progress(self):
        def late_put():
            time.sleep(0.3)
            self.put(0, b'arrived')
        thread = threading.Thread(target=late_put)
        thread.start()
        self.assertEqual(self.get(0), (200, None, b'arrived'))
        thread.join()

    def test_slow_download_does_not_lock_upload_or_presence(self):
        # 堵住 CGI stdout，模拟尚未读走正文的慢接收方。全局锁必须在 emit 前释放。
        body = b'x' * LIMIT['CHUNK']
        self.assertEqual(self.put(0, body), 200)
        request = json.dumps({'a': 'get', **self.session(self.b), 'r': self.rid, 'n': 0}).encode()
        env = dict(os.environ, REQUEST_METHOD='POST', QUERY_STRING='', CONTENT_TYPE='application/json',
                   CONTENT_LENGTH=str(len(request)), HTTP_HOST=HOST, HTTP_ORIGIN='http://' + HOST,
                   SERVER_ADDR='127.0.0.1', SERVER_PORT='8765', REMOTE_ADDR='192.168.1.11')
        proc = subprocess.Popen(self.backend.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env)
        try:
            proc.stdin.write(request)
            proc.stdin.close()
            proc.stdin = None
            self.assertIn(b'200', proc.stdout.readline())
            self.assertIsNone(proc.poll(), '正文应仍被 stdout 背压阻塞')
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(lambda: (self.put(1, b'next'), self.poll(self.a)))
                try:
                    self.assertEqual(future.result(timeout=5)[0], 200)
                finally:
                    proc.communicate(timeout=5)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()

    def test_large_sequence_and_reordered_uploads(self):
        # 跳过旧的七位序号上限，不必实际传输数 TB 数据。
        path = self.backend.state / 'relay' / self.rid / 'meta.json'
        meta = json.loads(path.read_text(encoding='utf-8'))
        n = 10000000
        meta['low'] = n
        path.write_text(json.dumps(meta), encoding='utf-8')
        self.assertEqual(self.put(n + 1, b'second', crc='0badc0de'), 200)
        self.assertEqual(self.put(n, b'first'), 200)
        self.assertEqual(self.get(n), (200, None, b'first'))
        self.assertEqual(self.get(n + 1), (200, '0badc0de', b'second'))
        self.assertEqual(self.put(n, b'first'), 200)
        self.assertEqual(self.put(9007199254740992, b'invalid'), 400)
        self.assertEqual(self.get(9007199254740992)[0], 400)

    def test_relay_caps_and_cleanup(self):
        for _ in range(LIMIT['RELAY_MAX'] - 1):
            self.assertEqual(self.call({'a': 'ropen', **self.session(self.a), 'to': self.b['id']})[0], 200)
        self.assertEqual(self.call({'a': 'ropen', **self.session(self.a), 'to': self.b['id']})[0], 503)
        self.assertEqual(self.put(0, b'data'), 200)
        self.age_peer(self.b, LIMIT['PEER_TTL'] + 1)
        self.poll(self.a)
        self.assertEqual(list((self.backend.state / 'relay').iterdir()), [], '对端离线后清理中转')
        self.assertEqual(self.put(1, b'data'), 404)


class ZipTests(unittest.TestCase):
    def test_zip32_boundary_includes_utf8_names(self):
        script = r"""
const fs = require('node:fs'), assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[1], 'utf8');
const start = source.indexOf('  function zipBlob(files) {');
const end = source.indexOf('  function saveZip(files) {', start);
assert.ok(start > 0 && end > start);
const zip = new Function('files', source.slice(start, end) + '\nreturn zipBlob(files);');
const name = '测'.repeat(200) + '.bin';
const blob = new Blob(['abc']);
assert.equal(zip([{ name, size: 3, crc: 0, blob }]).size,
  22 + 30 + 46 + 2 * new TextEncoder().encode(name).length + 3);
// 只模拟元数据，正文不分配数 GB。旧的正文+100 字节估算会放过这个文件。
assert.throws(() => zip([{ name, size: 0xffffffff - 1000, crc: 0, blob }]), /逐个保存/);
"""
        result = subprocess.run(['node', '-e', script, str(WWW / 'app.js')], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class QrTests(unittest.TestCase):
    """与 Nayuki 的 qrcodegen 参考实现逐模块比对（含自动掩码选择）；本机没装 qrcodegen 就跳过。"""
    SCRIPT = r"""
const vm = require('node:vm'), fs = require('node:fs');
const ctx = { TextEncoder };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), ctx);
const out = JSON.parse(fs.readFileSync(0, 'utf8')).map(([text, mask]) => {
  const q = ctx.LtQr.encode(text, mask === null ? undefined : mask);
  return { version: q.version, mask: q.mask, rows: q.modules.map(r => r.map(c => (c ? 1 : 0)).join('')) };
});
process.stdout.write(JSON.stringify(out));
"""

    def encode(self, cases):
        result = subprocess.run(['node', '-e', self.SCRIPT, str(WWW / 'qr.js')], input=json.dumps(cases).encode(),
                                capture_output=True)
        return result.returncode, result.stdout

    def test_matches_reference_encoder(self):
        try:
            from qrcodegen import QrCode, QrSegment
        except ImportError:
            self.skipTest('需要 pip install qrcodegen')
        samples = ['http://192.168.1.1:8080/', 'http://10.0.0.1:8080/', 'http://openwrt.lan:8080/', 'A',
                   '中文 http://192.168.100.100:65535/?x=1', 'x' * 100, 'y' * 150, 'z' * 181, 'w' * 213]
        cases = [[text, None] for text in samples] + [[samples[0], m] for m in range(8)] + [['v' * 120, 6]]
        code, out = self.encode(cases)
        self.assertEqual(code, 0, out)
        for (text, mask), ours in zip(cases, json.loads(out)):
            ref = QrCode.encode_segments([QrSegment.make_bytes(text.encode('utf-8'))], QrCode.Ecc.MEDIUM,
                                         1, 10, -1 if mask is None else mask, False)
            rows = [''.join('1' if ref.get_module(x, y) else '0' for x in range(ref.get_size()))
                    for y in range(ref.get_size())]
            with self.subTest(text=text[:30], mask=mask):
                self.assertEqual((ours['version'], ours['mask'], ours['rows']), (ref.get_version(), ref.get_mask(), rows))

    def test_too_long_is_rejected(self):
        code, _ = self.encode([['x' * 214, None]])
        self.assertNotEqual(code, 0)


def shell():
    git_bin = r'C:\Program Files\Git\usr\bin'
    for candidate in (['busybox', 'ash'], ['dash']):
        found = shutil.which(candidate[0]) or (os.name == 'nt' and shutil.which(candidate[0], path=git_bin))
        if found:
            return [found] + candidate[1:]
    return None


class InitScriptTests(unittest.TestCase):
    """在 ash/dash 里用桩函数执行 procd 启动脚本，核对实际生成的实例参数。"""
    STUBS = r"""
config_load() { :; }
config_get_bool() { eval "$1=\${CFG_$3:-$4}"; }
config_get() { eval "$1=\${CFG_$3-$4}"; }
network_get_ipaddr() { [ -n "$LAN_IP" ] || return 1; eval "$1=\$LAN_IP"; }
procd_open_instance() { echo "open $1"; }
procd_set_param() { echo "param $*"; }
procd_close_instance() { echo "close"; }
procd_add_reload_trigger() { echo "reload-trigger $*"; }
procd_add_interface_trigger() { echo "iface-trigger $*"; }
"""

    def setUp(self):
        self.sh = shell()
        if not self.sh:
            self.skipTest('需要 busybox ash 或 dash')
        self.temp = tempfile.TemporaryDirectory(prefix='lan-transfer-init-')
        self.addCleanup(self.temp.cleanup)
        self.socket = Path(self.temp.name) / 'socket.so'

    def run_init(self, **env):
        body = INIT.read_text(encoding='utf-8').replace('#!/bin/sh /etc/rc.common\n', '')
        body = body.replace('. /lib/functions/network.sh', ':').replace('/usr/lib/ucode/socket.so', self.socket.as_posix())
        script = Path(self.temp.name) / 'run.sh'
        script.write_text(self.STUBS + body + '\nstart_service\nservice_triggers\n', encoding='utf-8', newline='\n')
        environ = {k: v for k, v in os.environ.items() if not k.startswith('CFG_') and k != 'LAN_IP'}
        environ.update(env)
        result = subprocess.run(self.sh + [script.as_posix()], capture_output=True, text=True, env=environ, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_default_instances_and_triggers(self):
        self.socket.write_text('')
        out = self.run_init(LAN_IP='192.168.31.1')
        self.assertIn('param command /usr/sbin/uhttpd -f -p 192.168.31.1:8080 -h /usr/share/lan-transfer/www -x /cgi-bin '
                      '-t 30 -T 30 -n 6 -N 48 -D -S -c /dev/null', out)
        self.assertIn('param command /usr/bin/ucode /usr/share/lan-transfer/stun.uc 192.168.31.1 3478', out)
        self.assertEqual(out.count('open '), 2)
        self.assertIn('reload-trigger lan-transfer network', out)
        self.assertIn('iface-trigger interface.* lan /etc/init.d/lan-transfer reload', out)

    def test_port_validation_and_switches(self):
        for port, expected in [('9000', '9000'), ('80', '8080'), ('443', '8080'), ('abc', '8080'), ('', '8080'),
                               ('70000', '8080'), ('0', '8080')]:
            with self.subTest(port=port):
                self.assertIn(f'-p 192.168.1.1:{expected} ', self.run_init(LAN_IP='192.168.1.1', CFG_port=port))
        self.assertNotIn('open', self.run_init(LAN_IP='192.168.1.1', CFG_enabled='0'))
        self.assertNotIn('open', self.run_init())
        out = self.run_init(LAN_IP='192.168.1.1')
        self.assertEqual(out.count('open '), 1, '没有 ucode-mod-socket 时只启页面服务')

    def test_shell_syntax(self):
        for path in [INIT, ROOT / 'files/etc/uci-defaults/92-lan-transfer']:
            result = subprocess.run(self.sh + ['-n', path.as_posix()], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, f'{path.name}: {result.stderr}')


def ucode_command():
    return [NATIVE] + (['-L', os.environ['UCODE_LIB'] + '/*.so'] if os.environ.get('UCODE_LIB') else [])


def native_socket_module():
    if not NATIVE:
        return False
    result = subprocess.run(ucode_command() + ['-e', "import * as s from 'socket'; print(s.AF_INET);"], capture_output=True)
    return result.returncode == 0


class StunTests(unittest.TestCase):
    """原生 ucode + socket 模块实跑 STUN 应答器（仅 CI）；按 RFC 5389 逐字段核对应答。"""

    def setUp(self):
        if not native_socket_module():
            self.skipTest('需要带 socket 模块的原生 ucode')
        self.temp = tempfile.TemporaryDirectory(prefix='lan-transfer-stun-')
        self.addCleanup(self.temp.cleanup)
        state = Path(self.temp.name) / 'state'
        script = Path(self.temp.name) / 'stun.uc'
        script.write_text(STUN.read_text(encoding='utf-8').replace("'/tmp/lan-transfer'", json.dumps(state.as_posix())),
                          encoding='utf-8', newline='\n')
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]
        self.proc = subprocess.Popen(ucode_command() + [str(script), '127.0.0.1', str(self.port)], stderr=subprocess.PIPE)
        self.addCleanup(self.stop)
        marker = state / 'stun.json'
        for _ in range(100):
            if marker.exists():
                break
            time.sleep(0.05)
        self.assertEqual(json.loads(marker.read_text()), {'port': self.port, 'pid': self.proc.pid})
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('127.0.0.1', 0))
        self.sock.settimeout(1)
        self.addCleanup(self.sock.close)

    def stop(self):
        self.proc.kill()
        self.proc.wait()

    def ask(self, packet):
        self.sock.sendto(packet, ('127.0.0.1', self.port))
        try:
            return self.sock.recvfrom(2048)[0]
        except socket.timeout:
            return None

    def test_binding_response(self):
        tid = os.urandom(12)
        reply = self.ask(struct.pack('!HHI', 0x0001, 0, 0x2112A442) + tid)
        self.assertIsNotNone(reply)
        kind, length, cookie = struct.unpack('!HHI', reply[:8])
        self.assertEqual((kind, length, cookie, reply[8:20], len(reply)), (0x0101, 32, 0x2112A442, tid, 52))
        attrs, offset = {}, 20
        while offset < len(reply):
            atype, alen = struct.unpack('!HH', reply[offset:offset + 4])
            attrs[atype] = (offset, reply[offset + 4:offset + 4 + alen])
            offset += 4 + alen
        ip, port = self.sock.getsockname()
        self.assertEqual(attrs[0x0001][1], struct.pack('!BBH', 0, 1, port) + socket.inet_aton(ip))
        xaddr = bytes(a ^ b for a, b in zip(socket.inet_aton(ip), struct.pack('!I', 0x2112A442)))
        self.assertEqual(attrs[0x0020][1], struct.pack('!BBH', 0, 1, port ^ 0x2112) + xaddr)
        fp_offset, fp = attrs[0x8028]
        self.assertEqual(struct.unpack('!I', fp)[0], (binascii.crc32(reply[:fp_offset]) ^ 0x5354554E) & 0xFFFFFFFF)

    def test_ignores_non_binding_packets(self):
        tid = os.urandom(12)
        self.sock.settimeout(0.3)
        for packet in [b'\x00', b'\x00\x01', struct.pack('!HHI', 0x0101, 0, 0x2112A442) + tid,
                       struct.pack('!HHI', 0x0001, 0, 0xDEADBEEF) + tid,
                       struct.pack('!HHI', 0x0001, 8, 0x2112A442) + tid, b'GET / HTTP/1.1\r\n\r\n']:
            with self.subTest(packet=packet[:8]):
                self.assertIsNone(self.ask(packet))
        self.sock.settimeout(1)
        self.assertIsNotNone(self.ask(struct.pack('!HHI', 0x0001, 0, 0x2112A442) + tid), '畸形包之后仍能正常应答')


class HygieneTests(unittest.TestCase):
    """固件文件的基本卫生：UTF-8、无替换字符与 CRLF、JSON 可解析、LuCI 视图语法正确。"""
    FILES = [INIT, ROOT / 'files/etc/config/lan-transfer', ROOT / 'files/etc/uci-defaults/92-lan-transfer', STUN,
             ROOT / 'files/usr/share/luci/menu.d/luci-app-lan-transfer.json',
             ROOT / 'files/usr/share/rpcd/acl.d/luci-app-lan-transfer.json',
             ROOT / 'files/usr/share/ucitrack/lan-transfer.json',
             ROOT / 'files/www/luci-static/resources/view/lan-transfer.js', ROOT / 'docs/lan-transfer.md', ROOT / 'README.md',
             *sorted(p for p in WWW.rglob('*') if p.is_file())]

    def test_text_files(self):
        for path in self.FILES:
            with self.subTest(path=path.name):
                raw = path.read_bytes()
                text = raw.decode('utf-8')
                self.assertNotIn('\ufffd', text)
                self.assertNotIn(b'\r\n', raw)
                if path.suffix == '.json':
                    json.loads(text)

    def test_page_assets_and_luci_view(self):
        html = (WWW / 'index.html').read_text(encoding='utf-8')
        assets = re.findall(r'(?:src|href)="([a-z]+\.(?:js|css))\?v=\d+"', html)
        self.assertEqual(sorted(assets), ['app.js', 'qr.js', 'style.css'])
        for asset in assets:
            self.assertTrue((WWW / asset).is_file(), asset)
        view = ROOT / 'files/www/luci-static/resources/view/lan-transfer.js'
        check = 'new Function(require("fs").readFileSync(process.argv[1], "utf8"))'
        result = subprocess.run(['node', '-e', check, str(view)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('function(section_id, value)', view.read_text(encoding='utf-8'), 'LuCI 自定义校验必须是双参数签名')


def uhttpd_command(docroot, port, bind='127.0.0.1'):
    """从 init 脚本里取出 uhttpd 参数、换成测试地址：CI 跑的就是固件里的同一组参数。"""
    text = INIT.read_text(encoding='utf-8').replace('\\\n', ' ')
    line = re.search(r'procd_set_param command (/usr/sbin/uhttpd [^\n]*)', text)[1]
    line = line.replace('"$lan_ip:$port"', f'{bind}:{port}').replace('"$WWW"', Path(docroot).as_posix())
    return ' '.join(shlex.split(line))


def stage(target, port, bind='127.0.0.1'):
    """为 CI 里的真实 uhttpd 准备网站目录：CGI 状态目录放在 target 旁边，解释器用原生 ucode。"""
    target = Path(target).resolve()
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(WWW, target)
    state = target.parent / 'state'
    api = target / 'cgi-bin/api'
    api.write_text(SOURCE.replace("'/tmp/lan-transfer'", json.dumps(state.as_posix()))
                   .replace('#!/usr/bin/ucode', '#!' + (NATIVE or '/usr/bin/ucode'), 1), encoding='utf-8', newline='\n')
    api.chmod(0o755)
    speed = target / 'cgi-bin/speed'
    speed.write_text(SPEED.read_text(encoding='utf-8').replace('#!/usr/bin/ucode', '#!' + (NATIVE or '/usr/bin/ucode'), 1), encoding='utf-8', newline='\n')
    speed.chmod(0o755)
    stun = STUN.read_text(encoding='utf-8').replace("'/tmp/lan-transfer'", json.dumps(state.as_posix()))
    (target.parent / 'stun.uc').write_text(stun, encoding='utf-8', newline='\n')
    print(uhttpd_command(target, port, bind).replace('/usr/sbin/uhttpd', os.environ.get('UHTTPD_BIN', '/usr/sbin/uhttpd'), 1))


def smoke(base):
    """CI：对真实 uhttpd + 原生 ucode 做一次完整往返，覆盖本机模拟层验证不了的 uhttpd 行为。"""
    import urllib.error
    import urllib.request

    def request(path, body=None, ctype='application/json', origin=base, method=None):
        headers = {'Origin': origin} if origin else {}
        if body is not None:
            headers['Content-Type'] = ctype
        req = urllib.request.Request(base + path, body, headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def call(data):
        status, _, payload = request('/cgi-bin/api', json.dumps(data).encode())
        assert status == 200, (status, payload)
        return json.loads(payload)

    status, headers, page = request('/', method='GET', origin=None)
    assert status == 200 and headers['Content-Type'].startswith('text/html') and b'app.js' in page, (status, headers)
    assert request('/cgi-bin/', method='GET', origin=None)[0] in (403, 404), '目录列表必须关闭'
    assert request('/cgi-bin/api', method='GET', origin=None)[0] == 405
    assert request('/cgi-bin/api', b'{}', origin='http://evil.example')[0] == 403
    a = call({'a': 'hello', 'name': 'ci-a'})
    b = call({'a': 'hello', 'name': 'ci-b'})
    assert a['v'] == 1 and a['stun'] == 3478, a
    assert [p['name'] for p in call({'a': 'poll', 'id': a['id'], 'key': a['key']})['peers']] == ['ci-b']
    rid = call({'a': 'ropen', 'id': a['id'], 'key': a['key'], 'to': b['id']})['rid']
    chunk = os.urandom(LIMIT['CHUNK'])
    crc = format(binascii.crc32(chunk), '08x')
    status, _, _ = request(f"/cgi-bin/api?a=put&id={a['id']}&key={a['key']}&r={rid}&n=0&c={crc}", chunk, 'application/octet-stream')
    assert status == 200, status
    get = lambda n: request('/cgi-bin/api', json.dumps({'a': 'get', 'id': b['id'], 'key': b['key'], 'r': rid, 'n': n}).encode())
    status, headers, payload = get(0)
    assert status == 200 and payload == chunk and headers.get('X-Crc') == crc, (status, headers.get('X-Crc'), len(payload))
    started = time.monotonic()
    status, _, payload = get(1)
    assert status == 204 and payload == b'' and time.monotonic() - started >= 0.7, (status, payload)
    call({'a': 'rclose', 'id': b['id'], 'key': b['key'], 'r': rid})
    for peer in (a, b):
        call({'a': 'bye', 'id': peer['id'], 'key': peer['key']})
    print('真实 uhttpd + 原生 ucode：页面、目录列表、方法与来源校验、1 MiB 二进制中转、X-Crc、204 全部正常')


def serve(port):
    """模拟 uhttpd：静态文件 + /cgi-bin/api。只用于本机预览和浏览器测试，产品运行的是路由器上的 uhttpd。"""
    backend = Backend()
    speed = Backend(SPEED.read_text(encoding='utf-8'))

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass

        def do_GET(self):
            path = self.path.split('?', 1)[0]
            if path.startswith('/cgi-bin/'):
                return self.do_POST()
            target = (WWW / (path.lstrip('/') or 'index.html')).resolve()
            if WWW.resolve() not in target.parents or not target.is_file():
                self.send_error(404)
                return
            data = target.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', {'.js': 'text/javascript', '.css': 'text/css',
                                              '.html': 'text/html'}.get(target.suffix, 'application/octet-stream'))
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            path, _, query = self.path.partition('?')
            if path not in ('/cgi-bin/api', '/cgi-bin/speed'):
                self.send_error(404)
                return
            length = self.headers.get('Content-Length')
            body = self.rfile.read(int(length)) if length else b''
            status, headers, payload = (speed if path == '/cgi-bin/speed' else backend).run(
                body, query=query, method=self.command, ctype=self.headers.get('Content-Type', ''),
                CONTENT_LENGTH=length, HTTP_HOST=self.headers.get('Host'), HTTP_ORIGIN=self.headers.get('Origin'),
                SERVER_PORT=str(port), REMOTE_ADDR=self.client_address[0])
            self.send_response(status)
            for name, value in headers.items():
                if name != 'content-length':
                    self.send_header(name, value)
            if status != 204:
                self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            if status != 204:
                self.wfile.write(payload)

        do_PUT = do_DELETE = lambda self: self.send_error(405)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'Preview http://127.0.0.1:{port}/ (backend: {"native ucode" if NATIVE else "Node ucode shim"})', flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        backend.close()
        speed.close()


if __name__ == '__main__':
    arg = lambda name, default: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default
    if '--stage' in sys.argv:
        stage(arg('--stage', None), int(arg('--port', 8765)), arg('--bind', '127.0.0.1'))
    elif '--smoke' in sys.argv:
        smoke(arg('--smoke', None).rstrip('/'))
    elif '--serve' in sys.argv:
        serve(int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else 8765)
    else:
        print('Backend:', NATIVE or 'Node ucode shim (CI runs native ucode)', flush=True)
        random.seed(1)
        unittest.main(verbosity=2)
