"""Isolated regressions: no router, network access, or writes outside temp dirs.

Run with Python 3 + Node.js + BusyBox ash (preferred) or dash / Git for Windows.
The JS shim tests generated RPC commands, not native ucode compatibility.
"""
import json
import http.server
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = ROOT / "files/etc/uci-defaults"
AUTH = (DEFAULTS / "93-campus-auth").read_text(encoding="utf-8")


def heredoc(source, marker):
    return re.search(r"<<'" + marker + r"'\n(.*?)\n" + marker, source, re.S)[1]


DAEMON = heredoc(AUTH, "DAEMONEOF")
RPC = heredoc(AUTH, "UCEOF")
MAC = heredoc((DEFAULTS / "95-campus-mac-luci").read_text(encoding="utf-8"), "UCEOF")
GUARD = heredoc((DEFAULTS / "89-campus-fw4guard").read_text(encoding="utf-8"), "GUARDEOF")
ENV = dict(os.environ)
git_bin = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/usr/bin"
if os.name == "nt" and git_bin.exists():
    ENV["PATH"] = str(git_bin) + os.pathsep + ENV["PATH"]
busybox = shutil.which("busybox", path=ENV["PATH"])
shell = shutil.which("dash", path=ENV["PATH"])
SHELL = [busybox, "ash"] if busybox else [shell] if shell else None


def run_shell(code, syntax=False, timeout=20):
    if not SHELL:
        raise RuntimeError("Install BusyBox ash or dash (Git for Windows includes dash)")
    # A file avoids Windows command-line truncation and text-mode stdin's
    # CRLF conversion. Firmware scripts must be tested with LF endings.
    with tempfile.TemporaryDirectory(prefix="campus-shell-") as temp:
        script = Path(temp) / "run.sh"
        script.write_text(code, encoding="utf-8", newline="\n")
        return subprocess.run(SHELL + (["-n"] if syntax else []) + [script.as_posix()],
                              env=ENV, capture_output=True, encoding="utf-8", timeout=timeout)


# String-pattern replace() is global in ucode. Keep this distinction from JS.
SHIM = r"""
const fs = require('fs');
const opts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const commands = [];
const readfile = p => (opts.files || {})[p] ?? null;
const cursor = () => ({get: (c, s, o) => (opts.config || {})[o] ?? ''});
const length = s => s.length;
const substr = (s, i, n) => String(s).substr(i, n);
const trim = s => String(s).trim();
const split = (s, p) => String(s).split(p);
const index = (s, p) => String(s).indexOf(p);
const int = (s, base = 10) => typeof s === 'number' ? Math.trunc(s) : parseInt(s, base);
const regexp = s => new RegExp(s);
const match = (s, r) => r.global ? Array.from(String(s).matchAll(r)) : String(s).match(r);
const push = (a, ...v) => a.push(...v);
const filter = (a, fn) => a.filter(fn);
const replace = (s, p, r) => typeof p === 'string'
    ? String(s).replaceAll(p, r) : String(s).replace(p, r);
const sprintf = (fmt, ...args) => {
    let i = 0;
    return fmt.replace(/%02x|%s/g, m => m === '%02x'
        ? Number(args[i++]).toString(16).padStart(2, '0') : String(args[i++]));
};
const popen = cmd => {
    commands.push(cmd);
    if (opts.popenFails) return null;
    let out = '';
    if (cmd === 'command -v curl 2>/dev/null') out = opts.hasCurl === false ? '' : '/usr/bin/curl';
    else if (cmd === 'date +%s') out = `${opts.now || 1000}`;
    else if (cmd.startsWith('date -d @')) out = '2026-09-24 12:00:00';
    else if (cmd.startsWith('umask 077;')) out = (opts.writeFailures || []).some(p => cmd.includes(p)) ? '' : 'saved';
    else if (cmd.startsWith('echo ')) out = `${opts.now || 1000} 00:33:20`;
    else if (cmd.includes('PortalJsonAction.do')) out = JSON.stringify({
        timestamp: '1000', uuid: 'test-uuid', serverip: '10.1.110.3',
        wlanuserip: '10.9.9.9', wlanacname: opts.acname || 'AC1',
        mac: 'aa:bb:cc:dd:ee:ff', vlan: '9'
    });
    else if (cmd.includes('quickauth')) out = JSON.stringify(opts.authReply || {code: '0', message: 'ok'});
    else if (cmd.includes('/portal.do?')) out = '<link href="/style.css"><script src="/portal.js"></script>';
    else if (cmd.includes('3.3.3.3')) out = '<script>location="http://10.1.110.2/portal.do?wlanuserip=10.9.9.9&wlanacname=AC1&mac=aa:bb:cc:dd:ee:ff&vlan=9";</script>';
    return {read: () => out, close: () => {}};
};
"""


def run_rpc(source, object_name, action, **options):
    code = re.sub(r"^import .*?;", "", source, flags=re.M)
    code = re.sub(r"^return \{", "module.exports = {", code, count=1, flags=re.M)
    code = re.sub(r"for \(let (\w+) in ", r"for (let \1 of ", code)
    driver = (f"\nconst result = module.exports.{object_name}.{action}.call({{}}, opts.args || {{}});"
              "\nconsole.log(JSON.stringify({result, commands}));")
    with tempfile.TemporaryDirectory(prefix="campus-rpc-") as temp:
        script = Path(temp) / "rpc.js"
        data = Path(temp) / "input.json"
        script.write_text(SHIM + code + driver, encoding="utf-8")
        data.write_text(json.dumps(options), encoding="utf-8")
        p = subprocess.run(["node", str(script), str(data)], capture_output=True,
                           encoding="utf-8", timeout=20)
        if p.returncode:
            raise AssertionError(p.stderr)
        return json.loads(p.stdout)


class ReviewFixes(unittest.TestCase):
    def assert_shell_ok(self, script):
        p = run_shell(script)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stderr, "")
        return p.stdout

    def test_shell_syntax(self):
        for path in DEFAULTS.iterdir():
            with self.subTest(file=path.name):
                p = run_shell(path.read_text(encoding="utf-8"), syntax=True)
                self.assertEqual(p.returncode, 0, p.stderr)
        for script in (DAEMON, GUARD, heredoc(AUTH, "INITEOF")):
            p = run_shell(script, syntax=True)
            self.assertEqual(p.returncode, 0, p.stderr)

    def test_jitter_all_padded_minutes_and_seconds(self):
        jitter = re.search(r"jittered_sleep\(\) \{.*?\n\}", DAEMON, re.S)[0]
        script = r'''
date() { case "$1" in +%S) printf '%02d\n' "$ss";; +%M) printf '%02d\n' "$mm";; esac; }
sleep() { [ "$1" -ge 59 ] && [ "$1" -le 121 ] || exit 99; }
''' + jitter + r'''
mm=0
while [ "$mm" -lt 60 ]; do
    ss=0
    while [ "$ss" -lt 60 ]; do
        jittered_sleep 90 || exit 98
        ss=$((ss + 1))
    done
    mm=$((mm + 1))
done
echo completed
'''
        # All 3,600 valid clock combinations, including 00/08/09.
        p = run_shell(script, timeout=120)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stderr, "")
        self.assertEqual(p.stdout.strip(), "completed")

    def test_portal_query_preserves_first_parameter(self):
        lines = "\n".join(line for line in DAEMON.splitlines() if line.strip().startswith("Q="))
        query = "wlanuserip=10.9.9.9&wlanacname=AC1&url=http%3A%2F%2Fexample.test%2F%3Fa%3D1"
        script = "REDIRECT=" + shlex.quote("http://10.1.110.2/portal.do?" + query + "#login")
        out = self.assert_shell_ok(script + "\n" + lines + '\nprintf "%s" "$Q"')
        self.assertEqual(out, query)

    def test_guard_boot_and_first_boot_quarantine(self):
        installer = (DEFAULTS / "89-campus-fw4guard").read_text(encoding="utf-8")
        self.assertIn("/etc/init.d/campus-fw4guard start", installer)
        for action in ("boot", "start"):
            for render_rc, nft_rc, empty in ((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)):
                with self.subTest(action=action, render_rc=render_rc, nft_rc=nft_rc, empty=empty):
                    with tempfile.TemporaryDirectory(prefix="campus-guard-") as temp:
                        base = Path(temp).as_posix()
                        rules = Path(temp) / "nftables.d"
                        rules.mkdir()
                        (rules / "test.nft").write_text("test")
                        wifi = Path(temp) / "wifi-lanonly.nft"
                        wifi.write_text("table bridge wifi_lanonly {}\n")
                        guard = GUARD.replace("/etc/nftables.d", base + "/nftables.d").replace("/etc/wifi-lanonly.nft", base + "/wifi-lanonly.nft")
                        # rc.common's default start()/boot() dispatch; no USE_PROCD.
                        script = 'start() { :; }; boot() { start "$@"; };\n' + guard
                        script += f'''
fw4() {{ [ {empty} = 1 ] || echo ruleset; return {render_rc}; }}
nft() {{ cat >/dev/null; return {nft_rc}; }}
logger() {{ :; }}
{action}
'''
                        self.assert_shell_ok(script)
                        rejected = bool(render_rc or nft_rc or empty)
                        self.assertEqual((rules / "test.nft").exists(), not rejected)
                        self.assertEqual((Path(temp) / "nftables.d.disabled/test.nft").exists(), rejected)
                        # WiFi 仅内网的网桥规则经 firewall include 引入，校验失败时也要停用（文件保留、内容换成空规则）
                        self.assertTrue(wifi.exists())
                        self.assertEqual("table bridge" in wifi.read_text(), not rejected)
                        self.assertEqual((Path(temp) / "nftables.d.disabled/wifi-lanonly.nft").exists(), rejected)

    def command_argv(self, command):
        # Execute the actual constructed command against a shell function.
        # Argument boundaries and any unexpected injected stdout are observable.
        # dash forbids '-' in function names; change only the executable
        # name, keeping all generated shell argument quoting untouched.
        self.assertTrue(command.startswith(("uclient-fetch ", "curl ", "command -v curl")))
        command = command.replace("uclient-fetch ", "stub_fetch ")
        out = self.assert_shell_ok('stub_fetch() { printf "%s\\0" "$@"; }; curl() { stub_fetch "$@"; };\n' + command)
        return out.rstrip("\0").split("\0")

    def test_rpc_login_and_logout_shell_injection(self):
        payload = "AC'; printf INJECTED; # second'quote $(printf SUBST) `printf BACKTICK`"
        config = {"username": "user'one&two", "password": "O'br'ien&+% ?", "portal_ip": "10.1.110.2"}
        login = run_rpc(RPC, "campusauth", "login", config=config, acname=payload)
        self.assertEqual(login["result"]["code"], "0")
        requests = [cmd for cmd in login["commands"] if cmd.startswith('curl ')]
        self.assertEqual(len(requests), 6)  # probe, portal, CSS, JS, status, auth
        for command in requests:
            argv = self.command_argv(command)
            self.assertEqual(argv[:2], ["-sS", "--compressed"])
            self.assertEqual(argv[-3:-1], ["-o", "-"])
            self.assertEqual(argv[argv.index('-c') + 1], '/tmp/campus-auth.cookies')
        auth_args = self.command_argv(requests[-1])
        self.assertIn('X-Requested-With: XMLHttpRequest', auth_args)
        from urllib.parse import parse_qs, urlsplit
        params = parse_qs(urlsplit(auth_args[-1]).query)
        self.assertEqual(params['wlanacname'], [payload])
        self.assertEqual(params['passwd'], [config['password']])
        logout = run_rpc(RPC, "campusauth", "logout", config=config,
                         files={"/tmp/campus-auth.params": "wlanuserip=10.9.9.9&wlanacname=" + payload},
                         args={"groupId": payload})
        argv = self.command_argv(logout["commands"][0])
        post = argv[argv.index('-d') + 1]
        self.assertIn("wlanacname=" + payload, post)
        self.assertIn("userid=user%27one%26two", post)
        self.assertEqual(argv[-1], "http://10.1.110.2/quickauthdisconn.do")
        fallback = run_rpc(RPC, 'campusauth', 'login', config=config, hasCurl=False)
        self.assertEqual(fallback['result']['code'], '0')
        for cmd in fallback['commands']:
            if cmd.startswith('uclient-fetch '):
                self.assertEqual(len(self.command_argv(cmd)), 8)

    def test_rpc_popen_failure(self):
        for method in ("login", "logout"):
            result = run_rpc(RPC, "campusauth", method, popenFails=True,
                             config={"username": "test", "password": "test"})["result"]
            self.assertIsNone(result["code"])
            if method == 'login':
                self.assertTrue(result["error"])

    def test_mac_format_and_global_unicast_bits(self):
        for first in ("00", "01", "a1", "ff"):
            mac = run_rpc(MAC, "campusmac", "rotate", files={
                "/proc/sys/kernel/random/uuid": first + "b2c3d4-e5f6-4718-893a-4b5c6d7e8f90\n"
            })["result"]["mac"]
            self.assertRegex(mac, r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")
            self.assertEqual(int(mac[:2], 16) & 3, 0)

    def test_curl_reads_response_body(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"code":"0","message":"local-test"}'
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}/probe'
        fetch = re.search(r'cf_fetch\(\) \{.*?\n\}', DAEMON, re.S)[0]
        try:
            with tempfile.TemporaryDirectory(prefix='campus-http-') as temp:
                jar = (Path(temp) / 'cookies').as_posix()
                prelude = f'HAS_CURL=1; CF_JAR={shlex.quote(jar)}; UA=test; ACC_XHR=application/json;\n'
                out = self.assert_shell_ok(prelude + fetch + f'\ncf_fetch {shlex.quote(url)} xhr ""')
                self.assertEqual(json.loads(out)['message'], 'local-test')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_human_delay_padded_minutes_and_seconds(self):
        delay = re.search(r'human_delay\(\) \{.*?\n\}', DAEMON, re.S)[0]
        script = 'date() { echo 09; }; sleep() { [ "$1" -ge 1 ] && [ "$1" -le 3 ]; };\n'
        self.assert_shell_ok(script + delay + '\nhuman_delay 2')

    def test_ban_survives_new_process_migrates_and_expires(self):
        self.assertIn("BAN_UNTIL_FILE=/etc/campus-auth.banuntil", DAEMON)
        library = DAEMON.split("while true; do", 1)[0]
        with tempfile.TemporaryDirectory(prefix="campus-ban-") as temp:
            base = Path(temp).as_posix()
            persistent = Path(temp) / "persistent.ban"
            legacy = Path(temp) / "legacy.ban"
            lib = library.replace("/etc/campus-auth.banuntil", base + "/persistent.ban")
            lib = lib.replace("/tmp/campus-auth.banuntil", base + "/legacy.ban")
            def boot(now, tail='printf "%s" "$BAN_UNTIL"'):
                prelude = f'uci() {{ :; }}; logger() {{ :; }}; date() {{ echo {now}; }};\n'
                return self.assert_shell_ok(prelude + lib + "\n" + tail)
            boot(1000, "BAN_UNTIL=2000; persist_ban")
            self.assertEqual(persistent.read_text().strip(), "2000")
            self.assertEqual(boot(1001), "2000")  # Fresh process; no /tmp state.
            self.assertEqual(boot(2000), "0")
            self.assertFalse(persistent.exists())
            legacy.write_text("3000\n", newline="\n")
            self.assertEqual(boot(2001), "3000")
            self.assertEqual(persistent.read_text().strip(), "3000")
            self.assertFalse(legacy.exists())
            persistent.write_text("not-an-epoch\n")
            self.assertEqual(boot(2001), "0")
            self.assertEqual(list(Path(temp).glob("persistent.ban.*")), [])

    def test_rpc_ban_guard_uses_persistent_record_and_legacy_fallback(self):
        config = {"username": "test", "password": "test"}
        for path in ("/etc/campus-auth.banuntil", "/tmp/campus-auth.banuntil"):
            with self.subTest(path=path):
                blocked = run_rpc(RPC, "campusauth", "login", config=config, files={path: "2000"}, now=1000)
                self.assertIn("封禁", blocked["result"]["error"])
                self.assertEqual(len(blocked["commands"]), 1)  # date only, no fetch.
                expired = run_rpc(RPC, "campusauth", "login", config=config, files={path: "2000"}, now=2000)
                self.assertEqual(expired["result"]["code"], "0")

    def test_manual_ban_saved_and_next_process_blocked(self):
        config = {"username": "PRIVATE_USER", "password": "PRIVATE_PASSWORD"}
        for message, minutes in (("发现您当前网络环境存在代理行为,禁用认证30分钟", 30),
                                 ("禁止认证 5 分钟", 5), ("代理行为", 30)):
            with self.subTest(message=message), tempfile.TemporaryDirectory(prefix="manual-ban-") as temp:
                result = run_rpc(RPC, "campusauth", "login", config=config, now=1000,
                                 authReply={"code": "-1", "message": message})
                self.assertEqual(result["result"]["message"], message)
                writes = [c for c in result["commands"] if c.startswith("umask 077;")]
                self.assertEqual(len(writes), 2)
                ban = Path(temp) / "ban"
                status = Path(temp) / "status"
                for command in writes:
                    self.assertEqual(self.assert_shell_ok(command.replace(
                        "/etc/campus-auth.banuntil", ban.as_posix()).replace(
                        "/tmp/campus-auth.status", status.as_posix())), "saved")
                until = 1000 + minutes * 60 + 60
                self.assertEqual(ban.read_text().strip(), str(until))
                self.assertTrue(status.read_text(encoding="utf-8").startswith("banned"))
                self.assertEqual(list(Path(temp).glob("*.??????")), [])
                # A fresh RPC process, with no daemon, must honor the saved ban.
                blocked = run_rpc(RPC, "campusauth", "login", config=config, now=until - 1,
                                  files={"/etc/campus-auth.banuntil": ban.read_text()})
                self.assertIn("封禁", blocked["result"]["error"])
                self.assertFalse(any("quickauth" in c or c.startswith("curl ") for c in blocked["commands"]))
                logs = "\n".join(c for c in result["commands"] if c.startswith("logger "))
                self.assertIn("duration_minutes=" + str(minutes), logs)
                self.assertNotIn(config["username"], logs)
                self.assertNotIn(config["password"], logs)
                self.assertNotIn(message, logs)

    def test_manual_ban_fallback_expiry_and_failed_atomic_write(self):
        config = {"username": "test", "password": "test"}
        result = run_rpc(RPC, "campusauth", "login", config=config,
                         authReply={"code": "-1", "message": "代理行为"},
                         writeFailures=["/etc/campus-auth.banuntil"])
        self.assertTrue(any("cooldown=temporary" in c for c in result["commands"]))
        files = {"/etc/campus-auth.banuntil": "500", "/tmp/campus-auth.banuntil": "2860",
                 "/tmp/campus-auth.status": "banned（手动认证收到封禁）"}
        blocked = run_rpc(RPC, "campusauth", "login", config=config, files=files, now=1000)
        self.assertIn("封禁", blocked["result"]["error"])
        status = run_rpc(RPC, "campusauth", "status", files=files, now=2860,
                         config={"day_1": "1", "day_2": "0", "day_0": "1"})
        self.assertTrue(status["result"]["status"].startswith("ban-expired"))
        self.assertEqual(status["result"]["days"], ["1", "0"])
        expired = run_rpc(RPC, "campusauth", "login", config=config, files=files, now=2860)
        self.assertEqual(expired["result"]["code"], "0")
        command = next(c for c in result["commands"] if c.startswith("umask 077;"))
        with tempfile.TemporaryDirectory(prefix="manual-atomic-") as temp:
            ban = Path(temp) / "ban"
            ban.write_text("2000\n")
            command = command.replace("/etc/campus-auth.banuntil", ban.as_posix())
            self.assertEqual(self.assert_shell_ok("mv() { return 1; };\n" + command), "")
            self.assertEqual(ban.read_text(), "2000\n")
            self.assertEqual(list(Path(temp).iterdir()), [ban])

    def test_manual_results_do_not_log_portal_text_or_write_success_to_flash(self):
        config = {"username": "PRIVATE_USER", "password": "PRIVATE_PASSWORD"}
        for reply in ({"code": "0", "message": "ok"},
                      {"code": "-1", "message": "密码错误 PRIVATE_PASSWORD"},
                      {"code": "bad'; echo INJECTED; #", "message": "代理行为 $(touch INJECTED)"}):
            result = run_rpc(RPC, "campusauth", "login", config=config, authReply=reply)
            logs = "\n".join(c for c in result["commands"] if c.startswith("logger "))
            self.assertNotIn("PRIVATE_", logs)
            self.assertNotIn("INJECTED", logs)
            if "代理行为" not in reply["message"]:
                self.assertFalse(any(c.startswith("umask 077;") for c in result["commands"]))

    def test_running_daemon_observes_new_manual_ban(self):
        refresh = re.search(r"refresh_ban\(\) \{.*?\n\}", DAEMON, re.S)[0]
        with tempfile.TemporaryDirectory(prefix="manual-daemon-") as temp:
            ban = Path(temp) / "ban"
            fallback = Path(temp) / "fallback"
            ban.write_text("1500\n", newline="\n")
            fallback.write_text("2860\n", newline="\n")
            script = (f"BAN_UNTIL_FILE={shlex.quote(ban.as_posix())}; "
                      f"LEGACY_BAN_UNTIL_FILE={shlex.quote(fallback.as_posix())}; BAN_UNTIL=0;\n"
                      + refresh + '\nrefresh_ban; printf "%s" "$BAN_UNTIL"')
            self.assertEqual(self.assert_shell_ok(script), "2860")


if __name__ == "__main__":
    print("Shell under test:", SHELL, flush=True)
    unittest.main(verbosity=2)
