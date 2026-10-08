"""常驻测速服务的真实 TCP 测试：原生 ucode，或 LAN_SPEED_URL 指定真机。"""
import http.client
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
        base = os.environ.get('LAN_SPEED_URL')
        if not base:
            if not native_socket_module():
                raise unittest.SkipTest('需要原生 ucode + socket，或 LAN_SPEED_URL 真机地址')
            temp = tempfile.TemporaryDirectory(prefix='lan-speed-')
            cls.addClassCleanup(temp.cleanup)
            process = subprocess.Popen(ucode_command() + [str(ROOT / 'files/usr/share/lan-transfer/speed.uc'),
                '127.0.0.1', '8765', temp.name, str(WWW)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            cls.addClassCleanup(lambda: process.communicate(timeout=5))
            cls.addClassCleanup(process.terminate)
            metadata = Path(temp.name) / 'speed.json'
            for _ in range(100):
                if metadata.exists():
                    break
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read().decode())
                time.sleep(.05)
            info = json.loads(metadata.read_text())
            base = f'http://127.0.0.1:{info["port"]}'
        cls.base = base.rstrip('/')
        cls.url = urlsplit(cls.base)
        cls.chunk = 4194304

    def connection(self):
        conn = http.client.HTTPConnection(self.url.hostname, self.url.port, timeout=5)
        self.addCleanup(conn.close)
        return conn

    def request(self, action='ping', body=b'', conn=None, **headers):
        conn = conn or self.connection()
        h = {'Origin': self.base, 'Content-Type': 'application/octet-stream'}
        h.update(headers)
        conn.request('POST', '/speed?a=' + action, body, h)
        response = conn.getresponse()
        data = response.read()
        return response, data

    def test_connection_reuse_and_exact_download(self):
        conn = self.connection()
        response, body = self.request(conn=conn)
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(body), {'ok': True})
        peer = conn.sock.getsockname()
        response, body = self.request('download', conn=conn)
        self.assertEqual(response.status, 200)
        self.assertEqual(len(body), self.chunk)
        self.assertEqual(body, bytes(self.chunk))
        self.assertEqual(response.getheader('Content-Length'), str(self.chunk))
        self.assertEqual(response.getheader('Content-Type'), 'application/octet-stream')
        self.assertIsNone(response.getheader('Content-Encoding'))
        self.assertIn('no-store', response.getheader('Cache-Control'))
        self.assertEqual(conn.sock.getsockname(), peer, '下载应复用同一 TCP 连接')
        response, body = self.request(conn=conn)
        self.assertEqual(json.loads(body), {'ok': True})

    def test_upload_acknowledges_received_bytes(self):
        for size in (1, 65537, self.chunk):
            response, body = self.request('upload', os.urandom(size))
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(body), {'bytes': size})

    def test_rejects_invalid_requests(self):
        for action, body, headers, status in [
            ('ping', b'', {'Origin': 'http://evil.example'}, 403),
            ('ping', b'', {'Origin': ''}, 403),
            ('ping', b'', {'Host': f'evil.example:{self.url.port}'}, 403),
            ('download', b'x', {}, 400),
            ('upload', b'', {}, 400),
            ('upload', b'', {'Content-Length': str(self.chunk + 1)}, 413),
            ('ping', b'', {'Content-Type': 'text/plain'}, 415),
            ('ping', b'', {'Transfer-Encoding': 'chunked'}, 400),
            ('unknown', b'', {}, 404),
        ]:
            with self.subTest(action=action, headers=headers):
                response, _ = self.request(action, body, **headers)
                self.assertEqual(response.status, status)

    def test_aborted_upload_never_acknowledges_partial_bytes(self):
        peer = socket.create_connection((self.url.hostname, self.url.port), timeout=2)
        self.addCleanup(peer.close)
        peer.sendall((f'POST /speed?a=upload HTTP/1.1\r\nHost: {self.url.netloc}\r\n'
                      f'Origin: {self.base}\r\nContent-Type: application/octet-stream\r\n'
                      'Content-Length: 65536\r\n\r\n').encode() + b'x' * 100)
        peer.settimeout(.2)
        with self.assertRaises(socket.timeout):
            peer.recv(1024)
        peer.close()
        response, body = self.request()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(body), {'ok': True})

    def test_duplicate_headers_and_header_limit(self):
        for extra, expected in [('Content-Length: 1\r\n', 400), ('X-Fill: ' + 'x' * 9000 + '\r\n', 431)]:
            with self.subTest(expected=expected):
                peer = socket.create_connection((self.url.hostname, self.url.port), timeout=2)
                self.addCleanup(peer.close)
                peer.sendall((f'POST /speed?a=ping HTTP/1.1\r\nHost: {self.url.netloc}\r\n'
                              f'Origin: {self.base}\r\nContent-Type: application/octet-stream\r\n'
                              'Content-Length: 0\r\n' + extra + '\r\n').encode())
                response = peer.recv(1024)
                self.assertTrue(response.startswith(f'HTTP/1.1 {expected} '.encode()), response)

    def test_slow_download_does_not_block_other_clients(self):
        peer = socket.create_connection((self.url.hostname, self.url.port), timeout=2)
        self.addCleanup(peer.close)
        peer.sendall((f'POST /speed?a=download HTTP/1.1\r\nHost: {self.url.netloc}\r\n'
                      f'Origin: {self.base}\r\nContent-Type: application/octet-stream\r\n'
                      'Content-Length: 0\r\n\r\n').encode())
        time.sleep(.1)
        response, body = self.request()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(body), {'ok': True})

    def test_assets_and_neighbor_navigation(self):
        conn = self.connection()
        for path, ctype in [('/speed.html', 'text/html'), ('/speed.js?v=3', 'text/javascript'), ('/style.css?v=2', 'text/css')]:
            conn.request('GET', path)
            response = conn.getresponse()
            body = response.read()
            self.assertEqual(response.status, 200)
            self.assertTrue(response.getheader('Content-Type').startswith(ctype))
            if path == '/speed.html':
                self.assertIn(b"connect-src 'self'", body)
        conn.request('GET', '/../../../etc/config/network')
        response = conn.getresponse()
        response.read()
        self.assertEqual(response.status, 404)
        response, data = self.request('ping')
        self.assertEqual(response.status, 200)
        conn = self.connection()
        conn.request('GET', '/')
        response = conn.getresponse()
        response.read()
        self.assertEqual(response.status, 302)
        self.assertTrue(response.getheader('Location').startswith('http://' + self.url.hostname + ':'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
