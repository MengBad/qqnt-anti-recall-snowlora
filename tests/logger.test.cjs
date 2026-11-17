'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LEVELS, safe, DebugLogger } = require('../logger.cjs');

function fixture(debug = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-logger-'));
  const ring = [];
  const logger = new DebugLogger(dir, { ring, debug: () => debug });
  return { dir, ring, logger };
}

function readLines(logger) {
  const file = logger.file;
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
}

test('级别常量、safe 序列化脱敏深度与 Error 展开', () => {
  assert.equal(LEVELS.debug, 10);
  assert.equal(LEVELS.error, 40);
  const err = new Error('boom');
  const out = safe({ err, deep: { a: { b: { c: { d: 1 } } } }, text: 'x'.repeat(1200) });
  assert.equal(out.err.message, 'boom');
  assert.ok(out.err.stack.includes('boom') || typeof out.err.stack === 'string');
  assert.ok(out.text.endsWith('…[1200]'));
  assert.equal(out.deep.a.b, '[depth-limit]');
  assert.equal(safe(Buffer.from('abc')), '[Buffer 3]');
  const circular = {}; circular.self = circular;
  assert.doesNotThrow(() => safe(circular));
});

test('info/warn/error 始终落盘，debug 受开关控制；ring 始终全收', () => {
  const { dir, ring, logger } = fixture(false);
  logger.info('boot', 'start', { plugin: 'qqnt-anti-recall' });
  logger.debug('ipc', 'send', { cmdName: 'onRecvMsg' });
  logger.warn('host', 'timeout', { method: 'getNowConfig' });
  logger.error('intercept', 'exception', { error: 'stack' });
  const lines = readLines(logger);
  const events = lines.map(l => l.event);
  assert.ok(events.includes('session-start'));
  assert.ok(events.includes('start'));
  assert.ok(events.includes('timeout'));
  assert.ok(events.includes('exception'));
  assert.equal(events.includes('send'), false, 'debug 关闭时不应写盘');
  assert.equal(ring.some(e => e.event === 'send' && e.level === 'debug'), true, 'ring 仍保留 debug');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('开启 debug 后 debug 写盘，且结构化字段完整', () => {
  const { dir, logger } = fixture(true);
  logger.debug('intercept', 'patched', { url: 'app://./renderer/index.html#/main/message' });
  const lines = readLines(logger);
  const target = lines.find(l => l.event === 'patched');
  assert.ok(target);
  assert.equal(target.level, 'debug');
  assert.equal(target.scope, 'intercept');
  assert.equal(target.data.url, 'app://./renderer/index.html#/main/message');
  assert.ok(target.ts && target.session && target.pid);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readLines 跨文件读取 + format 可读文本 + tail 截断', () => {
  const { dir, logger } = fixture(true);
  for (let i = 0; i < 5; i++) logger.info('test', 'event-' + i, { i });
  const disk = logger.readLines(3);
  assert.deepEqual(disk.map(e => e.event), ['event-2', 'event-3', 'event-4']);
  const text = logger.format(disk);
  assert.ok(text.includes('INFO  test/event-2'));
  assert.ok(text.includes('"i":2'));
  assert.equal(logger.tail(2).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('2MB 触发轮转，最多保留 3 个历史文件', () => {
  const { dir, logger } = fixture(true);
  // 业务字段会被 clip 截到 1000 字符，这里直接经 _append 构造大行验证轮转机制本身。
  const big = 'x'.repeat(900 * 1024);
  for (let i = 0; i < 5; i++) logger._append(big + '\n');
  const files = logger.files();
  assert.ok(files.length >= 2, '应产生轮转文件');
  assert.ok(files.length <= 4, '主文件 + 最多 3 个历史文件');
  assert.ok(files.some(f => /anti-recall\.1\.log/.test(f.name)), '缺少 .1.log');
  assert.ok(logger.readLines(2000).length > 0, '轮转后仍可读到历史日志');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('clear 清空内存 ring 与磁盘日志文件', () => {
  const { dir, ring, logger } = fixture(true);
  logger.info('test', 'before-clear', {});
  logger.clear();
  assert.ok(ring.some(e => e.event === 'logs-cleared'));
  assert.equal(ring.some(e => e.event === 'before-clear'), false);
  const remaining = logger.files();
  assert.equal(remaining.length, 1, 'clear 后只保留新写的 session');
  assert.ok(readLines(logger).some(l => l.event === 'logs-cleared'));
  fs.rmSync(dir, { recursive: true, force: true });
});