// 本机（Windows）测试用的 ucode 模拟层：在 Node 里按 ucode 语义跑 CGI。
// 只用于快速迭代；CI 用与固件同版本的原生 ucode 跑同一组测试，以原生结果为准。
//
// 关键语义：ucode 字符串是字节串。这里统一用 latin1 形式的 JS 字符串表示字节，
// length()/substr() 按字节计；json()/sprintf('%J') 在边界处做 UTF-8 编解码。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');

const script = process.argv[2];
let source = fs.readFileSync(script, 'utf8')
  .replace(/^#!.*\n/, '')
  .replace(/^import .*;$/mg, '');

const toBytes = s => Buffer.from(s, 'utf8').toString('latin1');
const fromBytes = s => Buffer.from(s, 'latin1').toString('utf8');
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[fn(k)] = mapStrings(v, fn);
    return out;
  }
  return value;
}
const safe = fn => { try { return fn(); } catch (_) { return null; } };
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retry(fn) {
  // Windows 上并发改名偶发 EPERM/EBUSY（杀毒或另一个进程正读），重试几次
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i < 20 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { sleepMs(5); continue; }
      throw e;
    }
  }
}

function ucType(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'function') return 'function';
  return 'object';
}
function toJson(v) {
  return toBytes(JSON.stringify(mapStrings(v, fromBytes)));
}
function format(fmt, args) {
  let i = 0;
  return fmt.replace(/%(%|J|s|d|x|0?\d*x)/g, (m, kind) => {
    if (kind === '%') return '%';
    const v = args[i++];
    if (kind === 'J') return toJson(v);
    if (kind === 's') return typeof v === 'string' ? v : v == null ? '(null)' : typeof v === 'object' ? toJson(v) : String(v);
    if (kind === 'd') return String(Math.trunc(Number(v)));
    const hex = (Number(v) >>> 0).toString(16);
    const width = parseInt(kind, 10) || 0;
    return kind.startsWith('0') ? hex.padStart(width, '0') : hex;
  });
}
function write(fd, s) {
  const buf = Buffer.from(s, 'latin1');
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off);
}
function globPattern(pattern) {
  const parts = pattern.split('/');
  let bases = [parts[0] === '' ? '/' : parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i], next = [];
    for (const base of bases) {
      if (!seg.includes('*')) {
        const p = path.posix.join(base, seg);
        if (fs.existsSync(p)) next.push(p);
        continue;
      }
      const re = new RegExp('^' + seg.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
      const names = safe(() => fs.readdirSync(base)) || [];
      for (const name of names.sort()) if (!name.startsWith('.') && re.test(name)) next.push(path.posix.join(base, name));
    }
    bases = next;
  }
  return bases;
}

const held = new Set();
process.on('exit', () => { for (const dir of held) safe(() => fs.rmdirSync(dir)); });
function fileHandle(file) {
  const lockDir = file + '.held';
  return {
    lock(op) {
      if (op.includes('u')) { held.delete(lockDir); safe(() => fs.rmdirSync(lockDir)); return true; }
      const deadline = Date.now() + 20000;
      for (;;) {
        try { fs.mkdirSync(lockDir); held.add(lockDir); return true; } catch (e) {
          if (e.code !== 'EEXIST') return null;
          // 模拟 flock 的“进程退出自动释放”：持锁进程崩溃留下的锁 15 秒后视为失效
          const st = safe(() => fs.statSync(lockDir));
          if (st && Date.now() - st.mtimeMs > 15000) safe(() => fs.rmdirSync(lockDir));
          if (op.includes('n') || Date.now() > deadline) return null;
          sleepMs(3);
        }
      }
    },
    close() { return true; }
  };
}

let stdinCache = null;
let stdinOffset = 0;
const builtins = {
  print: (...args) => { for (const a of args) write(1, typeof a === 'string' ? a : a == null ? '' : typeof a === 'object' ? toJson(a) : String(a)); },
  printf: (fmt, ...args) => write(1, format(fmt, args)),
  warn: (...args) => write(2, args.map(a => typeof a === 'string' ? a : toJson(a)).join('')),
  sprintf: (fmt, ...args) => format(fmt, args),
  exit: code => process.exit(code),
  getenv: key => key in process.env ? toBytes(process.env[key]) : null,
  clock: () => [Math.floor(os.uptime()), 0],
  sleep: ms => { sleepMs(ms); return true; },
  type: ucType,
  length: v => v == null ? null : typeof v === 'string' || Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : null,
  substr: (s, off, len) => typeof s === 'string' ? (len === undefined ? s.substr(off) : s.substr(off, len)) : null,
  index: (s, needle) => (typeof s === 'string' || Array.isArray(s)) ? s.indexOf(needle) : null,
  split: (s, sep) => typeof s === 'string' ? s.split(sep) : null,
  join: (sep, arr) => Array.isArray(arr) ? arr.join(sep) : null,
  trim: s => typeof s === 'string' ? s.trim() : null,
  replace: (s, re, repl) => typeof s === 'string' ? s.replace(re, repl) : null,
  match: (s, re) => {
    if (typeof s !== 'string') return null;
    const m = s.match(re);
    return m ? Array.from(m, v => v === undefined ? null : v) : null;
  },
  int: v => { const n = typeof v === 'number' ? Math.trunc(v) : parseInt(v, 10); return Number.isNaN(n) ? NaN : n; },
  json: s => { if (typeof s !== 'string') throw new Error('json(): not a string'); return mapStrings(JSON.parse(fromBytes(s)), toBytes); },
  keys: o => o && typeof o === 'object' ? Object.keys(o) : null,
  push: (arr, ...v) => { arr.push(...v); return v[v.length - 1]; },
  filter: (arr, fn) => Array.isArray(arr) ? arr.filter(v => fn(v)) : null,
  map: (arr, fn) => Array.isArray(arr) ? arr.map(v => fn(v)) : null,
  sort: (arr, fn) => Array.isArray(arr) ? arr.sort(fn) : null,
  ord: (s, i = 0) => typeof s === 'string' && i < s.length ? s.charCodeAt(i) : null,
  chr: (...codes) => String.fromCharCode(...codes.map(c => c & 255)),
  iptoarr: s => s.split('.').map(Number),
  readfile: p => {
    if (p === '/proc/sys/kernel/random/uuid') return crypto.randomUUID() + '\n';
    const data = safe(() => fs.readFileSync(p));
    return data ? data.toString('latin1') : null;
  },
  writefile: (p, data) => safe(() => { const buf = Buffer.from(String(data), 'latin1'); fs.writeFileSync(p, buf); return buf.length; }),
  mkdir: (p, mode) => safe(() => { fs.mkdirSync(p, { mode }); return true; }),
  rmdir: p => safe(() => { fs.rmdirSync(p); return true; }),
  unlink: p => safe(() => { fs.unlinkSync(p); return true; }),
  rename: (a, b) => safe(() => { retry(() => fs.renameSync(a, b)); return true; }),
  glob: pattern => globPattern(pattern),
  stat: p => {
    if (p.startsWith('/proc/')) return null;
    const st = safe(() => fs.statSync(p));
    return st ? { size: st.size, type: st.isDirectory() ? 'directory' : 'file', mtime: Math.floor(st.mtimeMs / 1000) } : null;
  },
  open: (p, mode) => safe(() => { fs.closeSync(fs.openSync(p, mode === 'a' ? 'a' : mode)); return fileHandle(p); }),
  stdin: {
    read: n => {
      if (stdinCache === null) stdinCache = safe(() => fs.readFileSync(0)) || Buffer.alloc(0);
      const data = stdinCache.subarray(stdinOffset, stdinOffset + n).toString('latin1');
      stdinOffset += data.length;
      return data;
    }
  }
};

vm.runInNewContext(source, builtins, { filename: script });
