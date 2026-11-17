'use strict';

// 结构化调试日志：JSONL 落盘 + 轮转 + 内存环形缓冲 + 级别过滤。
// 设计目的：QQ 崩溃 / 重启后仍能复核拦截链路，且日志不写消息正文。
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const RING_MAX = 800;
const MAX_TEXT = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 3;

function clip(value) {
  const text = String(value);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…[' + text.length + ']' : text;
}

function safe(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Error) {
    return { name: value.name, message: clip(value.message), stack: value.stack ? clip(value.stack) : '' };
  }
  const type = typeof value;
  if (type === 'string') return clip(value);
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'boolean' || type === 'bigint') return value;
  if (type === 'function' || type === 'symbol') return String(value);
  if (Buffer.isBuffer(value)) return '[Buffer ' + value.length + ']';
  if (depth >= 3) return '[depth-limit]';
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map(item => safe(item, depth + 1));
    if (value.length > 20) head.push('[+' + (value.length - 20) + ' more]');
    return head;
  }
  const out = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (++count > 40) { out.__truncated = true; break; }
    try { out[key] = safe(item, depth + 1); }
    catch { out[key] = '[unserializable]'; }
  }
  return out;
}

class DebugLogger {
  constructor(dataDir, options = {}) {
    this.dir = path.join(dataDir, 'logs');
    this.file = path.join(this.dir, 'anti-recall.log');
    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
    this.ring = options.ring || (globalThis.__snowloraAntiRecallLog ??= []);
    this.debugEnabled = options.debug || (() => false);
    fs.mkdirSync(this.dir, { recursive: true });
    this.write('info', 'logger', 'session-start', {
      sessionId: this.sessionId,
      pid: process.pid,
      versions: process.versions,
      logFile: this.file
    });
  }

  levelOf(value) {
    const level = typeof value === 'string' ? value.toLowerCase() : 'info';
    return Object.hasOwn(LEVELS, level) ? level : 'info';
  }

  enabled(level) {
    if (level !== 'debug') return true;
    try { return Boolean(this.debugEnabled()); } catch { return false; }
  }

  write(level, scope, event, data) {
    const normalized = this.levelOf(level);
    const entry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      session: this.sessionId,
      level: normalized,
      scope: String(scope || 'main'),
      event: String(event || 'message'),
      data: data === undefined ? null : safe(data)
    };
    // 内存 ring 全收：导出诊断时立即能看到 debug 级，无需改配置文件。
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    if (!this.enabled(normalized)) return entry;
    let line;
    try { line = JSON.stringify(entry) + '\n'; }
    catch { line = JSON.stringify({ ts: entry.ts, level: 'warn', scope: 'logger', event: 'serialize-failed' }) + '\n'; }
    this._append(line);
    return entry;
  }

  debug(scope, event, data) { return this.write('debug', scope, event, data); }
  info(scope, event, data) { return this.write('info', scope, event, data); }
  warn(scope, event, data) { return this.write('warn', scope, event, data); }
  error(scope, event, data) { return this.write('error', scope, event, data); }

  _append(line) {
    const bytes = Buffer.byteLength(line, 'utf8');
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { /* ENOENT */ }
    if (size + bytes > MAX_FILE_BYTES) this._rotate();
    try { fs.appendFileSync(this.file, line, 'utf8'); }
    catch (error) { console.warn('[Anti-Recall] 日志写入失败：' + error.message); }
  }

  _rotate() {
    const numbered = index => this.file.replace(/\.log$/, '.' + index + '.log');
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = numbered(i);
      const to = numbered(i + 1);
      try {
        if (!fs.existsSync(from)) continue;
        if (fs.existsSync(to)) fs.unlinkSync(to);
        fs.renameSync(from, to);
      } catch { /* 轮转失败不阻断日志 */ }
    }
    try {
      const first = numbered(1);
      if (fs.existsSync(first)) fs.unlinkSync(first);
      if (fs.existsSync(this.file)) fs.renameSync(this.file, first);
    } catch { /* ignore */ }
  }

  files() {
    try {
      return fs.readdirSync(this.dir)
        .filter(name => /^anti-recall(\.\d+)?\.log$/.test(name))
        .sort()
        .map(name => {
          const file = path.join(this.dir, name);
          const stat = fs.statSync(file);
          return { name, file, bytes: stat.size, mtime: stat.mtime.toISOString() };
        });
    } catch { return []; }
  }

  tail(count = 200) { return this.ring.slice(-Math.max(1, Math.min(2000, count))); }

  // 从落盘文件读最后 n 条，重启后也能复核上一次会话。
  readLines(count = 200) {
    const all = [];
    for (const item of this.files()) {
      try {
        const lines = fs.readFileSync(item.file, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try { all.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
        }
      } catch { /* ignore */ }
    }
    return all.slice(-Math.max(1, Math.min(2000, count)));
  }

  format(entries) {
    let lastSession = '';
    return (Array.isArray(entries) ? entries : []).map(entry => {
      const session = String(entry.session || '');
      let prefix = '';
      if (session && session !== lastSession) {
        prefix = '── session ' + session + ' ──\n';
        lastSession = session;
      }
      const time = String(entry.ts || '').slice(11, 23);
      const level = String(entry.level || 'info').toUpperCase().padEnd(5);
      const scope = String(entry.scope || 'main');
      const event = String(entry.event || 'message');
      let data = '';
      try {
        const raw = entry.data;
        if (raw != null) {
          const copy = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : raw;
          if (copy && typeof copy === 'object' && copy.versions) delete copy.versions;
          if (copy && typeof copy === 'object' && copy.logFile) copy.logFile = String(copy.logFile).replace(/^.*[\\/]/, '');
          data = JSON.stringify(copy);
          if (data.length > 320) data = data.slice(0, 320) + '…';
        }
      } catch { data = ''; }
      return prefix + time + ' ' + level + ' ' + scope + '/' + event + (data ? ' | ' + data : '');
    }).join('\n');
  }

  clear() {
    this.ring.length = 0;
    for (const item of this.files()) {
      try { fs.unlinkSync(item.file); } catch { /* ignore */ }
    }
    this.write('info', 'logger', 'logs-cleared', {});
  }
}

function createLogger(dataDir, options) {
  return (globalThis.__snowloraAntiRecallLogger ??= new DebugLogger(dataDir, options));
}

module.exports = { LEVELS, safe, DebugLogger, createLogger };