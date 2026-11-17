(() => {
  'use strict';
  const tokenRef = { value: bootstrap.token };
  const pending = new Map();
  const listeners = new Map();
  const send = console.debug.bind(console);
  let sequence = 0;
  // 渲染端日志统一经宿主桥落盘；即便宿主桥尚未 ready 也先缓冲。
  const logBuffer = [];
  let logBridgeReady = false;
  function log(level, event, data) {
    const entry = {
      ts: new Date().toISOString(), level, scope: 'renderer', event,
      data: data === undefined ? null : data,
      href: location && location.href ? location.href.slice(0, 200) : ''
    };
    if (!logBridgeReady) { logBuffer.push(entry); if (logBuffer.length > 200) logBuffer.shift(); return; }
    try { send(tokenRef.value + JSON.stringify({ id: 0, method: 'log', argument: entry })); }
    catch { /* 日志失败不阻断功能 */ }
  }
  function flushLogBuffer() {
    logBridgeReady = true;
    for (const entry of logBuffer.splice(0)) {
      try { send(tokenRef.value + JSON.stringify({ id: 0, method: 'log', argument: entry })); } catch { /* ignore */ }
    }
  }

  function applyBaseCss(css) {
    let style = document.getElementById('anti-recall-base-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'anti-recall-base-css';
      document.head.appendChild(style);
    }
    style.textContent = css || '';
  }

  function request(method, argument) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      log('debug', 'host-request', { method, id });
      const timer = setTimeout(() => {
        pending.delete(id);
        log('warn', 'host-timeout', { method, id, timeoutMs: 60000 });
        reject(new Error('防撤回宿主响应超时：' + method));
      }, 60000);
      pending.set(id, { resolve, reject, timer });
      send(tokenRef.value + JSON.stringify({ id, method, argument }));
    });
  }

  function on(event, callback) {
    if (typeof callback !== 'function') return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
    return () => listeners.get(event).delete(callback);
  }

  function dispatch(event, payload) {
    const set = listeners.get(event);
    if (!set) return 0;
    for (const callback of [...set]) {
      Promise.resolve()
        .then(() => callback(null, payload))
        .catch(error => {
          log('error', 'event-callback-error', { event, error: error && error.message, stack: error && error.stack });
          console.error('[Anti-Recall] 事件回调异常', event, error);
        });
    }
    return set.size;
  }

  function reply(id, result, error) {
    const task = pending.get(id);
    if (!task) { log('debug', 'host-late-reply', { id, error: error || null }); return; }
    pending.delete(id);
    clearTimeout(task.timer);
    log(error ? 'warn' : 'debug', 'host-reply', { id, ok: !error, error: error || null });
    if (error) task.reject(new Error(error));
    else task.resolve(result);
  }

  applyBaseCss(bootstrap.css);

  window.AntiRecall = {
    ready: Promise.resolve(),
    info: bootstrap.info,
    config: bootstrap.config,
    setToken(value) { tokenRef.value = value; },
    applyConfig(config, css) {
      this.config = config;
      applyBaseCss(css);
      dispatch('repatchCss', config);
    },
    dispatch,
    reply,
    on,
    log,
    flushLogBuffer,
    toast: null
  };
  function errorText(value) {
    if (!value) return '';
    return [typeof value === 'string' ? value : value.message, value.stack]
      .filter(Boolean).join('\n');
  }
  function isNoise(value) {
    const text = errorText(value).trim();
    return /^(cancel|cancelled|abort(ed)?)$/i.test(text)
      || /ResizeObserver loop completed with undelivered notifications/i.test(text);
  }
  function isOwn(value) {
    return /Anti-Recall|anti_recall|anti-recall|AntiRecall/i.test(errorText(value));
  }
  window.addEventListener('error', event => {
    if (isNoise(event.message)) return;
    const own = isOwn(event.error) || isOwn(event.message);
    log(own ? 'error' : 'debug', own ? 'window-error' : 'external-window-error', {
      message: event.message, filename: event.filename, lineno: event.lineno,
      stack: event.error && event.error.stack
    });
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    if (isNoise(reason)) return;
    const own = isOwn(reason);
    log(own ? 'error' : 'debug', own ? 'unhandled-rejection' : 'external-rejection', {
      reason: errorText(reason).slice(0, 500), stack: reason && reason.stack ? String(reason.stack).slice(0, 1000) : ''
    });
  });
  log('info', 'renderer-ready', { token: bootstrap.token, plugin: bootstrap.info && bootstrap.info.plugin });

  window.anti_recall = Object.freeze({
    getNowConfig: () => request('getNowConfig'),
    saveConfig: config => request('saveConfig', config),
    clearDb: () => request('clearDb'),
    exportDiag: () => request('exportDiag'),
    openLogs: () => request('openLogs'),
    clearLogs: () => request('clearLogs'),
    readLogs: arg => request('readLogs', arg),
    log: entry => {
      if (entry && typeof entry === 'object' && entry.level && entry.event) log(entry.level, entry.event, entry.data);
      else log('info', 'renderer-message', entry);
    },
    repatchCss: callback => on('repatchCss', callback),
    recallTip: callback => on('recallTip', callback),
    recallTipList: callback => on('recallTipList', callback)
  });
})();