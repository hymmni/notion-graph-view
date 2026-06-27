(function () {
  'use strict';

  let lastPageId = null;

  function extractPageId(url) {
    try {
      const pathname = new URL(url).pathname;
      const m1 = pathname.match(/-([a-f0-9]{32})(?:[?#]|$)/i);
      if (m1) return m1[1].toLowerCase();
      const segs = pathname.split('/').filter(Boolean);
      const last = segs[segs.length - 1] || '';
      const m2 = last.match(/^([a-f0-9]{32})$/i);
      if (m2) return m2[1].toLowerCase();
      const m3 = pathname.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      if (m3) return m3[1].replace(/-/g, '').toLowerCase();
    } catch {}
    return null;
  }

  function notify(pageId) {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'PAGE_ACTIVE', pageId }).catch(() => {});
  }

  function onUrlChange() {
    try { if (!chrome.runtime?.id) return; } catch { return; }
    const pageId = extractPageId(window.location.href);
    if (pageId && pageId !== lastPageId) {
      lastPageId = pageId;
      notify(pageId);
    }
  }

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState    = function (...a) { origPush.apply(this, a);    onUrlChange(); };
  history.replaceState = function (...a) { origReplace.apply(this, a); onUrlChange(); };
  window.addEventListener('popstate', onUrlChange);
  setInterval(onUrlChange, 1500);
  onUrlChange();
})();
