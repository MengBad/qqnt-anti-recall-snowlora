'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecalledStore } = require('../store.cjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-store-'));
  return { dir, store: new RecalledStore(dir, () => {}) };
}

test('put 去重、get 命中、跨实例持久化', () => {
  const { dir, store } = fixture();
  store.setEnabled(true);
  assert.equal(store.put({ id: 'm1', sender: 'u1', msg: { msgId: 'm1' } }), true);
  assert.equal(store.put({ id: 'm1', sender: 'u1', msg: { msgId: 'm1' } }), false);
  assert.equal(store.get('m1').msg.msgId, 'm1');
  assert.equal(store.get('missing'), null);
  const second = new RecalledStore(dir, () => {});
  assert.equal(second.get('m1').sender, 'u1');
  assert.equal(second.size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clear 清空内存与磁盘', () => {
  const { dir, store } = fixture();
  store.setEnabled(true);
  store.put({ id: 'm1', msg: { msgId: 'm1' } });
  store.clear();
  assert.equal(store.size, 0);
  assert.deepEqual(store.ids(), []);
  const second = new RecalledStore(dir, () => {});
  assert.equal(second.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('关闭 saveDb 后旧记录仍可读，新记录不落盘', () => {
  const { dir, store } = fixture();
  store.setEnabled(true);
  store.put({ id: 'old', msg: { msgId: 'old' } });
  store.setEnabled(false);
  store.put({ id: 'fresh', msg: { msgId: 'fresh' } });
  const second = new RecalledStore(dir, () => {});
  assert.equal(second.get('old').id, 'old', '已落盘记录不因关闭开关删除');
  assert.equal(second.get('fresh'), null, '关闭后不再新增持久化记录');
  assert.equal(store.get('fresh').id, 'fresh', '本次进程内存仍可恢复');
  fs.rmSync(dir, { recursive: true, force: true });
});