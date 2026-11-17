(() => {
  'use strict';
  const DIALOG_ID = 'anti-recall-settings-dialog';

  function notify(text, kind) {
    if (window.AntiRecall && typeof window.AntiRecall.toast === 'function') window.AntiRecall.toast(text, kind);
    else console.log('[Anti-Recall]', text);
  }

  async function exportDiag() {
    try {
      const data = await window.anti_recall.exportDiag();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'anti-recall-diag.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      notify('诊断信息已导出', 'ok');
    } catch (error) {
      notify('导出失败：' + (error && error.message ? error.message : error), 'error');
    }
  }


  async function buildLogPanel(view) {
    const config = await window.anti_recall.getNowConfig();
    const section = document.createElement('setting-section');
    section.setAttribute('data-title', '诊断日志');
    const panelEl = document.createElement('setting-panel');
    const list = document.createElement('setting-list');
    list.setAttribute('data-direction', 'column');

    const mkRow = (label, hint) => {
      const row = document.createElement('setting-item');
      row.setAttribute('data-direction', 'row');
      const left = document.createElement('div');
      const h = document.createElement('h2');
      h.textContent = label;
      const sub = document.createElement('span');
      sub.className = 'secondary-text';
      sub.textContent = hint;
      left.append(h, sub);
      row.appendChild(left);
      return row;
    };

    const rowDebug = mkRow('写 DEBUG 级日志', '关闭时仍记录 info/warn/error；开启后把 IPC、宿主请求、缓存淘汰写入日志文件。');
    const sw = document.createElement('div');
    sw.id = 'anti-recall-debug-log-switch';
    sw.className = 'q-switch';
    sw.innerHTML = '<span class="q-switch__handle"></span>';
    if (config && config.debugLog) sw.classList.add('is-active');
    sw.addEventListener('click', async () => {
      const active = sw.classList.toggle('is-active');
      try {
        const next = await window.anti_recall.getNowConfig();
        next.debugLog = active;
        await window.anti_recall.saveConfig(next);
        notify(active ? 'DEBUG 日志已开启' : 'DEBUG 日志已关闭', 'ok');
      } catch (error) {
        sw.classList.toggle('is-active');
        notify('保存失败：' + (error && error.message ? error.message : error), 'error');
      }
    });
    rowDebug.appendChild(sw);
    list.appendChild(rowDebug);

    const rowView = mkRow('实时日志', '显示本次会话最近 200 条结构化日志；「读取磁盘」可看上次 QQ 会话。');
    const controls = document.createElement('div');
    controls.className = 'anti-recall-log-controls';
    const mkBtn = (text, handler) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'q-button q-button--small q-button--secondary';
      btn.textContent = text;
      btn.addEventListener('click', handler);
      controls.appendChild(btn);
      return btn;
    };
    const area = document.createElement('textarea');
    area.className = 'anti-recall-log-view';
    area.readOnly = true;
    area.spellcheck = false;
    area.setAttribute('aria-label', '防撤回调试日志');
    async function refresh(disk) {
      try {
        const result = await window.anti_recall.readLogs({ count: 200 });
        area.value = (result.files || []).map(f => '# ' + f.name + ' (' + f.bytes + ' bytes)').join('\n')
          + ((result.files || []).length ? '\n' : '')
          + (disk ? (result.diskText || '') : (result.text || ''));

        notify(disk ? '已读取磁盘日志' : '已刷新日志', 'ok');
      } catch (error) {
        area.value = '读取日志失败：' + (error && error.message ? error.message : error);
        notify('读取日志失败', 'error');
      }
    }
    mkBtn('刷新', () => refresh(false));
    mkBtn('读取磁盘', () => refresh(true));
    mkBtn('复制', async () => {
      try { await navigator.clipboard.writeText(area.value); notify('日志已复制', 'ok'); }
      catch (error) { notify('复制失败：' + (error && error.message ? error.message : error), 'error'); }
    });
    mkBtn('打开日志文件夹', async () => {
      try {
        const result = await window.anti_recall.openLogs();
        notify(result && result.ok ? '已定位日志文件' : ('打开失败：' + (result && result.error)), result && result.ok ? 'ok' : 'error');
      } catch (error) { notify('打开失败：' + (error && error.message ? error.message : error), 'error'); }
    });
    mkBtn('清空日志', async () => {
      if (!confirm('清空当前日志文件与内存缓冲？此操作不可恢复。')) return;
      try { await window.anti_recall.clearLogs(); await refresh(false); notify('日志已清空', 'ok'); }
      catch (error) { notify('清空失败：' + (error && error.message ? error.message : error), 'error'); }
    });
    rowView.appendChild(controls);
    list.appendChild(rowView);
    const areaItem = document.createElement('setting-item');
    areaItem.setAttribute('data-direction', 'column');
    areaItem.appendChild(area);
    list.appendChild(areaItem);

    panelEl.appendChild(list);
    section.appendChild(panelEl);
    view.appendChild(section);
    await refresh(false);
  }

  async function augmentWithLogs(view) {
    try {
      await buildLogPanel(view);
    } catch (error) {
      console.error('[Anti-Recall] 日志面板构建失败', error);
      if (window.AntiRecall && window.AntiRecall.log) {
        window.AntiRecall.log('warn', 'log-panel-failed', { message: error && error.message });
      }
    }
  }

  async function openSettings() {
    let dialog = document.getElementById(DIALOG_ID);
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = DIALOG_ID;
      dialog.className = 'anti-recall-settings-dialog';

      const header = document.createElement('div');
      header.className = 'anti-recall-settings-header';
      const title = document.createElement('strong');
      title.textContent = '防撤回 · 设置';
      const spacer = document.createElement('span');
      spacer.className = 'anti-recall-settings-spacer';
      const diag = document.createElement('button');
      diag.type = 'button';
      diag.className = 'q-button q-button--small q-button--secondary';
      diag.textContent = '导出诊断';
      diag.addEventListener('click', exportDiag);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'anti-recall-settings-close';
      close.setAttribute('aria-label', '关闭');
      close.textContent = '×';
      close.addEventListener('click', () => dialog.close());
      header.append(title, spacer, diag, close);

      const view = document.createElement('div');
      view.className = 'anti-recall-settings-view';
      dialog.append(header, view);
      document.body.appendChild(dialog);
      dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
      });

      try {
        const build = window.AntiRecall && window.AntiRecall.onSettingWindowCreated;
        if (typeof build !== 'function') throw new Error('上游设置构建函数未注入');
        await build(view);
        await augmentWithLogs(view);
      } catch (error) {
        const tip = document.createElement('p');
        tip.className = 'anti-recall-settings-error';
        tip.textContent = '设置面板构建失败：' + (error && error.message ? error.message : error);
        view.appendChild(tip);
        console.error('[Anti-Recall]', error);
      }
    }
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  window.addEventListener('keydown', event => {
    if (event.altKey && event.shiftKey && (event.key === 'R' || event.key === 'r')) {
      event.preventDefault();
      openSettings();
    }
  });
  window.addEventListener('anti-recall-open-settings', openSettings);
  if (window.AntiRecall) {
    window.AntiRecall.buildLogPanel = buildLogPanel;
    window.AntiRecall.openSettingsDialog = openSettings;
  }
})();