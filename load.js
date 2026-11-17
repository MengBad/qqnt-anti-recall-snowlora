const require = process.getBuiltinModule('module').createRequire(snowlora.script);
const path = require('node:path');
const fsSync = require('node:fs');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, dialog } = require('electron');

const root = path.dirname(snowlora.script);
const PLUGIN_ID = 'qqnt-anti-recall';
const VERSION = '0.3.0+snowlora.8';

const { createConfig } = require('./config.cjs');
const { createLogger } = require('./logger.cjs');
const { RecalledStore } = require('./store.cjs');
const { RkeyManager } = require('./rkey-manager.cjs');
const { ImgDownloader } = require('./img-downloader.cjs');
const { RecallInterceptor } = require('./recall-intercept.cjs');
const { loadResources } = require('./resources.cjs');

// 与琉璃主题相同：SnowLora 按 HWND 多次执行本文件，状态必须跨执行存活。
const windows = (globalThis.__snowloraAntiRecallWindows ??= new Map());
const dataDir = path.join(app.getPath('userData'), 'snowlora', PLUGIN_ID);

function stringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

// 兼容旧调用：output('文字', errorObject, ...)。第一个参数若是
// [level][scope] 或直接给 level，则走结构化；否则按 info 记录。
function activeLogger() {
  // ctx/logger 是 const，在 ctx 的 IIFE 执行期间处于 TDZ；store._load() 会
  // 在这个阶段回调 output()，因此启动期一律从全局单例取，不碰 ctx。
  return globalThis.__snowloraAntiRecallLogger || null;
}

function redactArgument(method, argument) {
  // 宿主请求体只记录形状与开关值，不记录消息正文 / 图片路径。
  if (method === 'saveConfig') {
    const cfg = globalThis.__snowloraAntiRecallContext && globalThis.__snowloraAntiRecallContext.config;
    return argument && typeof argument === 'object'
      ? { keys: Object.keys(argument), config: redactConfig(cfg ? cfg.normalize(argument) : argument) } : null;
  }
  if (method === 'log') return '[renderer-log]';
  if (argument === undefined) return null;
  try { return String(argument).slice(0, 200); } catch { return '[unserializable]'; }
}

function output(...args) {
  const first = args[0];
  let level = 'info';
  let scope = 'main';
  let event = 'message';
  let data = args;
  if (typeof first === 'string' && /^\[(debug|info|warn|error)\](?:\[([^\]]+)\])?\s*(.*)$/i.test(first)) {
    const match = first.match(/^\[(debug|info|warn|error)\](?:\[([^\]]+)\])?\s*(.*)$/i);
    level = match[1].toLowerCase();
    scope = match[2] || 'main';
    event = match[3] || 'message';
    data = args.slice(1);
  } else if (first && typeof first === 'object' && first.level) {
    level = first.level;
    scope = first.scope || 'main';
    event = first.event || 'message';
    data = [first.data];
  }
  if (data.length === 1) data = data[0];
  if (data === null || data === undefined) data = null;
  const active = activeLogger();
  if (active) active.write(level, scope, event, data);
  // QQ 以 GUI 子系统启动时看不到终端，仍保留 console 便于 hook 启动观察。
  console.log('\x1b[32m%s\x1b[0m', 'Anti-Recall:',
    '[' + level + ']', scope + '/' + event, stringify(data));
}

function sendEvent(state, data) {
  const wc = state.wc;
  try { if (wc.isDestroyed()) return; } catch { return; }
  const script = 'window.AntiRecall && window.AntiRecall.dispatch('
    + JSON.stringify(data.event) + ', ' + JSON.stringify(data.payload) + ')';
  wc.executeJavaScript(script).catch(() => {});
}

function notify(window, event, payload) {
  let wc;
  try { wc = window && window.webContents; } catch { return; }
  if (!wc) return;
  try { if (wc.isDestroyed()) return; } catch { return; }
  const state = windows.get(wc.id);
  const data = { event, payload };
  if (!state || !state.applied) {
    if (state) {
      state.pending.push(data);
      if (state.pending.length > 200) state.pending.shift();
    }
    return;
  }
  sendEvent(state, data);
}

function notifyAll(event, payload) {
  for (const state of windows.values()) if (state.applied) sendEvent(state, { event, payload });
}

const methods = {
  getNowConfig: () => {
    activeLogger()?.debug('host', 'config-read', { source: 'renderer' });
    return ctx.config.get();
  },
  saveConfig: (arg) => {
    const before = ctx.config.get();
    const next = ctx.config.save(arg);
    ctx.store.setEnabled(next.saveDb);
    notifyAll('repatchCss', next);
    activeLogger()?.info('host', 'config-saved', { changed: changedKeys(before, next), config: redactConfig(next) });
    return next;
  },
  clearDb: async () => {
    const answer = await dialog.showMessageBox({
      type: 'warning',
      title: '清空已储存的撤回消息',
      message: '清空后不可恢复，是否确认清空？',
      buttons: ['确定', '取消'],
      cancelId: 1
    });
    if (answer.response !== 0) return false;
    const removed = ctx.store.size;
    ctx.store.clear();
    ctx.interceptor.recalledMsg.length = 0;
    activeLogger()?.info('host', 'store-cleared', { removed });
    notifyAll('recallTipList', []);
    await dialog.showMessageBox({
      type: 'info', title: '提示',
      message: '清空完毕，之前保存的已撤回消息均被删除，重启 QQ 后生效。',
      buttons: ['确定']
    });
    return true;
  },
  log: (entry) => {
    const level = entry && typeof entry.level === 'string' ? entry.level : 'info';
    const scope = entry && typeof entry.scope === 'string' ? entry.scope : 'renderer';
    const event = entry && typeof entry.event === 'string' ? entry.event : 'message';
    activeLogger()?.write(level, scope, event, entry && Object.hasOwn(entry, 'data') ? entry.data : entry);
    return true;
  },
  openLogs: async () => {
    const { shell } = require('electron');
    const items = activeLogger()?.files();
    const active = activeLogger();
    const target = items.length ? items[items.length - 1].file : (active && active.file);
    try {
      fsSync.mkdirSync(path.dirname(target), { recursive: true });
      if (!fsSync.existsSync(target)) fsSync.writeFileSync(target, '', 'utf8');
      await shell.showItemInFolder(target);
      return { ok: true, file: target };
    } catch (error) {
      activeLogger()?.warn('host', 'open-logs-failed', { error: error.message });
      return { ok: false, file: target, error: error.message };
    }
  },
  clearLogs: () => { activeLogger()?.clear(); return true; },
  readLogs: (arg) => {
    const count = arg && Number.isFinite(arg.count) ? arg.count : 200;
    const ring = activeLogger()?.tail(count);
    const disk = activeLogger()?.readLines(count);
    return { ring, disk, files: activeLogger()?.files(), text: activeLogger()?.format(ring), diskText: activeLogger()?.format(disk) };
  },
  exportDiag: () => ({
    plugin: PLUGIN_ID,
    version: VERSION,
    dataDir,
    qqnt: app.getVersion(),
    versions: { ...process.versions },
    config: ctx.config.get(),
    records: ctx.store.size,
    cached: ctx.interceptor.recalledMsg.length,
    flow: ctx.interceptor.msgFlow.length,
    windows: windows.size,
    logEnabled: ctx.config.get().debugLog,
    debugIpc: ctx.config.get().debugIpc,
    logFiles: activeLogger()?.files(),
    log: activeLogger()?.tail(200),
    diskLog: activeLogger()?.readLines(200),
    logText: activeLogger()?.format(activeLogger()?.tail(200))
  })
};

function changedKeys(before, after) {
  return Object.keys(after).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
function redactConfig(config) {
  const { ...rest } = config;
  return rest; // 配置不含消息内容，可直接记录
}

const ctx = (globalThis.__snowloraAntiRecallContext ??= (() => {
  const config = createConfig(dataDir);
  createLogger(dataDir, { debug: () => config.get().debugLog });
  activeLogger()?.info('boot', 'plugin-load', {
    plugin: PLUGIN_ID, version: VERSION, qqnt: app.getVersion(), dataDir,
    config: redactConfig(config.get()), platform: process.platform, arch: process.arch
  });
  const store = new RecalledStore(dataDir, output);
  store.setEnabled(config.get().saveDb);
  const imgDownloader = new ImgDownloader({
    rkeyManager: new RkeyManager('https://llob.linyuchen.net/rkey'),
    output
  });
  const interceptor = new RecallInterceptor({ config, store, imgDownloader, notify, output });
  return { config, store, imgDownloader, interceptor, dataDir };
})());

function stateUrl(state) {
  try { return state.wc.isDestroyed() ? '' : state.wc.getURL(); } catch { return ''; }
}

function eligible(url) {
  if (typeof url !== 'string' || url === '') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'app:') return false;
  if (!parsed.pathname.endsWith('/renderer/index.html')) return false;
  const hash = parsed.hash;
  if (hash === '' || hash === '#' || hash === '#/') return false;
  const route = hash.slice(1).toLowerCase();
  if (route.includes('screen') || route.includes('share')) return false;
  if (/^\/(?:blank|tray-menu|av)(?:[/?]|$)/.test(route)) return false;
  return true;
}

function logSkip(state, url) {
  if (!url || state.skipped.has(url)) return;
  state.skipped.add(url);
  activeLogger()?.debug('inject', 'window-skip', { window: state.wc.id, url: url.slice(0, 200) });
}

async function onConsole(state, details) {
  const message = details && details.message;
  if (!state.token || typeof message !== 'string' || !message.startsWith(state.token)) return;
  const wc = state.wc;
  try { if (wc.isDestroyed() || message.length > 2 * 1024 * 1024) return; } catch { return; }
  try {
    if (details.frame != null && wc.mainFrame && details.frame !== wc.mainFrame) return;
  } catch { /* 旧版本没有 mainFrame，忽略 */ }
  let request;
  try { request = JSON.parse(message.slice(state.token.length)); }
  catch { return; }
  if (!Number.isSafeInteger(request.id) || !Object.hasOwn(methods, request.method)) return;
  const start = Date.now();
  activeLogger()?.debug('host', 'request', { method: request.method, id: request.id, window: wc.id, argument: redactArgument(request.method, request.argument) });
  let result, error;
  try { result = await methods[request.method](request.argument, state); }
  catch (cause) { error = cause && cause.message ? cause.message : String(cause); activeLogger()?.error('host', 'request-failed', { method: request.method, error, stack: cause && cause.stack }); }
  activeLogger()?.debug('host', 'response', { method: request.method, id: request.id, window: wc.id, ms: Date.now() - start, ok: !error });
  if (request.id && state.token) {
    const script = 'window.AntiRecall && window.AntiRecall.reply('
      + request.id + ', ' + JSON.stringify(result ?? null) + ', ' + JSON.stringify(error ?? null) + ')';
    await wc.executeJavaScript(script).catch(() => {});
  }
}

async function apply(state, generation) {
  const wc = state.wc;
  try { if (wc.isDestroyed() || generation !== state.generation) return; } catch { return; }
  const url = stateUrl(state);
  if (!eligible(url) || state.applied) return;
  const { source, css } = await loadResources(root);
  try {
    if (wc.isDestroyed() || wc.isLoadingMainFrame() || generation !== state.generation || !eligible(stateUrl(state))) return;
  } catch { return; }
  state.token = '[anti-recall-host:' + randomUUID() + ']';
  const bootstrap = {
    token: state.token,
    config: ctx.config.get(),
    css,
    info: { plugin: PLUGIN_ID, version: VERSION, qqnt: app.getVersion(), versions: { ...process.versions } }
  };
  const script = '(async () => {\nconst bootstrap = ' + JSON.stringify(bootstrap)
    + ';\nif (window.__snowloraAntiRecallInjected) {\n'
    + '  window.AntiRecall.setToken(bootstrap.token);\n'
    + '  window.AntiRecall.applyConfig(bootstrap.config, bootstrap.css);\n'
    + '  return;\n}\n'
    + 'window.__snowloraAntiRecallInjected = true;\n'
    + source + '\nwindow.AntiRecall.flushLogBuffer && window.AntiRecall.flushLogBuffer();\n'
    + 'await window.AntiRecall.ready;\n})()';
  try {
    await wc.executeJavaScript(script);
    state.applied = true;
    const pendingCount = state.pending.length;
    for (const evt of state.pending.splice(0)) sendEvent(state, evt);
    activeLogger()?.info('inject', 'window-ready', { window: wc.id, generation, url: url.slice(0, 200), pendingEvents: pendingCount, settingsRoute: url.includes('#/setting') });
  } catch (error) {
    activeLogger()?.error('inject', 'window-failed', { window: wc.id, generation, url: url.slice(0, 200), error: error.message, stack: error.stack });
  }
}

function enqueue(state, generation) {
  state.ready = state.ready.then(() => apply(state, generation)).catch(error => {
    activeLogger()?.error('inject', 'queue-failed', { error: error && error.message, stack: error && error.stack });
  });
  return state.ready;
}

function onLoad(state) {
  state.generation++;
  state.applied = false;
  state.token = '';
  const url = stateUrl(state);
  if (!eligible(url)) { logSkip(state, url); return; }
  activeLogger()?.debug('inject', 'did-finish-load', { window: state.wc.id, generation: state.generation, url: url.slice(0, 200) });
  enqueue(state, state.generation);
}

function onRoute(state, isMainFrame) {
  if (!isMainFrame) return;
  const url = stateUrl(state);
  if (!eligible(url)) return;
  if (!state.applied) {
    activeLogger()?.debug('inject', 'did-navigate-in-page', { window: state.wc.id, generation: state.generation, url: url.slice(0, 200) });
    enqueue(state, state.generation);
  }
}

function attach(win) {
  if (!win || win.isDestroyed()) return null;
  const wc = win.webContents;
  const existing = windows.get(wc.id);
  if (existing) { ctx.interceptor.install(win); return existing; }
  const state = {
    wc, win, id: wc.id, token: '', generation: 0, applied: false,
    ready: Promise.resolve(), pending: [], skipped: new Set()
  };
  windows.set(wc.id, state);
  activeLogger()?.info('window', 'attached', { id: wc.id, url: stateUrl(state).slice(0, 200) });
  wc.on('console-message', (...args) => {
    // Electron 新版给 details 对象；旧版给 (event, level, message, line, sourceId)。
    let details = args[0];
    if (!details || typeof details.message !== 'string') {
      const legacy = args.length >= 3 && typeof args[2] === 'string' ? args[2] : null;
      details = legacy ? { message: legacy, frame: null } : null;
    }
    if (details) onConsole(state, details);
  });
  wc.on('did-finish-load', () => onLoad(state));
  wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => onRoute(state, isMainFrame));
  wc.once('destroyed', () => { windows.delete(wc.id); activeLogger()?.info('window', 'destroyed', { id: wc.id }); });
  ctx.interceptor.install(win);
  const url = stateUrl(state);
  let loading = true;
  try { loading = wc.isLoadingMainFrame(); } catch { /* ignore */ }
  if (eligible(url) && !loading) enqueue(state, state.generation);
  else if (url) logSkip(state, url);
  return state;
}

function createManager() {
  app.on('browser-window-created', (_event, win) => attach(win));
  for (const win of BrowserWindow.getAllWindows()) attach(win);
  app.on('quit', () => {
    activeLogger()?.info('boot', 'quit', { windows: windows.size, records: ctx.store.size, flow: ctx.interceptor.msgFlow.length });
    try { ctx.store.flush(); } catch (error) { activeLogger()?.warn('boot', 'flush-failed', { error: error.message }); }
  });
  return { windows, attach, eligible };
}

const manager = (globalThis.__snowloraAntiRecallManager ??= createManager());

// SnowLora 只按标题匹配 HWND；管理器已在进程内接管全部窗口，这里仅等待目标窗口。
const snowloraWindow = BrowserWindow.getAllWindows().find(win => {
  try {
    return !win.isDestroyed()
      && win.getNativeWindowHandle().readBigUInt64LE().toString(16) === snowlora.window;
  } catch { return false; }
});
if (!snowloraWindow) return;
const targetState = manager.attach(snowloraWindow);
if (!targetState || !eligible(stateUrl(targetState))) return;
await targetState.ready;