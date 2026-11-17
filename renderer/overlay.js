(() => {
  'use strict';
  const ID = 'anti-recall-toast';
  let timer = null;

  function toast(text, kind) {
    let node = document.getElementById(ID);
    if (!node) {
      node = document.createElement('div');
      node.id = ID;
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
    }
    node.textContent = String(text || '');
    node.dataset.kind = kind || 'info';
    node.classList.add('is-visible');
    clearTimeout(timer);
    timer = setTimeout(() => node.classList.remove('is-visible'), 2600);
  }

  if (window.AntiRecall) window.AntiRecall.toast = toast;
})();
