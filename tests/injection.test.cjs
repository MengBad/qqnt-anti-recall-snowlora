'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { loadResources, SCRIPTS, STYLES } = require('../resources.cjs');

function fakeElement(tag) {
  const el = {
    tagName: tag, children: [], style: {}, dataset: {}, classList: {
      add() {}, remove() {}, contains() { return false; }, toggle() {}
    },
    attributes: {},
    appendChild(child) { this.children.push(child); return child; },
    append(...items) { this.children.push(...items); },
    remove() {}, setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    get innerHTML() { return this._html || ''; }, set innerHTML(v) { this._html = v; },
    get textContent() { return this._text || ''; }, set textContent(v) { this._text = v; }
  };
  return el;
}

test('资源清单包含全部运行时脚本与样式', async () => {
  assert.deepEqual(SCRIPTS, [
    'renderer/host.js', 'renderer/upstream.js', 'renderer/overlay.js',
    'renderer/settings.js', 'renderer/settings-page.js'
  ]);
  assert.deepEqual(STYLES, ['assets/anti-recall.css']);
  const res = await loadResources(root);
  assert.ok(res.css.includes('.anti-recall-settings-dialog'), '样式未加载');
  assert.ok(!res.css.includes('#anti-recall-settings-entry'), '右下角按钮 CSS 未删除');
  assert.ok(!res.source.includes("getElementById(ENTRY_ID)"), '右下角按钮挂载代码未删除');
  assert.ok(res.source.includes('window.anti_recall = Object.freeze'), '宿主桥未拼接');
  assert.ok(res.source.includes('window.AntiRecall.onSettingWindowCreated'), '上游设置逻辑未拼接');
  assert.ok(res.source.includes('anti_recall.recallTipList'), '撤回标记逻辑未拼接');
  assert.ok(res.source.includes('flushLogBuffer'), '渲染日志缓冲未拼接');
  assert.ok(res.source.includes('anti-recall-log-view'), '日志面板未拼接');
  assert.ok(res.source.includes('upstream-console'), '上游 console 未接入日志桥');
  assert.ok(res.source.includes('anti-recall-settings-nav'), 'QQ 设置页选项卡未拼接');
  assert.ok(res.source.includes('mountSettingsPage'), '设置页挂载函数未拼接');
});

test('注入脚本串接：宿主桥、上游回调、设置面板、样式均可初始化', async () => {
  const res = await loadResources(root);
  const captured = [];
  const head = fakeElement('head');
  const body = fakeElement('body');
  const doc = {
    readyState: 'complete',
    head, body,
    getElementById: () => null,
    createElement: tag => fakeElement(tag),
    getElementsByTagName: () => ({ item: () => head }),
    evaluate: () => ({ iterateNext: () => null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
  const sandbox = {
    document: doc,
    console: {
      debug: (...a) => captured.push(a.join(' ')),
      log: () => {}, warn: () => {}, error: () => {}
    },
    // 不注册真定时器：patchCss 的 getNowConfig 永远 pending，IIFE 仍会完成。
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    DOMParser: class { parseFromString() { return { querySelector: () => null }; } },
    URL, Blob: class {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: () => {},
    location: { hash: '#/main/message', pathname: '/renderer/index.html', protocol: 'app:' }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const bootstrap = {
    token: '[anti-recall-host:test]',
    config: { mainColor: '#ff6d6d', enableShadow: true, enableTip: true },
    css: res.css,
    info: { plugin: 'qqnt-anti-recall', version: '0.3.0+snowlora.1', versions: {} }
  };
  const script = '(async () => {\nconst bootstrap = ' + JSON.stringify(bootstrap)
    + ';\nif (window.__snowloraAntiRecallInjected) {\n'
    + '  window.AntiRecall.setToken(bootstrap.token);\n'
    + '  window.AntiRecall.applyConfig(bootstrap.config, bootstrap.css);\n'
    + '  return;\n}\n'
    + 'window.__snowloraAntiRecallInjected = true;\n'
    + res.source + '\nwindow.AntiRecall.flushLogBuffer && window.AntiRecall.flushLogBuffer();\n'
    + 'await window.AntiRecall.ready;\n})()';

  const running = vm.runInContext(script, sandbox, { filename: 'injected.js' });
  await Promise.race([running, new Promise(resolve => setImmediate(resolve))]);

  assert.ok(sandbox.window.AntiRecall, 'AntiRecall 宿主未挂载');
  assert.ok(sandbox.window.anti_recall, 'anti_recall 兼容面未挂载');
  assert.equal(typeof sandbox.window.AntiRecall.onSettingWindowCreated, 'function', '上游设置函数未挂载');
  assert.equal(sandbox.window.__snowloraAntiRecallInjected, true);
  assert.ok(captured.some(m => m.startsWith(bootstrap.token) && m.includes('getNowConfig')),
    'patchCss 未通过宿主桥请求配置');
  assert.equal(typeof sandbox.window.AntiRecall.log, 'function', '渲染日志函数未挂载');
  sandbox.window.AntiRecall.log('warn', 'test-event', { probe: true });
  assert.ok(captured.some(m => m.includes('\"event\":\"test-event\"')), '渲染日志未走宿主桥');
  assert.ok(head.children.some(el => el.id === 'anti-recall-base-css'), '基础样式未注入');
  assert.equal(body.children.some(el => el.id === 'anti-recall-settings-entry'), false,
    '右下角悬浮入口应已删除');
  assert.ok(res.source.includes('anti-recall-open-settings'), '仍应保留事件/快捷键入口');
  assert.equal(typeof sandbox.window.AntiRecall.buildLogPanel, 'function', '日志面板未暴露给设置页');
  assert.equal(typeof sandbox.window.AntiRecall.mountSettingsPage, 'function', '设置页挂载未暴露');

  // 模拟主进程回包，验证 request/reply 闭环。
  const req = JSON.parse(captured.find(m => m.includes('getNowConfig')).slice(bootstrap.token.length));
  sandbox.window.AntiRecall.reply(req.id, bootstrap.config, null);

  // 事件分发到上游 renderer.js 注册的回调。
  assert.equal(sandbox.window.AntiRecall.dispatch('recallTip', 'msg-1'), 1);
  assert.equal(sandbox.window.AntiRecall.dispatch('recallTipList', ['msg-1']), 1);
  assert.equal(sandbox.window.AntiRecall.dispatch('repatchCss', bootstrap.config), 1);
});

test('重复执行只刷新 token/配置，不重复注册回调', async () => {
  const res = await loadResources(root);
  const captured = [];
  const head = fakeElement('head');
  const body = fakeElement('body');
  const doc = {
    readyState: 'complete', head, body,
    getElementById: id => (id === 'anti-recall-base-css' ? head.children[0] : null),
    createElement: tag => fakeElement(tag),
    getElementsByTagName: () => ({ item: () => head }),
    evaluate: () => ({ iterateNext: () => null }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}
  };
  const sandbox = {
    document: doc,
    console: { debug: (...a) => captured.push(a.join(' ')), log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    MutationObserver: class { observe() {} },
    DOMParser: class { parseFromString() { return { querySelector: () => null }; } },
    URL, addEventListener: () => {},
    location: { hash: '#/main/message', pathname: '/renderer/index.html', protocol: 'app:' }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const makeBootstrap = token => ({
    token, config: { mainColor: '#112233', enableShadow: false, enableTip: false },
    css: res.css, info: {}
  });
  const mk = token => '(async () => {\nconst bootstrap = ' + JSON.stringify(makeBootstrap(token))
    + ';\nif (window.__snowloraAntiRecallInjected) {\n'
    + '  window.AntiRecall.setToken(bootstrap.token);\n'
    + '  window.AntiRecall.applyConfig(bootstrap.config, bootstrap.css);\n'
    + '  return;\n}\nwindow.__snowloraAntiRecallInjected = true;\n'
    + res.source + '\nwindow.AntiRecall.flushLogBuffer && window.AntiRecall.flushLogBuffer();\n'
    + 'await window.AntiRecall.ready;\n})()';
  await Promise.race([vm.runInContext(mk('[token-a]'), sandbox), new Promise(r => setImmediate(r))]);
  const before = captured.length;
  assert.equal(sandbox.window.AntiRecall.dispatch('recallTip', 'x'), 1);
  await Promise.race([vm.runInContext(mk('[token-b]'), sandbox), new Promise(r => setImmediate(r))]);
  assert.equal(sandbox.window.AntiRecall.dispatch('recallTip', 'y'), 1, '回调不应重复注册');
  assert.equal(sandbox.window.AntiRecall.config.mainColor, '#112233');
  // 首次执行：patchCss 发 1 次；重复执行：applyConfig 触发 repatchCss，patchCss 再发 1 次。
// 重复执行只走守卫分支：setToken + applyConfig -> repatchCss -> patchCss。
  // 因此新增请求是宿主方法调用，不含重新注册 observer / 重新 onLoad 的痕迹。
  const extra = captured.slice(before).filter(m => m.startsWith('[token-b]'));
  assert.ok(extra.length >= 1 && extra.length <= 3, '重复执行只应产生少量 repatchCss 派生请求');
  assert.ok(captured.slice(before).every(m => m.startsWith('[token-b]')), 'token 未刷新');
  assert.equal(sandbox.window.AntiRecall.config.mainColor, '#112233');
});