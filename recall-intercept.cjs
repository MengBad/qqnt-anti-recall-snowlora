'use strict';

const KEEP_FROM_TIP = new Set(['msgSeq', 'cntSeq', 'clientSeq', 'sendStatus', 'emojiLikesList']);
const MERGE_OBJECT_KEYS = new Set(['msgAttrs', 'msgMeta', 'generalFlags']);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function revokeOf(item) {
  if (!item || item.msgType !== 5 || item.subMsgType !== 4) return null;
  const el = Array.isArray(item.elements) ? item.elements[0] : null;
  const revoke = el && el.grayTipElement && el.grayTipElement.revokeElement;
  return revoke || null;
}

function isChatUrl(url) {
  return typeof url === 'string' && (url.includes('#/main/message') || url.includes('#/chat') || url.includes('#/main'));
}

function safeUrl(wc) {
  try { return wc.getURL() || ''; } catch { return ''; }
}

class RecallInterceptor {
  constructor({ config, store, imgDownloader, notify, output }) {
    this.config = config;
    this.store = store;
    this.imgDownloader = imgDownloader;
    this.notify = notify;
    this.output = output || (() => {});
    this.msgFlow = [];
    this.recalledMsg = [];
    this.patched = new WeakSet();
    this.installed = new WeakSet();
  }

  get nowConfig() { return this.config.get(); }

  install(window) {
    const wc = window && window.webContents;
    if (!wc || this.installed.has(wc)) return false;
    this.installed.add(wc);
    const patch = () => {
      if (!isChatUrl(safeUrl(wc))) return;
      this._patchSend(window);
    };
    // did-stop-loading 覆盖新文档；QQ 的池窗口以 #/blank 预创建后靠
    // did-navigate-in-page 切到真实路由，必须同时补挂，否则撤回拦截失效。
    // _patchSend 自身按 wc 去重，两个事件可安全共存。
    wc.on('did-stop-loading', patch);
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame !== false) patch(); });
    try { if (!wc.isLoadingMainFrame() && isChatUrl(safeUrl(wc))) patch(); } catch { /* ignore */ }
    return true;
  }

  _patchSend(window) {
    const wc = window.webContents;
    if (this.patched.has(wc)) return;
    this.patched.add(wc);
    const target = wc.__qqntim_original_object || wc;
    const originalSend = target.send;
    const patched = async (channel, ...args) => {
      const started = Date.now();
      try { await this._inspect(window, channel, args); }
      catch (error) {
        this.output('[error][intercept] inspect-exception', {
          channel, cmdName: args[1] && args[1].cmdName,
          error: error && error.message, stack: error && error.stack
        });
      }
      this.output('[debug][intercept] send', {
        channel, cmdName: args[1] && args[1].cmdName, ms: Date.now() - started
      });
      return originalSend.call(target, channel, ...args);
    };
    target.send = patched;
    this.output('[info][intercept] patched', { url: safeUrl(wc).slice(0, 200), window: wc.id });
  }

  _persist(record) {
    if (!this.nowConfig.saveDb) return;
    this.store.setEnabled(true);
    this.store.put(record);
  }

  async _findOriginal(id) {
    const key = String(id);
    let record = this.recalledMsg.find(i => String(i.id) === key);
    if (record) return { record, from: 'cache' };
    record = this.msgFlow.find(i => String(i.id) === key);
    if (record) {
      this.recalledMsg.push(record);
      this._persist(record);
      return { record, from: 'msgFlow' };
    }
    if (this.nowConfig.saveDb) record = this.store.get(key);
    if (record) {
      this.recalledMsg.push(record);
      return { record, from: 'store' };
    }
    this.output('[debug][recall] miss', { msgId: key, saveDb: this.nowConfig.saveDb, flow: this.msgFlow.length });
    return { record: null, from: 'none' };
  }

  async _inspect(window, channel, args) {
    if (!Array.isArray(args) || args.length < 2) return;
    const cfg = this.nowConfig;
    const cmdName = args[1] && typeof args[1].cmdName === 'string' ? args[1].cmdName : null;
    if (cfg.debugIpc && cmdName) {
      this.output('[debug][ipc] ' + cmdName, {
        cmdName, channel, argTypes: args.map(a => Array.isArray(a) ? 'array' : typeof a),
        msgCount: args[1] && args[1].payload && Array.isArray(args[1].payload.msgList)
          ? args[1].payload.msgList.length : null
      });
    }

    // A. 消息列表全量更新：把撤回提示替换成之前保存的原文。
    const holder = args.find(item => item && has(item, 'msgList') && Array.isArray(item.msgList) && item.msgList.length > 0);
    if (holder) {
      const list = holder.msgList;
      let currentMsgPeer = '';
      const needUpdate = [];
      for (let idx = 0; idx < list.length; idx++) {
        const item = list[idx];
        if (!item) continue;
        if (item.peerUid) currentMsgPeer = item.peerUid;
        const revoke = revokeOf(item);
        if (revoke && (cfg.isAntiRecallSelfMsg || !revoke.isSelfOperate)) needUpdate.push(idx);
      }
      for (const idx of needUpdate.sort((a, b) => b - a)) {
        const tip = list[idx];
        const { record, from } = await this._findOriginal(tip.msgId);
        if (!record || !record.msg || typeof record.msg !== 'object') continue;
        const msg = Object.assign({}, record.msg);
        msg.isOnlineMsg = true;
        await this.imgDownloader.downloadPic(msg);
        for (const key of Object.keys(msg)) {
          if (KEEP_FROM_TIP.has(key)) continue;
          const newValue = msg[key];
          const oldValue = tip[key];
          let value = newValue;
          if (MERGE_OBJECT_KEYS.has(key) && newValue && typeof newValue === 'object' && oldValue && typeof oldValue === 'object') {
            for (const k of Object.keys(oldValue)) delete oldValue[k];
            value = Object.assign(oldValue, newValue);
          }
          tip[key] = value;
        }
        this.output('[info][recall] restored', { msgId: String(tip.msgId), from, peerUid: String(tip.peerUid || ''), cmdName });
      }
      const ids = this.recalledMsg
        .filter(i => !i.sender || !currentMsgPeer || i.sender === currentMsgPeer)
        .map(i => i.id);
      this.notify(window, 'recallTipList', ids);
      this.output('[debug][recall] tip-list', { count: ids.length, peerUid: currentMsgPeer, listLength: list.length });
    }

    // B. 增量 IPC。
    const args1 = args[1];
    if (!args1 || typeof args1.cmdName !== 'string') return;
    const cmd = args1.cmdName;
    const payload = args1.payload;

    const recallUpdate = (cmd.includes('onMsgInfoListUpdate') || cmd.includes('onActiveMsgInfoUpdate'))
      && payload && Array.isArray(payload.msgList) && payload.msgList.length > 0
      && revokeOf(payload.msgList[0]);
    if (recallUpdate && (cfg.isAntiRecallSelfMsg || !recallUpdate.isSelfOperate)) {
      const tip = payload.msgList[0];
      const id = String(tip.msgId);
      this.notify(window, 'recallTip', id);
      const { record } = await this._findOriginal(id);
      await this.imgDownloader.downloadPic(record && record.msg);
      args1.cmdName = 'none';
      payload.msgList.pop();
      this.output('[info][recall] intercepted', { msgId: id, cmdName, selfOperate: Boolean(recallUpdate.isSelfOperate), source: record ? 'known' : 'unknown' });
      return;
    }

    const incoming = payload && (
      (cmd.includes('onRecvMsg') || cmd.includes('onRecvActiveMsg') || cmd.includes('onMsgInfoListUpdate')) && Array.isArray(payload.msgList)
      || (cmd.includes('onAddSendMsg') && payload.msgRecord)
      || (cmd.includes('onActiveMsgInfoUpdate') && Array.isArray(payload.msgList))
    );
    if (!incoming) return;
    const list = Array.isArray(payload.msgList) ? payload.msgList : [payload.msgRecord];
    for (const msg of list) {
      if (!msg || msg.msgId == null) continue;
      const record = { id: String(msg.msgId), sender: msg.peerUid || '', msg };
      const idx = this.msgFlow.findIndex(i => i.id === record.id);
      if (idx === -1) this.msgFlow.push(record);
      else this.msgFlow[idx] = record;
    }
    if (this.msgFlow.length > cfg.maxMsgSaveLimit) {
      const removed = Math.min(cfg.deleteMsgCountPerTime, this.msgFlow.length);
      this.msgFlow.splice(0, removed);
      this.output('[debug][cache] trimmed', { removed, remaining: this.msgFlow.length, limit: cfg.maxMsgSaveLimit });
    }
  }
}

module.exports = { RecallInterceptor, revokeOf, isChatUrl };