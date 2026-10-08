"""打包邻传增量安装包：已在用 OpenWrt 24.10 的路由器不刷机也能装。

python tools/package_lan_transfer.py
输出 firmware-out/lan-transfer-addon.tar.gz 与同名 .sha256（打包结果可复现：固定时间戳、排序、root 属主）。
"""
import gzip
import hashlib
import io
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]
FILES = sorted([
    'etc/init.d/lan-transfer',
    'etc/config/lan-transfer',
    'usr/share/lan-transfer/stun.uc',
    'usr/share/lan-transfer/speed.uc',
    'usr/share/luci/menu.d/luci-app-lan-transfer.json',
    'usr/share/rpcd/acl.d/luci-app-lan-transfer.json',
    'usr/share/ucitrack/lan-transfer.json',
    'www/luci-static/resources/view/lan-transfer.js',
    'www/luci-static/resources/view/lan-speed.js',
    *(p.relative_to(ROOT / 'files').as_posix() for p in (ROOT / 'files/usr/share/lan-transfer/www').rglob('*') if p.is_file()),
])
EXECUTABLE = {'etc/init.d/lan-transfer', 'usr/share/lan-transfer/stun.uc', 'usr/share/lan-transfer/speed.uc', 'usr/share/lan-transfer/www/cgi-bin/api', 'usr/share/lan-transfer/www/cgi-bin/speed'}
MTIME = 1790000000  # 固定时间戳，保证同样的源文件打出同样的包

INSTALL = r'''#!/bin/sh
# 邻传增量安装：只复制本功能的文件，不改网络和防火墙配置，不自动安装软件包。
set -eu
[ "$(id -u)" = 0 ] || { echo '请在路由器上以 root 身份运行' >&2; exit 1; }
for dep in /usr/sbin/uhttpd /usr/bin/ucode /usr/lib/ucode/fs.so /usr/lib/ucode/socket.so; do
	[ -e "$dep" ] || { echo "缺少 $dep，请先执行：opkg update && opkg install uhttpd ucode ucode-mod-fs ucode-mod-socket" >&2; exit 1; }
done
src="$(cd "$(dirname "$0")" && pwd)/files"
# 清掉早期未发布版本的旧文件布局
rm -f /usr/share/lan-transfer/index.html /usr/share/lan-transfer/app.js /usr/share/lan-transfer/style.css \
	/usr/share/lan-transfer/cgi-bin/signal /usr/share/luci/menu.d/lan-transfer.json
rmdir /usr/share/lan-transfer/cgi-bin 2>/dev/null || true
(cd "$src" && find . -type f) | while read -r f; do
	f=${f#./}
	# 已有配置（端口、开关）保留不覆盖
	[ "$f" = etc/config/lan-transfer ] && [ -f /etc/config/lan-transfer ] && continue
	mkdir -p "/$(dirname "$f")"
	cp "$src/$f" "/$f"
done
chmod 0755 /etc/init.d/lan-transfer /usr/share/lan-transfer/stun.uc /usr/share/lan-transfer/speed.uc /usr/share/lan-transfer/www/cgi-bin/api /usr/share/lan-transfer/www/cgi-bin/speed
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null || true
/etc/init.d/lan-transfer enable
/etc/init.d/lan-transfer restart
set +u   # network.sh 内部会引用未定义变量
. /lib/functions/network.sh
network_get_ipaddr lan_ip lan || lan_ip='路由器LAN地址'
echo "邻传已安装：http://${lan_ip}:$(uci -q get lan-transfer.main.port || echo 8080)/"
'''


def add(archive, name, data, mode):
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.mtime = len(data), mode, MTIME
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    archive.addfile(info, io.BytesIO(data))


def main():
    output = ROOT / 'firmware-out/lan-transfer-addon.tar.gz'
    output.parent.mkdir(parents=True, exist_ok=True)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        add(archive, 'install.sh', INSTALL.encode('utf-8'), 0o755)
        add(archive, 'README.md', (ROOT / 'docs/lan-transfer.md').read_bytes(), 0o644)
        for name in FILES:
            data = (ROOT / 'files' / name).read_bytes()
            if b'\r\n' in data:
                raise SystemExit(f'{name} 含 CRLF 行尾，路由器上会执行失败')
            add(archive, 'files/' + name, data, 0o755 if name in EXECUTABLE else 0o644)
    output.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(f'{digest}  {output.name}\n', encoding='ascii')
    print(output)
    print(f'{len(FILES)} 个文件，SHA256: {digest}')


if __name__ == '__main__':
    main()
