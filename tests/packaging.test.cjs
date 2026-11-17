'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { INCLUDE, pack } = require('../tools/pack.cjs');

test('插件清单符合 SnowLora schema 1 且规则指向 load.js', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'snowlora-plugin.json'), 'utf8'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.minSnowLora, '0.3.0');
  assert.equal(manifest.id, 'qqnt-anti-recall');
  assert.ok(manifest.rules.length >= 1);
  const names = manifest.rules.map(rule => rule.name);
  assert.ok(names.every(name => typeof name === 'string' && name.trim() !== ''), '规则名不能为空');
  assert.equal(new Set(names).size, names.length, '本插件内规则名必须唯一');
  assert.ok(names.every(name => name.startsWith(manifest.id + '-')), '规则名应带插件 id 前缀，避免跨插件撞名');
  const sibling = path.resolve(root, '..', 'snowlora-plugin.json');
  if (fs.existsSync(sibling)) {
    const other = JSON.parse(fs.readFileSync(sibling, 'utf8'));
    const otherNames = (other.rules || []).map(rule => rule.name);
    assert.deepEqual(names.filter(name => otherNames.includes(name)), [], '与同目录插件规则名冲突会让 SnowLora 启动失败');
  }
  for (const rule of manifest.rules) {
    assert.equal(rule.script, 'load.js');
    assert.equal(rule.enabled, true);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {}, 'SnowLora 版零运行时依赖');
});

test('所有打包文件存在且 JS/CJS 语法可解析', () => {
  for (const name of INCLUDE) assert.equal(fs.existsSync(path.join(root, name)), true, '缺少 ' + name);
  // upstream/renderer.js 是故意原样保留的 ESM 上游源，不参与运行时语法检查。
  const syntax = [...INCLUDE.filter(n => /\.(js|cjs)$/.test(n) && n !== 'upstream/renderer.js'),
    'tools/build-renderer.cjs', 'tools/pack.cjs', 'tools/zip.cjs'];
  for (const name of syntax) {
    const file = path.join(root, name);
    const source = fs.readFileSync(file, 'utf8');
    // load.js 由 SnowLora 包成 async 函数体执行：顶层 return / await 合法。
    const wrapped = name === 'load.js' ? '(async () => {\n' + source + '\n})()' : source;
    new vm.Script(wrapped, { filename: file, importModuleDynamically: () => {} });
    assert.ok(!/LiteLoader\.path|require\(["']level-party|contextBridge|ipcRenderer/.test(source), name + ' 残留 LiteLoader API: ');
  }
  const esmSource = fs.readFileSync(path.join(root, 'upstream/renderer.js'), 'utf8');
  assert.match(esmSource, /^export async function onSettingWindowCreated/m, '上游源应原样保留 ESM 形态');
  const upstream = fs.readFileSync(path.join(root, 'renderer/upstream.js'), 'utf8');
  assert.ok(!/^export /m.test(upstream), '生成物不应包含 ESM export');
  assert.ok(upstream.includes('if (!elements) return;'), '缺少空列表保护');
  assert.ok(upstream.includes('window.AntiRecall.onSettingWindowCreated = onSettingWindowCreated;'), '设置函数未挂载');
  assert.ok(fs.existsSync(path.join(root, 'logger.cjs')), '缺少 logger.cjs');
  const resources = fs.readFileSync(path.join(root, 'resources.cjs'), 'utf8');
  assert.ok(resources.includes("'renderer/upstream.js'"), '注入清单漏掉上游渲染逻辑');
  const settings = fs.readFileSync(path.join(root, 'renderer/settings.js'), 'utf8');
  assert.ok(settings.includes('AntiRecall.onSettingWindowCreated'), '设置面板未使用宿主函数');
});

test('load.js 包含多窗口单例、宿主桥与重复注入守卫', () => {
  const load = fs.readFileSync(path.join(root, 'load.js'), 'utf8');
  assert.ok(load.includes('__snowloraAntiRecallManager'), '缺少进程级单例');
  assert.ok(load.includes('snowlora.script') && load.includes('snowlora.window'), '未使用 SnowLora 注入对象');
  assert.ok(load.includes('__snowloraAntiRecallInjected'), '缺少重复注入守卫');
  assert.ok(load.includes("'console-message'"), '缺少宿主桥监听');
  assert.ok(!load.includes('ipcMain.handle'), '残留 LiteLoader IPC');
  assert.ok(load.includes("require('./logger.cjs')"), '未接入结构化日志');
  assert.ok(load.includes("active.write(level, scope, event, data)"), 'output 未走启动期安全日志');
  assert.ok(load.includes('__snowloraAntiRecallLogger'), '未使用全局日志单例');
  assert.ok(!/\bconst logger = ctx\.logger\b/.test(load), '残留 TDZ 引用');
  assert.ok(load.includes('openLogs') && load.includes('readLogs') && load.includes('clearLogs'), '日志宿主方法缺失');
  assert.ok(load.includes("logText: activeLogger()?.format"), '诊断包缺少可读日志');
});

test('打包输出可用 ZIP（EOCD / 中央目录 / 清单内容）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-pack-'));
  const result = pack(dir);
  const buf = fs.readFileSync(result.out);
  assert.equal(result.entries, INCLUDE.length);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, '本地文件头');
  assert.equal(buf.subarray(buf.length - 22, buf.length - 18).readUInt32LE(0), 0x06054b50, 'EOCD');
  assert.equal(buf.readUInt16LE(buf.length - 12), INCLUDE.length, 'EOCD 条目数');
  assert.ok(buf.includes(Buffer.from('snowlora-plugin.json')), 'zip 内缺少清单名');
  fs.rmSync(dir, { recursive: true, force: true });
});