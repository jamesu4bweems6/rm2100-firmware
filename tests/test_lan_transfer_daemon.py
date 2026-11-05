"""常驻邻传真实 TCP 回归；LAN_TRANSFER_DAEMON_URL 可选择隔离的真机测试服务。"""
from concurrent.futures import ThreadPoolExecutor
import binascii
import http.client
import ipaddress
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlsplit
from test_lan_transfer import ROOT, WWW, native_socket_module, ucode_command


class DaemonCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base = os.environ.get('LAN_TRANSFER_DAEMON_URL')
        if not base:
            if not native_socket_module():
                raise unittest.SkipTest('需要原生 ucode + socket，或 LAN_TRANSFER_DAEMON_URL')
            temp = tempfile.TemporaryDirectory(prefix='lan-transfer-http-')
            cls.addClassCleanup(temp.cleanup)
            process = subprocess.Popen(ucode_command() + [str(ROOT / 'files/usr/share/lan-transfer/transfer.uc'),
                '127.0.0.1', '0', temp.name, str(WWW)], stderr=subprocess.PIPE)
            cls.addClassCleanup(lambda: process.communicate(timeout=5))
            cls.addClassCleanup(process.terminate)
            meta = Path(temp.name) / 'http.json'
            for _ in range(100):
                if meta.exists():
                    break
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read().decode())
                time.sleep(.05)
            base = f'http://127.0.0.1:{json.loads(meta.read_text())["port"]}'
        cls.base = base.rstrip('/')
        cls.url = urlsplit(cls.base)

    def conn(self):
        conn = http.client.HTTPConnection(self.url.hostname, self.url.port, timeout=8)
        self.addCleanup(conn.close)
        return conn

    def call(self, data=None, path='/cgi-bin/api', body=None, conn=None, **headers):
        conn = conn or self.conn()
        if body is None:
            body = json.dumps(data, ensure_ascii=False).encode()
        h = {'Origin': self.base, 'Content-Type': 'application/json'}
        h.update(headers)
        conn.request('POST', path, body, h)
        response = conn.getresponse()
        raw = response.read()
        value = json.loads(raw) if raw and response.getheader('Content-Type', '').startswith('application/json') else raw
        return response.status, value, dict(response.getheaders())

    def setUp(self):
        self.a = self.hello('sender')
        self.b = self.hello('receiver')
        self.addCleanup(lambda: self.call(self.session(self.a, 'bye')))
        self.addCleanup(lambda: self.call(self.session(self.b, 'bye')))
        status, data, _ = self.call({**self.session(self.a, 'ropen'), 'to': self.b['id']})
        self.assertEqual(status, 200, data)
        self.rid = data['rid']
        self.addCleanup(lambda: self.call({**self.session(self.a, 'rclose'), 'r': self.rid}))

    def hello(self, name):
        status, peer, _ = self.call({'a': 'hello', 'name': name, 'rtc': 0})
        self.assertEqual(status, 200, peer)
        self.assertEqual(ipaddress.ip_address(peer['ip']).version, 4)
        expected = os.environ.get('LAN_TRANSFER_CLIENT_IP')
        if expected or self.url.hostname == '127.0.0.1':
            self.assertEqual(peer['ip'], expected or self.conn_ip(), 'accept 应返回实际客户端地址')
        return peer

    def conn_ip(self):
        conn = self.conn()
        conn.connect()
        return conn.sock.getsockname()[0]

    def session(self, peer, action):
        return {'a': action, 'id': peer['id'], 'key': peer['key']}

    def put(self, n, body=b'data', crc=None, peer=None, conn=None):
        peer = peer or self.a
        query = f'?a=put&id={peer["id"]}&key={peer["key"]}&r={self.rid}&n={n}'
        if crc is not None:
            query += '&c=' + crc
        return self.call(path='/cgi-bin/api' + query, body=body, conn=conn, **{'Content-Type': 'application/octet-stream'})

    def get(self, n, peer=None, conn=None):
        return self.call({**self.session(peer or self.b, 'get'), 'r': self.rid, 'n': n}, conn=conn)

    def test_binary_roundtrip_crc_and_connection_reuse(self):
        upload, download = self.conn(), self.conn()
        for n, size in enumerate((1048576, 65537, 1)):
            body = os.urandom(size)
            crc = f'{binascii.crc32(body):08x}'
            self.assertEqual(self.put(n, body, crc, conn=upload)[0], 200)
            local = upload.sock.getsockname()
            status, raw, headers = self.get(n, conn=download)
            self.assertEqual((status, raw, headers['X-Crc']), (200, body, crc))
            self.assertEqual(headers['Content-Length'], str(size))
            self.assertEqual(self.put(n, body, crc, conn=upload)[0], 200)
            self.assertEqual(upload.sock.getsockname(), local)
        self.assertEqual(self.get(2, conn=download)[1], body, '应答丢失后可重复取最后一块')

    def test_waiting_get_does_not_block_upload_or_presence(self):
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(self.get, 0)
            time.sleep(.1)
            start = time.monotonic()
            self.assertEqual(self.call(self.session(self.a, 'poll'))[0], 200)
            self.assertLess(time.monotonic() - start, .6)
            self.assertEqual(self.put(0, b'wake')[0], 200)
            self.assertEqual(pending.result(timeout=3)[1], b'wake')
        start = time.monotonic()
        self.assertEqual(self.get(1)[0], 204)
        self.assertLess(time.monotonic() - start, 2)

    def test_window_backpressure_reordering_and_cancel(self):
        self.assertEqual(self.put(1, b'second')[0], 200)
        self.assertEqual(self.put(0, b'first')[0], 200)
        self.assertEqual(self.get(0)[1], b'first')
        self.assertEqual(self.get(1)[1], b'second')
        for n in (2, 3, 4):
            self.assertEqual(self.put(n)[0], 200)
        self.assertEqual(self.put(5)[0], 429)
        with ThreadPoolExecutor() as pool:
            waiting = pool.submit(self.put, 5)
            time.sleep(.1)
            self.assertEqual(self.get(2)[0], 200)
            self.assertEqual(waiting.result(timeout=3)[0], 200)
            missing = pool.submit(self.get, 6)
            time.sleep(.1)
            self.assertEqual(self.call({**self.session(self.b, 'rclose'), 'r': self.rid})[0], 200)
            self.assertEqual(missing.result(timeout=3)[0], 404)
        self.assertEqual(self.put(6)[0], 404)

    def test_permissions_origin_and_body_limits(self):
        self.assertEqual(self.get(0, peer=self.a)[0], 404)
        self.assertEqual(self.put(0, peer=self.b)[0], 404)
        self.assertEqual(self.call({**self.session(self.a, 'poll'), 'key': '0' * 32})[0], 401)
        self.assertEqual(self.call({}, Origin='http://evil.example')[0], 403)
        self.assertEqual(self.call({}, Host=f'evil.example:{self.url.port}')[0], 403)
        self.assertEqual(self.put(0, bytes(1048577))[0], 413)
        self.assertEqual(self.call({}, **{'Transfer-Encoding': 'chunked'})[0], 400)

    def test_slow_and_aborted_upload_never_publishes_partial_chunk(self):
        peer = socket.create_connection((self.url.hostname, self.url.port), timeout=3)
        self.addCleanup(peer.close)
        query = f'?a=put&id={self.a["id"]}&key={self.a["key"]}&r={self.rid}&n=0'
        peer.sendall((f'POST /cgi-bin/api{query} HTTP/1.1\r\nHost: {self.url.netloc}\r\n'
                      f'Origin: {self.base}\r\nContent-Type: application/octet-stream\r\n'
                      'Content-Length: 1048576\r\n\r\n').encode() + b'x' * 100)
        self.assertEqual(self.call(self.session(self.a, 'poll'))[0], 200)
        self.assertEqual(self.get(0)[0], 204)
        peer.close()
        self.assertEqual(self.put(0, b'complete')[0], 200)
        self.assertEqual(self.get(0)[1], b'complete')

    def test_slow_download_does_not_block_uploads(self):
        self.assertEqual(self.put(0, os.urandom(1048576))[0], 200)
        peer = socket.socket()
        peer.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        peer.settimeout(3)
        peer.connect((self.url.hostname, self.url.port))
        self.addCleanup(peer.close)
        body = json.dumps({**self.session(self.b, 'get'), 'r': self.rid, 'n': 0}).encode()
        peer.sendall((f'POST /cgi-bin/api HTTP/1.1\r\nHost: {self.url.netloc}\r\nOrigin: {self.base}\r\n'
                      f'Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n').encode() + body)
        time.sleep(.1)
        self.assertEqual(self.put(1, b'next')[0], 200)
        self.assertEqual(self.call(self.session(self.a, 'poll'))[0], 200)
        self.assertEqual(self.get(0)[0], 200)

    def test_http_framing_and_assets(self):
        for extra, status in [('Content-Length: 2\r\n', 400), ('X-Fill: ' + 'x' * 9000 + '\r\n', 431)]:
            peer = socket.create_connection((self.url.hostname, self.url.port), timeout=3)
            self.addCleanup(peer.close)
            peer.sendall((f'POST /cgi-bin/api HTTP/1.1\r\nHost: {self.url.netloc}\r\nOrigin: {self.base}\r\n'
                          'Content-Type: application/json\r\nContent-Length: 2\r\n' + extra + '\r\n{}').encode())
            self.assertTrue(peer.recv(1024).startswith(f'HTTP/1.1 {status} '.encode()))
        conn = self.conn()
        for method, path, expected in [('GET', '/', 200), ('HEAD', '/app.js?v=10', 200),
                                       ('GET', '/cgi-bin/api', 405), ('GET', '/../../../etc/config/network', 404)]:
            conn.request(method, path)
            response = conn.getresponse()
            body = response.read()
            self.assertEqual(response.status, expected)
            if method == 'HEAD':
                self.assertFalse(body)
            if path == '/':
                self.assertIn(b"connect-src 'self'", body)

    def test_global_chunk_budget_released_on_close(self):
        relays = [self.rid]
        for _ in range(3):
            status, data, _ = self.call({**self.session(self.a, 'ropen'), 'to': self.b['id']})
            self.assertEqual(status, 200)
            rid = data['rid']
            relays.append(rid)
            self.addCleanup(lambda rid=rid: self.call({**self.session(self.a, 'rclose'), 'r': rid}))
        chunk = bytes(1048576)
        original = self.rid
        try:
            for rid in relays[:3]:
                self.rid = rid
                for n in range(4):
                    self.assertEqual(self.put(n, chunk)[0], 200)
            self.rid = relays[3]
            self.assertEqual(self.put(0, chunk)[0], 429)
            self.assertEqual(self.call({**self.session(self.a, 'rclose'), 'r': relays[0]})[0], 200)
            self.assertEqual(self.put(0, chunk)[0], 200, '关闭中转必须释放内存块和配额')
        finally:
            self.rid = original

    def test_buffer_budget_preserves_control_and_frees_aborted_uploads(self):
        peers = []
        try:
            for _ in range(7):
                peer = socket.create_connection((self.url.hostname, self.url.port), timeout=3)
                peers.append(peer)
                query = f'?a=put&id={self.a["id"]}&key={self.a["key"]}&r={self.rid}&n=0'
                peer.sendall((f'POST /cgi-bin/api{query} HTTP/1.1\r\nHost: {self.url.netloc}\r\n'
                              f'Origin: {self.base}\r\nContent-Type: application/octet-stream\r\n'
                              'Content-Length: 1048576\r\n\r\n').encode() + b'x')
            time.sleep(.1)
            self.assertEqual(self.put(0, bytes(1048576))[0], 503)
            self.assertEqual(self.call(self.session(self.a, 'poll'))[0], 200, '大块背压不能占满控制请求缓冲')
        finally:
            for peer in peers:
                peer.close()
        time.sleep(.1)
        self.assertEqual(self.put(0, b'complete')[0], 200, '中止的上传必须释放预留缓冲')


if __name__ == '__main__':
    unittest.main(verbosity=2)
