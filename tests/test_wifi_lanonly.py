"""WiFi 仅内网模块回归测试。

python tests/test_wifi_lanonly.py
用 BusyBox ash / dash 实跑 /usr/libexec/wifi-lanonly/ctl，iwinfo、nft、fw4、uci 用桩函数代替；
CI 另用真实 nft 校验生成的网桥规则（--render-sample 输出样例）。
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

from test_lan_transfer import shell

ROOT = Path(__file__).resolve().parents[1]
CTL = ROOT / 'files/usr/libexec/wifi-lanonly/ctl'
DROPIN = ROOT / 'files/etc/nftables.d/40-wifi-lanonly.nft'
HOTPLUG = ROOT / 'files/etc/hotplug.d/net/60-wifi-lanonly'
DEFAULTS = ROOT / 'files/etc/uci-defaults/88-wifi-lanonly'
VIEW = ROOT / 'files/www/luci-static/resources/view/wifi-lanonly-v1.js'
MENU = ROOT / 'files/usr/share/luci/menu.d/luci-app-wifi-lanonly.json'
ACL = ROOT / 'files/usr/share/rpcd/acl.d/luci-app-wifi-lanonly.json'

STUBS = r'''
iwinfo() {
	f="$STATE/iw/$1"
	[ -f "$f" ] || return 1
	case "$2" in
		info) cat "$f" ;;
		assoclist) cat "$f.assoc" 2>/dev/null ;;
	esac
}
nft() {
	echo "nft $*" >> "$STATE/calls"
	case "$1 $2" in
		"-c -f") cp "$3" "$STATE/checked.nft"; [ ! -f "$STATE/nft_fail" ] ;;
		"list chain") echo '		meta mark & 0x40000000 == 0x40000000 oifname != "br-lan" counter packets 44 bytes 2816 reject' ;;
		"list table") [ -f "$STATE/bridge_on" ] ;;
	esac
}
fw4() { echo "fw4 $*" >> "$STATE/calls"; }
logger() { echo "log $*" >> "$STATE/calls"; }
lock() { :; }
uci() {
	case "$*" in
		"-q get firewall.wifi_lanonly") cat "$STATE/fw_include" 2>/dev/null ;;
		"-q batch") cat > "$STATE/batch"; echo include > "$STATE/fw_include"; echo "uci batch" >> "$STATE/calls" ;;
		"-q show wireless") cat "$STATE/wireless" ;;
	esac
}
'''

WIRELESS = """wireless.radio0=wifi-device
wireless.radio0.disabled='1'
wireless.default_radio0=wifi-iface
wireless.default_radio0.device='radio0'
wireless.default_radio0.mode='ap'
wireless.default_radio0.ssid='OpenWrt'
wireless.radio1=wifi-device
wireless.default_radio1=wifi-iface
wireless.default_radio1.device='radio1'
wireless.default_radio1.mode='ap'
wireless.default_radio1.ssid='91'
wireless.guest=wifi-iface
wireless.guest.device='radio1'
wireless.guest.mode='ap'
wireless.guest.ssid='it'\\''s "访客"\\'
wireless.sta=wifi-iface
wireless.sta.device='radio1'
wireless.sta.mode='sta'
wireless.sta.ssid='upstream'
"""


def iw_info(ssid, mode='Master'):
    essid = f'"{ssid}"' if ssid is not None else 'unknown'
    return f'xx  ESSID: {essid}\n          Access Point: 28:D1:27:BA:70:38\n          Mode: {mode}  Channel: 36 (5.180 GHz)\n'


class Router:
    """一个临时的「路由器」：假的 /sys/class/net、iwinfo 输出、uci 配置和规则文件。"""

    def __init__(self, sh, temp):
        self.sh = sh
        self.dir = Path(temp)
        for sub in ['net', 'iw']:
            (self.dir / sub).mkdir()
        (self.dir / 'wireless').write_text(WIRELESS, encoding='utf-8', newline='\n')
        self.list = self.dir / 'wifi-lanonly.list'
        self.nft = self.dir / 'wifi-lanonly.nft'
        self.nft.write_text('# 默认\n', encoding='utf-8')
        self.add_iface('lan1', None, wireless=False)

    def add_iface(self, name, ssid, wireless=True, mode='Master', stations=0):
        (self.dir / 'net' / name).mkdir(exist_ok=True)
        if wireless:
            (self.dir / 'net' / name / 'phy80211').mkdir(exist_ok=True)
            (self.dir / 'iw' / name).write_text(iw_info(ssid, mode).replace('xx', name, 1), encoding='utf-8', newline='\n')
            (self.dir / 'iw' / f'{name}.assoc').write_text(
                ''.join(f'AA:BB:CC:DD:EE:{i:02X}  -40 dBm / -95 dBm (SNR 55)  10 ms ago\n' for i in range(stations)),
                encoding='utf-8', newline='\n')

    def calls(self):
        f = self.dir / 'calls'
        return f.read_text(encoding='utf-8').splitlines() if f.exists() else []

    def reset_calls(self):
        (self.dir / 'calls').unlink(missing_ok=True)

    def run(self, *args):
        body = CTL.read_text(encoding='utf-8').replace('#!/bin/sh\n', '', 1)
        script = self.dir / 'ctl.sh'
        script.write_text(STUBS + body, encoding='utf-8', newline='\n')
        env = dict(os.environ, STATE=self.dir.as_posix(), WIFI_LANONLY_LIST=self.list.as_posix(),
                   WIFI_LANONLY_NFT=self.nft.as_posix(), WIFI_LANONLY_NET=(self.dir / 'net').as_posix())
        return subprocess.run(self.sh + [script.as_posix(), *args], capture_output=True, env=env, timeout=30)


class CtlTests(unittest.TestCase):
    def setUp(self):
        self.sh = shell()
        if not self.sh:
            self.skipTest('需要 busybox ash 或 dash')
        temp = tempfile.TemporaryDirectory(prefix='wifi-lanonly-')
        self.addCleanup(temp.cleanup)
        self.r = Router(self.sh, temp.name)
        self.r.add_iface('phy1-ap0', '91', stations=2)
        self.r.add_iface('phy1-ap1', 'it\'s "访客"\\')
        self.r.add_iface('phy1-sta0', 'upstream', mode='Client')

    def nft_text(self):
        return self.r.nft.read_text(encoding='utf-8')

    def test_enable_marks_only_selected_ssid(self):
        result = self.r.run('set', '91', '1')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(self.r.list.read_text(encoding='utf-8'), '91\n')
        text = self.nft_text()
        self.assertIn('table bridge wifi_lanonly {', text)
        self.assertIn('type filter hook prerouting priority -200; policy accept;', text)
        self.assertIn('iifname { "phy1-ap0" } meta mark set meta mark | 0x40000000 counter', text)
        self.assertNotIn('phy1-ap1', text)
        self.assertNotIn('phy1-sta0', text, '客户端模式网口不能被标记')
        self.assertNotIn('lan1', text, '有线口不能被标记')
        calls = self.r.calls()
        self.assertIn('uci batch', calls, '首次应写入 fw4 include')
        batch = (self.r.dir / 'batch').read_text(encoding='utf-8')
        self.assertIn("set firewall.wifi_lanonly.position='ruleset-append'", batch)
        self.assertIn(f"set firewall.wifi_lanonly.path='{self.r.nft.as_posix()}'", batch)
        self.assertTrue(any(c.startswith('nft -c -f ') for c in calls), '写入前要让内核校验')
        self.assertIn('fw4 -q reload', calls)

        # 再设置一次：内容不变、include 已存在，不重复重载防火墙
        self.r.reset_calls()
        self.assertEqual(self.r.run('set', '91', '1').returncode, 0)
        self.assertEqual(self.r.list.read_text(encoding='utf-8'), '91\n', '不能重复写入')
        self.assertNotIn('fw4 -q reload', self.r.calls())

    def test_dual_band_same_ssid_and_special_names(self):
        self.r.add_iface('phy0-ap0', '91')
        self.assertEqual(self.r.run('set', '91', '1').returncode, 0)
        self.assertIn('iifname { "phy0-ap0", "phy1-ap0" }', self.nft_text())
        tricky = 'it\'s "访客"\\'
        self.assertEqual(self.r.run('set', tricky, '1').returncode, 0)
        self.assertIn('iifname { "phy0-ap0", "phy1-ap0", "phy1-ap1" }', self.nft_text())
        self.assertEqual(self.r.list.read_text(encoding='utf-8'), f'91\n{tricky}\n')
        # 正则元字符不能误匹配
        self.assertEqual(self.r.run('set', '9.', '1').returncode, 0)
        self.assertEqual(self.r.run('set', '9.', '0').returncode, 0)
        self.assertEqual(self.r.list.read_text(encoding='utf-8'), f'91\n{tricky}\n')

    def test_disable_removes_table(self):
        self.r.run('set', '91', '1')
        self.r.reset_calls()
        self.assertEqual(self.r.run('set', '91', '0').returncode, 0)
        self.assertEqual(self.r.list.read_text(encoding='utf-8'), '')
        text = self.nft_text()
        self.assertIn('delete table bridge wifi_lanonly', text)
        self.assertNotIn('table bridge wifi_lanonly {', text)
        self.assertIn('fw4 -q reload', self.r.calls())

    def test_not_ready_iface_keeps_rules(self):
        self.r.run('set', '91', '1')
        before = self.nft_text()
        self.r.add_iface('phy1-ap0', None)  # WiFi 重启中，读不到 SSID
        self.r.reset_calls()
        result = self.r.run('apply')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.nft_text(), before, 'WiFi 未就绪时不能解除隔离')
        self.assertNotIn('fw4 -q reload', self.r.calls())
        # set 时遇到未就绪不算失败，清单照样更新
        self.assertEqual(self.r.run('set', 'OpenWrt', '1').returncode, 0)
        self.assertIn('OpenWrt', self.r.list.read_text(encoding='utf-8'))

    def test_validation_failure_does_not_break_firewall(self):
        (self.r.dir / 'nft_fail').write_text('')
        result = self.r.run('set', '91', '1')
        self.assertEqual(result.returncode, 3)
        text = self.nft_text()
        self.assertNotIn('table bridge', text, '校验失败时不能把网桥规则交给 fw4')
        self.assertIn('kmod-nft-bridge', text)
        self.assertIn('fw4 -q reload', self.r.calls())

    def test_status_json(self):
        self.r.run('set', '91', '1')
        (self.r.dir / 'bridge_on').write_text('')
        with self.r.list.open('a', encoding='utf-8', newline='\n') as f:
            f.write('旧名字\n')
        result = self.r.run('status')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        data = json.loads(result.stdout.decode('utf-8'))
        self.assertEqual(data['blocked'], 44)
        self.assertIs(data['active'], True)
        by = {s['ssid']: s for s in data['ssids']}
        self.assertEqual(list(by), ['OpenWrt', '91', 'it\'s "访客"\\', '旧名字'], '客户端模式 SSID 不列出')
        self.assertEqual(by['91'], {'ssid': '91', 'radio': 'radio1', 'disabled': False, 'lanonly': True,
                                    'ifnames': ['phy1-ap0'], 'stations': 2})
        self.assertEqual(by['OpenWrt']['disabled'], True, '所在射频关闭也算关闭')
        self.assertEqual(by['OpenWrt']['ifnames'], [])
        self.assertIs(by['it\'s "访客"\\']['lanonly'], False)
        self.assertEqual(by['旧名字'], {'ssid': '旧名字', 'radio': '', 'disabled': True, 'lanonly': True, 'ifnames': [], 'stations': 0})

    def test_rejects_invalid_input(self):
        for args in [('set', '', '1'), ('set', 'a' * 33, '1'), ('set', 'a\nb', '1'), ('set', '91', '2'),
                     ('set', '91'), ('bogus',), ()]:
            with self.subTest(args=args):
                self.assertEqual(self.r.run(*args).returncode, 2)
        self.assertFalse(self.r.list.exists() and self.r.list.read_text(encoding='utf-8'), '无效输入不能改动清单')
        self.assertEqual(self.r.run('set', '中' * 10, '1').returncode, 0, '32 字节以内的中文 SSID 可以')
        self.assertEqual(self.r.run('set', '中' * 11, '1').returncode, 2, '超过 32 字节')

    def test_shell_syntax(self):
        for path in [CTL, HOTPLUG, DEFAULTS]:
            result = subprocess.run(self.sh + ['-n', path.as_posix()], capture_output=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, f'{path.name}: {result.stderr}')


class FileTests(unittest.TestCase):
    def test_dropin_rule(self):
        text = DROPIN.read_text(encoding='utf-8')
        self.assertIn('type filter hook forward priority filter - 20; policy accept;', text)
        self.assertIn('meta mark & 0x40000000 == 0x40000000 oifname != "br-lan" counter reject', text)
        ctl = CTL.read_text(encoding='utf-8')
        self.assertIn('MARK=0x40000000', ctl, '标记位与转发规则一致')
        self.assertIn('wifi_lanonly_forward', ctl, '状态读取的链名与规则一致')

    def test_luci_files(self):
        for path in [CTL, DROPIN, HOTPLUG, DEFAULTS, VIEW, MENU, ACL, ROOT / 'files/etc/wifi-lanonly.nft']:
            raw = path.read_bytes()
            self.assertNotIn(b'\r\n', raw, path.name)
            raw.decode('utf-8')
        menu = json.loads(MENU.read_text(encoding='utf-8'))['admin/network/wifi-lanonly']
        self.assertEqual(ROOT / f"files/www/luci-static/resources/view/{menu['action']['path']}.js", VIEW)
        acl = json.loads(ACL.read_text(encoding='utf-8'))['luci-app-wifi-lanonly']
        self.assertEqual(acl['read']['file'], {'/usr/libexec/wifi-lanonly/ctl status': ['exec']})
        self.assertEqual(acl['write']['file'], {'/usr/libexec/wifi-lanonly/ctl set *': ['exec']})
        check = 'new Function(require("fs").readFileSync(process.argv[1], "utf8"))'
        result = subprocess.run(['node', '-e', check, str(VIEW)], capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('innerHTML', VIEW.read_text(encoding='utf-8'))
        self.assertNotIn('table bridge', (ROOT / 'files/etc/wifi-lanonly.nft').read_text(encoding='utf-8'),
                         '默认规则文件不能依赖网桥模块')

    def test_build_installs_and_verifies(self):
        build = (ROOT / '.github/workflows/build.yml').read_text(encoding='utf-8')
        self.assertRegex(build, r'PKGS="\$PKGS[^"]*\bkmod-nft-bridge\b')
        self.assertIn('python3 tests/test_wifi_lanonly.py', build)
        self.assertIn('--render-sample', build, 'CI 用真实 nft 校验生成的网桥规则')
        for path in ['usr/libexec/wifi-lanonly/ctl', 'etc/hotplug.d/net/60-wifi-lanonly', 'etc/uci-defaults/88-wifi-lanonly']:
            self.assertIn('ib/files/' + path, build)
        self.assertIn('www/luci-static/resources/view/wifi-lanonly-v1.js', build)


def render_sample(target):
    """CI：生成一份开启了两个网口的网桥规则，交给真实 nft 校验。"""
    sh = shell()
    with tempfile.TemporaryDirectory(prefix='wifi-lanonly-') as temp:
        r = Router(sh, temp)
        r.add_iface('phy0-ap0', '91')
        r.add_iface('phy1-ap0', '91')
        r.list.write_text('91\n', encoding='utf-8')
        result = r.run('render')
        assert result.returncode == 0, result.stderr
        Path(target).write_bytes(result.stdout)
        assert b'iifname { "phy0-ap0", "phy1-ap0" }' in result.stdout


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--render-sample':
        render_sample(sys.argv[2])
    else:
        unittest.main()
