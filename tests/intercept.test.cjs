'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecallInterceptor, revokeOf, isChatUrl } = require('../recall-intercept.cjs');
const { createConfig } = require('../config.cjs');
const { RecalledStore } = require('../store.cjs');

function fixture(overrides = {}, reuseDir = null) {
  const dir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ar-intercept-'));
  const config = createConfig(dir);
  if (Object.keys(overrides).length) config.save(overrides);
  const store = new RecalledStore(dir, () => {});
  const events = [];
  const logs = [];
  const imgs = [];
  const interceptor = new RecallInterceptor({
    config, store,
    imgDownloader: { downloadPic: async m => imgs.push(m && m.msgId) },
    notify: (_w, event, payload) => events.push({ event, payload }),
    output: (...a) => logs.push(a.map(String).join(' '))
  });
  const sent = [];
  const wc = {
    id: 1,
    send: (channel, ...args) => sent.push({ channel, args }),
    on: () => {},
    once: () => {},
    isLoadingMainFrame: () => false,
    isDestroyed: () => false,
    getURL: () => 'app://./renderer/index.html#/main/message',
    mainFrame: {}
  };
  const win = { webContents: wc, isDestroyed: () => false };
  interceptor.install(win);
  return { dir, config, store, events, logs, imgs, interceptor, sent, wc, win };
}

function revokeTip(id, peerUid = 'peer', isSelfOperate = false) {
  return {
    msgId: id, peerUid, msgType: 5, subMsgType: 4, msgSeq: '999', sendStatus: 2,
    elements: [{ grayTipElement: { revokeElement: { isSelfOperate } } }]
  };
}

function original(id, peerUid = 'peer') {
  return {
    msgId: id, peerUid, msgType: 2, subMsgType: 1, msgSeq: '1',
    elements: [{ textElement: { content: 'original-' + id } }],
    msgAttrs: { 1: 'a' }, sendStatus: 2
  };
}

test('选择器与撤回提示识别', () => {
  assert.equal(isChatUrl('app://./renderer/index.html#/main/message'), true);
  assert.equal(isChatUrl('app://./renderer/index.html#/chat?x=1'), true);
  assert.equal(isChatUrl('app://./renderer/hiddenWindow.html'), false);
  assert.equal(isChatUrl('about:blank'), false);
  assert.notEqual(revokeOf(revokeTip('m1')), null);
  assert.equal(revokeOf(original('m1')), null);
});

test('接收消息 → 撤回增量 IPC 被拦截 → 全量列表还原', async () => {
  const f = fixture();
  const msg = original('m1');
  await f.wc.send('ch', {}, { cmdName: 'nodeIKernelMsgListener/onRecvMsg', payload: { msgList: [msg] } });
  assert.equal(f.interceptor.msgFlow.length, 1);

  const update = { cmdName: 'nodeIKernelMsgListener/onMsgInfoListUpdate', payload: { msgList: [revokeTip('m1')] } };
  await f.wc.send('ch', {}, update);
  assert.equal(update.cmdName, 'none');
  assert.equal(update.payload.msgList.length, 0);
  assert.ok(f.events.some(e => e.event === 'recallTip' && e.payload === 'm1'));
  assert.ok(f.imgs.includes('m1'));

  const full = { msgList: [JSON.parse(JSON.stringify(revokeTip('m1')))] };
  await f.wc.send('ch', {}, full);
  const restored = full.msgList[0];
  assert.equal(restored.msgType, 2);
  assert.equal(restored.elements[0].textElement.content, 'original-m1');
  assert.equal(restored.msgSeq, '999', '撤回提示的序列字段保留');
  assert.equal(restored.sendStatus, 2, '撤回提示的发送状态保留');
  assert.equal(restored.isOnlineMsg, true);
  assert.equal(restored.msgAttrs['1'], 'a');
  assert.ok(f.events.some(e => e.event === 'recallTipList' && e.payload.includes('m1')));
  assert.equal(f.sent.length, 3, '原始 send 每次都继续调用');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('自己撤回默认放行，开启后拦截', async () => {
  const f = fixture();
  await f.wc.send('ch', {}, { cmdName: 'onRecvMsg', payload: { msgList: [original('m2', 'self')] } });
  const selfUpdate = { cmdName: 'onMsgInfoListUpdate', payload: { msgList: [revokeTip('m2', 'self', true)] } };
  await f.wc.send('ch', {}, selfUpdate);
  assert.notEqual(selfUpdate.cmdName, 'none');
  f.config.save({ isAntiRecallSelfMsg: true });
  const selfUpdate2 = { cmdName: 'onMsgInfoListUpdate', payload: { msgList: [revokeTip('m2', 'self', true)] } };
  await f.wc.send('ch', {}, selfUpdate2);
  assert.equal(selfUpdate2.cmdName, 'none');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('开启 saveDb 后重启可从 store 还原', async () => {
  const f = fixture({ saveDb: true });
  await f.wc.send('ch', {}, { cmdName: 'onRecvMsg', payload: { msgList: [original('m3')] } });
  await f.wc.send('ch', {}, { cmdName: 'onMsgInfoListUpdate', payload: { msgList: [revokeTip('m3')] } });
  assert.equal(f.store.get('m3').msg.msgId, 'm3');

  const g = fixture({}, f.dir);
  assert.equal(g.config.get().saveDb, true, '重启后配置应保留');
  const full = { msgList: [JSON.parse(JSON.stringify(revokeTip('m3')))] };
  await g.wc.send('ch', {}, full);
  assert.equal(full.msgList[0].elements[0].textElement.content, 'original-m3');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('关闭 saveDb 时不读取旧记录', async () => {
  const f = fixture({ saveDb: false });
  f.store.put({ id: 'm4', sender: 'peer', msg: original('m4') });
  f.store.flush();
  const full = { msgList: [JSON.parse(JSON.stringify(revokeTip('m4')))] };
  await f.wc.send('ch', {}, full);
  assert.equal(full.msgList[0].msgType, 5, '保持撤回提示');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('缓存上限按配置淘汰', async () => {
  const f = fixture({ maxMsgSaveLimit: 3, deleteMsgCountPerTime: 2 });
  await f.wc.send('ch', {}, { cmdName: 'onRecvMsg', payload: { msgList: [original('a'), original('b'), original('c'), original('d')] } });
  assert.deepEqual(f.interceptor.msgFlow.map(i => i.id), ['c', 'd']);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('重复 install 不重复挂 did-stop-loading', () => {
  const f = fixture();
  let count = 0;
  const wc = { on: () => count++, once: () => {}, isLoadingMainFrame: () => true, isDestroyed: () => false, getURL: () => '', send: () => {} };
  const win = { webContents: wc, isDestroyed: () => false };
  const { RecallInterceptor: RI } = require('../recall-intercept.cjs');
  const other = new RI({ config: f.config, store: f.store, imgDownloader: { downloadPic: async () => {} }, notify: () => {}, output: () => {} });
  other.install(win);
  other.install(win);
  assert.equal(count, 2, 'did-stop-loading + did-navigate-in-page，且只挂一次');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('池窗口 in-page 路由切到聊天页后补挂 send 拦截', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-nav-'));
  const config = createConfig(dir);
  const store = new RecalledStore(dir, () => {});
  const events = [];
  const { RecallInterceptor: RI } = require('../recall-intercept.cjs');
  const interceptor = new RI({
    config, store,
    imgDownloader: { downloadPic: async () => {} },
    notify: (_w, event, payload) => events.push({ event, payload }),
    output: () => {}
  });
  const handlers = {};
  let url = 'app://./renderer/index.html#/blank';
  const sent = [];
  const wc = {
    id: 7,
    send: (channel, ...args) => sent.push({ channel, args }),
    on: (event, fn) => { (handlers[event] ??= []).push(fn); },
    once: () => {},
    isLoadingMainFrame: () => false,
    isDestroyed: () => false,
    getURL: () => url,
    mainFrame: {}
  };
  const win = { webContents: wc, isDestroyed: () => false };
  interceptor.install(win);
  assert.equal(typeof handlers['did-stop-loading'], 'object');
  assert.equal(typeof handlers['did-navigate-in-page'], 'object');
  assert.equal(wc.send.toString().includes('originalSend'), false, '#/blank 阶段不应 patch');

  url = 'app://./renderer/index.html#/main/message';
  for (const fn of handlers['did-navigate-in-page']) fn({}, url, true);
  assert.ok(interceptor.patched.has(wc), 'in-page 导航后应完成 patch');

  const msg = original('nav1');
  await wc.send('ch', {}, { cmdName: 'onRecvMsg', payload: { msgList: [msg] } });
  assert.equal(interceptor.msgFlow.length, 1);
  const update = { cmdName: 'onMsgInfoListUpdate', payload: { msgList: [revokeTip('nav1')] } };
  await wc.send('ch', {}, update);
  assert.equal(update.cmdName, 'none');
  fs.rmSync(dir, { recursive: true, force: true });
});
