'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, normalize, createConfig } = require('../config.cjs');

test('默认值与非法输入收敛', () => {
  assert.equal(DEFAULTS.saveDb, false);
  assert.equal(normalize(null).mainColor, '#ff6d6d');
  assert.equal(normalize({ mainColor: 'javascript:alert(1)' }).mainColor, '#ff6d6d');
  assert.equal(normalize({ mainColor: '#AABBCC' }).mainColor, '#aabbcc');
  assert.equal(normalize({ maxMsgSaveLimit: 999999999999 }).maxMsgSaveLimit, 99999999);
  assert.equal(normalize({ deleteMsgCountPerTime: 0 }).deleteMsgCountPerTime, 1);
  assert.equal(normalize({ saveDb: 'yes' }).saveDb, false);
  assert.equal(DEFAULTS.debugLog, false);
  assert.equal(normalize({ debugLog: true }).debugLog, true);
  assert.equal(normalize({ debugIpc: 1 }).debugIpc, false);
});

test('配置落盘、重载、save 合并与原子写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-config-'));
  const cfg = createConfig(dir);
  assert.deepEqual(cfg.get(), DEFAULTS);
  assert.equal(fs.existsSync(cfg.file), true);
  const next = cfg.save({ mainColor: '#123456', maxMsgSaveLimit: 42 });
  assert.equal(next.mainColor, '#123456');
  assert.equal(next.maxMsgSaveLimit, 42);
  assert.equal(next.enableTip, true);
  const reloaded = createConfig(dir);
  assert.equal(reloaded.get().mainColor, '#123456');
  assert.equal(reloaded.get().maxMsgSaveLimit, 42);
  assert.equal(fs.existsSync(cfg.file + '.tmp'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});