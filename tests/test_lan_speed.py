"""路由器测速 CGI：真实字节读写、请求边界与来源限制。CI 使用原生 ucode。"""
import json
import unittest
from test_lan_transfer import Backend, SPEED


class SpeedCase(unittest.TestCase):
    def setUp(self):
        self.backend = Backend(SPEED.read_text(encoding='utf-8'))
        self.addCleanup(self.backend.close)

    def run_request(self, action='ping', body=b'', **env):
        return self.backend.run(body, query='a=' + action, ctype='application/octet-stream', **env)

    def test_ping_and_uncached_binary_download(self):
        code, headers, body = self.run_request()
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body), {'ok': True})
        code, headers, body = self.run_request('download')
        self.assertEqual(code, 200)
        self.assertEqual(headers['content-type'], 'application/octet-stream')
        self.assertEqual(int(headers['content-length']), len(body))
        self.assertEqual(len(body), 1048576)
        self.assertIn('no-store', headers['cache-control'])
        self.assertNotIn('content-encoding', headers)

    def test_upload_counts_bytes_across_blocks(self):
        for length in (1, 65535, 65536, 65537, 1048576):
            with self.subTest(length=length):
                body = bytes(range(256)) * (length // 256) + bytes(range(length % 256))
                code, _, data = self.run_request('upload', body)
                self.assertEqual(code, 200)
                self.assertEqual(json.loads(data), {'bytes': length})
        code, _, _ = self.run_request('upload', b'x' * 65536, CONTENT_LENGTH='65537')
        self.assertEqual(code, 400)

    def test_rejects_invalid_requests(self):
        for action, body, env, expected in [
            ('ping', b'', {'method': 'GET'}, 405),
            ('ping', b'', {'HTTP_ORIGIN': 'http://evil.example'}, 403),
            ('ping', b'', {'HTTP_HOST': 'evil.example:8765', 'HTTP_ORIGIN': 'http://evil.example:8765'}, 403),
            ('ping', b'', {'HTTP_ORIGIN': None}, 403),
            ('invalid', b'', {}, 400),
            ('ping', b'x', {}, 400),
            ('upload', b'', {}, 400),
            ('upload', b'', {'CONTENT_LENGTH': '1048577'}, 413),
            ('ping', b'', {'CONTENT_LENGTH': None}, 411),
            ('ping', b'', {'CONTENT_LENGTH': '-1'}, 411),
            ('ping', b'', {'CONTENT_TYPE': 'text/plain'}, 415),
        ]:
            with self.subTest(action=action, env=env):
                self.assertEqual(self.run_request(action, body, **env)[0], expected)
        self.assertEqual(self.run_request(HTTP_HOST='openwrt.lan:8765', HTTP_ORIGIN='http://openwrt.lan:8765')[0], 200)


if __name__ == '__main__':
    unittest.main(verbosity=2)
