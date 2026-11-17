'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const LOAD = path.join(root, 'load.js');

const KEYS = [
  '__snowloraAntiRecallWindows', '__snowloraAntiRecallLog', '__snowloraAntiRecallLogger',
  '__snowloraAntiRecallContext', '__snowloraAntiRecallManager'
];
function resetGlobals() { for (const k of KEYS) delete globalThis[k]; delete globalThis.snowlora; }

function withMocks(tmp, fn) {
  const electronMock = {
    app: {
      getPath: () => tmp,
      getVersion: () => '9.9.37-test',
      on: () => {},
      quit: () => {}
    },
    BrowserWindow: { getAllWindows: () => [] },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    shell: { showItemInFolder: async () => {} }
  };
  const origLoad = Module._load;
  const origLog = console.log, origWarn = console.warn, origErr = console.error;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronMock;
    return origLoad.call(this, request, ...rest);
  };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  resetGlobals();
  globalThis.snowlora = { script: LOAD, window: 'deadbeef' };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Module._load = origLoad;
      console.log = origLog; console.warn = origWarn; console.error = origErr;
      resetGlobals();
    });
}

test('saveDb=true 启动不触发 TDZ，store 载入事件落盘', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-startup-'));
  const dataDir = path.join(tmp, 'snowlora', 'qqnt-anti-recall');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    mainColor: '#ff6d6d', saveDb: true, enableShadow: true, enableTip: true,
    isAntiRecallSelfMsg: false, maxMsgSaveLimit: 10000, deleteMsgCountPerTime: 500,
    debugIpc: false, debugLog: false
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'recalled-messages.json'), '{}');

  await withMocks(tmp, async () => {
    const source = fs.readFileSync(LOAD, 'utf8');
    const wrapped = '(async () => {\n' + source + '\n})()';
    // 不抛异常即通过；TDZ 会让这个 Promise reject。
    await vm.runInThisContext(wrapped, { filename: LOAD });
  });

  const logFile = path.join(dataDir, 'logs', 'anti-recall.log');
  assert.equal(fs.existsSync(logFile), true, '未创建日志文件');
  const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const events = entries.map(e => e.scope + '/' + e.event);
  assert.ok(events.includes('logger/session-start'), '缺 session-start');
  assert.ok(events.includes('boot/plugin-load'), '缺 plugin-load');
  assert.ok(events.includes('store/loaded'), 'saveDb=true 时 _load() 未完成（TDZ 复发）');
  assert.equal(entries.some(e => ['error', 'warn'].includes(e.level)), false,
    '启动出现 warn/error: ' + JSON.stringify(entries.filter(e => ['error','warn'].includes(e.level))));
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('saveDb=false 启动同样无异常', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-startup-off-'));
  const dataDir = path.join(tmp, 'snowlora', 'qqnt-anti-recall');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ saveDb: false }));
  await withMocks(tmp, async () => {
    const source = fs.readFileSync(LOAD, 'utf8');
    await vm.runInThisContext('(async () => {\n' + source + '\n})()', { filename: LOAD });
  });
  const entries = fs.readFileSync(path.join(dataDir, 'logs', 'anti-recall.log'), 'utf8')
    .trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.ok(entries.some(e => e.event === 'plugin-load'));
  assert.equal(entries.some(e => ['error','warn'].includes(e.level)), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
