"""真机中转 A/B：同一有线客户端模拟收发双方，2 块上传流水线、顺序确认，逐块核对内容。"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
from pathlib import Path
import statistics
import threading
import time
from urllib.parse import urlsplit


def measure(base, count):
    url = urlsplit(base.rstrip('/'))
    connections = []
    local = threading.local()

    def post(data=None, query='', raw=None):
        if not hasattr(local, 'conn'):
            local.conn = http.client.HTTPConnection(url.hostname, url.port, timeout=35)
            connections.append(local.conn)
        body = raw if raw is not None else json.dumps(data).encode()
        local.conn.request('POST', '/cgi-bin/api' + query, body,
            {'Origin': base.rstrip('/'), 'Content-Type': 'application/octet-stream' if raw is not None else 'application/json'})
        res = local.conn.getresponse()
        body = res.read()
        if res.getheader('Content-Type', '').startswith('application/json'):
            body = json.loads(body)
        return res.status, body

    def call(data):
        status, body = post(data)
        if status != 200:
            raise RuntimeError((status, body))
        return body

    a = call({'a': 'hello', 'name': '中转基准发送', 'rtc': 0})
    b = call({'a': 'hello', 'name': '中转基准接收', 'rtc': 0})
    session = lambda p, action: {'a': action, 'id': p['id'], 'key': p['key']}
    rid = None
    stopped = threading.Event()
    block = os.urandom(1048576)
    expected = hashlib.sha256(block).digest()
    try:
        info = call({**session(a, 'ropen'), 'to': b['id']})
        rid = info['rid']

        def put(n):
            query = f'?a=put&id={a["id"]}&key={a["key"]}&r={rid}&n={n}'
            deadline = time.monotonic() + 30
            while not stopped.is_set():
                status, body = post(query=query, raw=block)
                if status == 200:
                    return
                if status not in (429, 503) or time.monotonic() > deadline:
                    raise RuntimeError((status, body))
                time.sleep(.15)
            raise RuntimeError('receiver failed')

        def receive():
            try:
                for n in range(count):
                    deadline = time.monotonic() + 30
                    while True:
                        status, body = post({**session(b, 'get'), 'r': rid, 'n': n})
                        if status == 200:
                            assert len(body) == len(block) and hashlib.sha256(body).digest() == expected
                            break
                        if status != 204 or time.monotonic() > deadline:
                            raise RuntimeError((status, body))
            except BaseException:
                stopped.set()
                raise

        start = time.perf_counter()
        with ThreadPoolExecutor(max_workers=3) as pool:
            download = pool.submit(receive)
            uploads = []
            for n in range(count):
                if len(uploads) >= 2:
                    uploads.pop(0).result()
                uploads.append(pool.submit(put, n))
            for upload in uploads:
                upload.result()
            download.result()
        elapsed = time.perf_counter() - start
        return {'seconds': round(elapsed, 3), 'MB_s': round(count * len(block) / elapsed / 1e6, 3), 'bytes': count * len(block), 'verified': True}
    finally:
        if rid:
            call({**session(a, 'rclose'), 'r': rid})
        for p in (a, b):
            call(session(p, 'bye'))
        for conn in connections:
            conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('urls', nargs='+')
    parser.add_argument('--mib', type=int, default=32)
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    results = {base: [] for base in args.urls}
    for _ in range(args.runs):
        for base in args.urls:
            result = measure(base, args.mib)
            results[base].append(result)
            print(base, result, flush=True)
    report = {'method': 'same wired PC as sender and receiver; 1 MiB blocks; two uploads in flight; sequential verified downloads',
              'results': results, 'median_MB_s': {base: statistics.median(r['MB_s'] for r in rows) for base, rows in results.items()}}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('median MB/s:', report['median_MB_s'])


if __name__ == '__main__':
    main()
