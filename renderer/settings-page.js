(() => {
  'use strict';
  const NAV_CLASS = 'anti-recall-settings-nav';
  const VIEW_CLASS = 'anti-recall-settings-page';
  const TITLE = '防撤回';

  function log(level, event, data) {
    if (window.AntiRecall && typeof window.AntiRecall.log === 'function') {
      window.AntiRecall.log(level, event, data);
    }
  }

  function isSettingsRoute() {
    return (location.hash || '').indexOf('#/setting') === 0;
  }

  // 上游的 onSettingWindowCreated(view) 会把 <plugin-menu> 追加到 view；
  // 日志面板也接同一个 view，QQ 设置页与浮动 dialog 共用一套渲染。
  async function renderContent(view) {
    const build = window.AntiRecall && window.AntiRecall.onSettingWindowCreated;
    if (typeof build !== 'function') throw new Error('上游设置构建函数未注入');
    view.innerHTML = '';
    view.classList.add('anti-recall-embedded');
    const wrapper = document.createElement('div');
    wrapper.className = 'anti-recall-embedded-inner';
    view.appendChild(wrapper);
    await build(wrapper);
    if (window.AntiRecall && typeof window.AntiRecall.buildLogPanel === 'function') {
      await window.AntiRecall.buildLogPanel(wrapper);
    }
    return wrapper;
  }

  function mountSettingsPage() {
    if (!isSettingsRoute()) return;
    let tries = 0;
    const tick = () => {
      if (!isSettingsRoute()) return;
      const tab = document.querySelector('.setting-tab');
      const navBar = tab && tab.querySelector('.nav-bar');
      const main = document.querySelector('.setting-main .setting-main__content');
      const original = document.querySelector('.setting-main .q-scroll-view');
      const title = document.querySelector('.setting-main .setting-title');
      const sample = navBar && navBar.querySelector('.nav-item');
      if (!tab || !navBar || !main || !original || !title || !sample) {
        if (tries++ < 100) setTimeout(tick, 200);
        else log('warn', 'settings-page-dom-timeout', { tries, hash: location.hash });
        return;
      }
      if (tab.querySelector('.' + NAV_CLASS)) return;

      // 克隆 QQ 原生导航项：拿到一致的图标/结构/高亮行为，不改原生 DOM 结构。
      const nav = sample.cloneNode(true);
      nav.classList.remove('nav-item-active');
      nav.classList.add(NAV_CLASS);
      const name = nav.querySelector('.name');
      if (name) name.textContent = TITLE;
      else nav.textContent = TITLE;
      const group = document.createElement('div');
      group.className = 'nav-bar anti-recall-settings-navbar';
      group.appendChild(nav);
      tab.appendChild(group);

      const view = document.createElement('div');
      view.className = VIEW_CLASS + ' q-scroll-view scroll-view--show-scrollbar';
      view.style.display = 'none';
      main.appendChild(view);

      let seq = 0;
      let renderPending = null;
      let titleNode = null;
      let titleSaved = null;

      nav.addEventListener('click', async () => {
        const ticket = seq;
        if (!renderPending) {
          renderPending = (async () => {
            try {
              await renderContent(view);
              view.dataset.ready = '1';
              log('info', 'settings-page-rendered', { hash: location.hash });
            } catch (error) {
              view.textContent = '防撤回设置加载失败：' + (error && error.message ? error.message : error);
              log('error', 'settings-page-render-failed', {
                message: error && error.message, stack: error && error.stack
              });
            }
          })();
        }
        await renderPending;
        if (ticket !== seq || !nav.isConnected) return;
        original.style.display = 'none';
        view.style.display = 'block';
        const titleText = [...title.childNodes].find(n => n.nodeType === 3 && n.nodeValue.trim());
        if (titleText) {
          if (titleSaved === null) titleSaved = titleText.nodeValue;
          titleNode = titleText;
          titleText.nodeValue = ' ' + TITLE;
        }
        tab.querySelectorAll('.nav-item').forEach(el => el.classList.remove('nav-item-active'));
        nav.classList.add('nav-item-active');
      });

      // 捕获阶段先于 QQ 的 Vue 处理：切到别的原生页时还原内容与标题。
      tab.addEventListener('click', e => {
        const item = e.target.closest && e.target.closest('.nav-item');
        if (item) seq++;
        if (item && item !== nav) {
          view.style.display = 'none';
          original.style.display = 'block';
          nav.classList.remove('nav-item-active');
          const restoreTicket = seq;
          requestAnimationFrame(() => {
            if (restoreTicket !== seq) return;
            if (!tab.querySelector('.nav-item.nav-item-active')) item.classList.add('nav-item-active');
          });
          if (titleNode && titleSaved !== null && titleNode.isConnected) titleNode.nodeValue = titleSaved;
          titleNode = null;
          titleSaved = null;
        }
      }, true);

      log('info', 'settings-page-mounted', { tries, hash: location.hash });
    };
    tick();
  }

  window.AntiRecall.mountSettingsPage = mountSettingsPage;
  log('info', 'settings-page-script-loaded', { hash: location.hash, readyState: document.readyState });
  window.addEventListener('hashchange', () => {
    if (isSettingsRoute()) setTimeout(mountSettingsPage, 120);
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountSettingsPage, { once: true });
  } else {
    mountSettingsPage();
  }
})();