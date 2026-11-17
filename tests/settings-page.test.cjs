'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function node(tag, text) {
  const el = {
    tagName: tag, children: [], childNodes: [], style: {}, dataset: {}, attributes: {},
    nodeType: 1, isConnected: true, _text: text || '',
    classList: {
      _set: new Set(),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      contains(c) { return this._set.has(c); },
      toggle(c) { if (this._set.has(c)) { this._set.delete(c); return false; } this._set.add(c); return true; }
    },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    append(...items) { items.forEach(i => this.appendChild(i)); },
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(type, fn, capture) { (this._listeners ??= []).push({ type, fn, capture }); },
    querySelector(sel) { return find(this, sel); },
    querySelectorAll(sel) { return findAll(this, sel); },
    cloneNode() {
      const copy = node(this.tagName, this._text);
      Object.defineProperty(copy, 'className', { value: this.className || '', writable: true });
      for (const c of this.classList._set) copy.classList.add(c);
      for (const c of this.children) copy.appendChild(c.cloneNode(true));
      return copy;
    },
    closest(sel) { return matches(this, sel) ? this : null; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    get innerHTML() { return ''; },
    set innerHTML(v) { this.children.length = 0; this.childNodes.length = 0; },
    get nodeValue() { return this._text; },
    set nodeValue(v) { this._text = v; }
  };
  return el;
}
function matches(el, sel) {
  const cls = sel.replace(/^\./, '');
  return (el.className || '') === cls || (el.classList && el.classList._set.has(cls));
}
function className(el) {
  return [...(el.classList ? el.classList._set : [])].join(' ');
}
function find(el, sel) { return findAll(el, sel)[0] || null; }
function findAll(el, sel) {
  const cls = sel.replace(/^\./, '');
  const out = [];
  const walk = n => {
    for (const c of n.children) {
      if ((c.classList && c.classList._set.has(cls)) || c.className === cls) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

test('QQ 设置页（#/setting）挂出「防撤回」导航项并渲染内容', async () => {
  const src = fs.readFileSync(path.join(root, 'renderer', 'settings-page.js'), 'utf8');
  const tab = node('div'); tab.className = 'setting-tab';
  const navBar = node('div'); navBar.className = 'nav-bar';
  const sample = node('div'); sample.className = 'nav-item';
  const nameNode = node('span'); nameNode.className = 'name'; nameNode.textContent = '通用';
  sample.appendChild(nameNode);
  navBar.appendChild(sample); tab.appendChild(navBar);
  const main = node('div');
  const original = node('div'); original.className = 'q-scroll-view';
  const title = node('div'); title.className = 'setting-title';
  const textNode = Object.assign(node('#text'), { nodeType: 3, nodeValue: ' 通用', isConnected: true });
  title.childNodes.push(textNode);
  const settingLayout = node('div');
  settingLayout.appendChild(tab); settingLayout.appendChild(main);
  settingLayout.appendChild(original); settingLayout.appendChild(title);

  const doc = {
    readyState: 'complete',
    body: node('body'),
    querySelector(sel) {
      if (sel === '.setting-tab') return tab;
      if (sel === '.setting-main .setting-main__content') return main;
      if (sel === '.setting-main .q-scroll-view') return original;
      if (sel === '.setting-main .setting-title') return title;
      return null;
    },
    createElement: tag => node(tag),
    addEventListener() {}
  };
  const logs = [];
  let built = 0, logPanel = 0;
  const sandbox = {
    location: { hash: '#/setting/settings/common' },
    document: doc,
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout: fn => { fn(); return 1; },
    clearTimeout() {},
    requestAnimationFrame: fn => { fn(); return 1; },
    addEventListener() {},
    URL,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.AntiRecall = {
    log: (level, event, data) => logs.push({ level, event, data }),
    onSettingWindowCreated: async view => { built++; view.appendChild(node('div')); },
    buildLogPanel: async view => { logPanel++; view.appendChild(node('div')); }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'settings-page.js' });

  const VIEW_CLASS_FROM_SOURCE = 'anti-recall-settings-page';
  const navs = findAll(tab, 'anti-recall-settings-nav');
  assert.equal(navs.length, 1, '未克隆出防撤回导航项');
  assert.equal(navs[0].querySelector('.name').textContent, '防撤回');
  assert.ok(logs.some(l => l.event === 'settings-page-script-loaded'), '未记录脚本加载');
  assert.ok(logs.some(l => l.event === 'settings-page-mounted'), '未记录挂载日志');

  const click = navs[0]._listeners.find(l => l.type === 'click');
  assert.ok(click);
  await click.fn();
  assert.equal(built, 1, '未调用上游设置构建');
  assert.equal(logPanel, 1, '未追加日志面板');
  assert.equal(original.style.display, 'none', '未隐藏原生设置内容');
  assert.equal(navs[0].classList.contains('nav-item-active'), true, '未高亮');
  assert.equal(textNode.nodeValue, ' 防撤回', '标题未切换');
  assert.ok(logs.some(l => l.event === 'settings-page-rendered'), '未记录渲染日志');

  // 点击原生导航项：捕获监听还原
  const capture = tab._listeners.find(l => l.type === 'click' && l.capture);
  assert.ok(capture, '缺少捕获阶段的还原监听');
  capture.fn({ target: sample });
  // 生产代码用 view.className = 'anti-recall-settings-page q-scroll-view ...'。
  // 测试桩的 className 是普通属性，按字符串前缀判定即可。
  const viewNode = main.children.find(c => String(c.className || '').includes('anti-recall-settings-page'));
  assert.ok(viewNode, '未创建内嵌设置视图，children=' + main.children.map(c => c.className).join(','));
  assert.equal(viewNode.style.display, 'none');
  assert.equal(original.style.display, 'block');
  assert.equal(textNode.nodeValue, ' 通用', '标题未还原');
});

test('非 #/setting 路由不挂选项卡，hashchange 后才重试', () => {
  const src = fs.readFileSync(path.join(root, 'renderer', 'settings-page.js'), 'utf8');
  const sandbox = {
    location: { hash: '#/main/message' },
    document: { readyState: 'complete', addEventListener() {}, querySelector: () => null },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1,
    addEventListener(type, fn) { (this._ev ??= []).push({ type, fn }); },
  };
  sandbox.window = sandbox;
  sandbox.window.AntiRecall = { log() {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.equal(typeof sandbox.window.AntiRecall.mountSettingsPage, 'function');
  assert.ok((sandbox._ev || []).some(e => e.type === 'hashchange'), '缺少 hashchange 重试');
});