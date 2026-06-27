(function () {
  'use strict';

  const badge = document.getElementById('badge');

  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, response => {
    if (chrome.runtime.lastError || !response) return;
    if (response.hasToken) {
      badge.textContent = '연결됨';
      badge.className = 'badge connected';
    }
  });

  document.getElementById('open-panel').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { window.close(); return; }
    try {
      await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: true });
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {
      try {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id });
      } catch (err) {
        console.error('사이드패널 열기 실패:', err);
      }
    }
    window.close();
  });
})();
