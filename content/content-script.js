(function () {
  'use strict';

  const BUTTON_MARK = 'data-ng-graph-button';

  // ─── URL 추적 (pushState 래핑, 폴링 없음) ─────────────────────────────────

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

  function sendMsg(msg) {
    try { if (chrome.runtime?.id) chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
  }

  function onUrlChange() {
    const pageId = extractPageId(window.location.href);
    if (pageId && pageId !== lastPageId) {
      lastPageId = pageId;
      sendMsg({ type: 'PAGE_ACTIVE', pageId });
    }
  }

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState    = function (...a) { origPush.apply(this, a);    onUrlChange(); };
  history.replaceState = function (...a) { origReplace.apply(this, a); onUrlChange(); };
  window.addEventListener('popstate', onUrlChange);
  onUrlChange();

  // ─── Notion 상단바 버튼 주입 ─────────────────────────────────────────────

  function openGraph() {
    const pageId = extractPageId(location.href) || '';
    sendMsg({ type: 'OPEN_GRAPH', pageId });
  }

  function mountButton() {
    if (document.querySelector('[' + BUTTON_MARK + ']')) return;
    const moreBtn = document.querySelector('div.notion-topbar-more-button[role="button"]');
    if (!moreBtn) return;

    const btn = document.createElement('div');
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    btn.setAttribute(BUTTON_MARK, 'true');
    btn.textContent = '그래프';
    btn.setAttribute('aria-label', 'Notion Graph View');
    btn.title = 'Notion Graph View';

    Object.assign(btn.style, {
      userSelect: 'none',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '28px',
      borderRadius: '6px',
      paddingLeft: '10px',
      paddingRight: '10px',
      whiteSpace: 'nowrap',
      fontWeight: '600',
      fontSize: '12px',
      lineHeight: '1',
      marginLeft: '4px',
      transition: 'background 80ms ease-in',
    });

    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--ca-butHovBac)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = ''; });
    btn.addEventListener('click',   (e) => { e.preventDefault(); e.stopPropagation(); openGraph(); });
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGraph(); } });

    // moreBtn.parentElement가 wrapper라면 그 앞에, 아니면 moreBtn 앞에 삽입
    const anchor = moreBtn.parentElement?.parentElement ? moreBtn.parentElement : moreBtn;
    anchor.parentElement?.insertBefore(btn, anchor);
  }

  const observer = new MutationObserver(mountButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(mountButton, 800);
  mountButton();
})();
