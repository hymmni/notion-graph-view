(function () {
  'use strict';

  // ─── UI refs ───────────────────────────────────────────────────────────────
  const tokenScreen    = document.getElementById('token-screen');
  const graphScreen    = document.getElementById('graph-screen');
  const tokenInput     = document.getElementById('token-input');
  const tokenSave      = document.getElementById('token-save');
  const tokenError     = document.getElementById('token-error');
  const searchInput    = document.getElementById('search-input');
  const dbCountEl      = document.getElementById('db-count');
  const cacheIndicator = document.getElementById('cache-indicator');
  const btnRefresh     = document.getElementById('btn-refresh');
  const btnDisconnect  = document.getElementById('btn-disconnect');
  const btnLocal       = document.getElementById('btn-local');
  const btnSettings    = document.getElementById('btn-settings');
  const localBar       = document.getElementById('local-bar');
  const localPageName  = document.getElementById('local-page-name');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingMsg     = document.getElementById('loading-msg');
  const errorOverlay   = document.getElementById('error-overlay');
  const errorMsg       = document.getElementById('error-msg');
  const btnRetry       = document.getElementById('btn-retry');
  const warningBanner  = document.getElementById('warning-banner');
  const warningMsg     = document.getElementById('warning-msg');
  const tooltip        = document.getElementById('tooltip');
  const svg            = document.getElementById('graph-svg');
  const depthSlider    = document.getElementById('depth-slider');
  const depthVal       = document.getElementById('depth-val');
  const settingsPanel  = document.getElementById('settings-panel');
  const settingsClose  = document.getElementById('settings-close');

  // ─── 색상 팔레트 ───────────────────────────────────────────────────────────
  const DB_COLORS = [
    '#818cf8','#34d399','#f87171','#fbbf24','#60a5fa',
    '#a78bfa','#fb7185','#2dd4bf','#fb923c','#a3e635',
    '#e879f9','#38bdf8',
  ];

  // ─── 상태 ──────────────────────────────────────────────────────────────────
  let simulation         = null;
  let currentNodes       = [];
  let currentEdges       = [];
  let currentDbs         = [];
  let savedZoomTransform = null;
  let currentZoomScale   = 1;
  let dbSortMode         = 'name'; // 'name' | 'count' | 'custom'
  let dbOrder            = [];     // custom sort order (array of db.id)
  let draggingNode       = null;   // 드래그 중인 노드 (hover 유지용)
  let savedPositions     = new Map(); // 노드 위치 저장 (re-render 시 복원)
  let activeSearch       = '';     // 현재 검색어 (mouseleave 후 복원용)
  let knownWindowId      = null;   // Chrome sidePanel에서 currentWindow 오인식 방지용
  let knownTabId         = null;   // 노드 클릭 시 동기 navigate용 탭 ID 캐시

  const DB_ORDER_KEY = 'dbCustomOrder';

  function extractPageIdFromUrl(url) {
    try {
      const p = new URL(url).pathname;
      const m1 = p.match(/-([a-f0-9]{32})(?:[?#]|$)/i); if (m1) return m1[1].toLowerCase();
      const last = p.split('/').filter(Boolean).pop() || '';
      const m2 = last.match(/^([a-f0-9]{32})$/i); if (m2) return m2[1].toLowerCase();
      const m3 = p.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      if (m3) return m3[1].replace(/-/g, '').toLowerCase();
    } catch {}
    return null;
  }

  const DEFAULT_SETTINGS = {
    hideOrphans:    false,
    minDegree:      0,
    nodeSizeScale:  1.0,
    showLabels:     true,
    labelThreshold: 0,
    showArrows:     false,
    showPageNodes:  false, // 비DB 페이지 노드 표시
    linkWidth:      1.5,
    repelMaxDist:   300,
    linkDistance:   150,
    repelStrength:  7,    // 0~20 표시, 내부 ×25 적용 (Obsidian 스케일)
    centerStrength: 0.3,
    linkStrength:   0.7,
  };

  const settings = {
    ...DEFAULT_SETTINGS,
    hiddenDbs:      new Set(),
    localMode:      false,
    localDepth:     1,
    localPageId:    null,
    localPageTitle: null,
  };

  // ─── 화면 전환 ─────────────────────────────────────────────────────────────
  function showScreen(screen) {
    tokenScreen.classList.add('hidden');
    graphScreen.classList.add('hidden');
    screen.classList.remove('hidden');
  }
  function showLoading(msg) {
    loadingMsg.textContent = msg || '데이터 로딩 중...';
    loadingOverlay.classList.remove('hidden');
    errorOverlay.classList.add('hidden');
    warningBanner.classList.add('hidden');
  }
  function hideLoading() { loadingOverlay.classList.add('hidden'); }
  function showError(msg) {
    errorMsg.textContent = msg;
    errorOverlay.classList.remove('hidden');
    loadingOverlay.classList.add('hidden');
  }
  function hideError() { errorOverlay.classList.add('hidden'); }
  function showWarning(msg) { warningMsg.textContent = msg; warningBanner.classList.remove('hidden'); }
  function showTokenError(msg) { tokenError.textContent = msg; tokenError.classList.remove('hidden'); }
  function hideTokenError()    { tokenError.classList.add('hidden'); }

  // ─── 캐시 인디케이터 ───────────────────────────────────────────────────────
  let cacheTimer = null;
  function showCacheAge(cachedAt) {
    const mins = Math.round((Date.now() - cachedAt) / 60000);
    cacheIndicator.textContent = mins < 1 ? '캐시' : `${mins}분 전`;
    cacheIndicator.className = 'cache-indicator syncing';
  }
  function showSynced() {
    clearTimeout(cacheTimer);
    cacheIndicator.textContent = '✓ 동기화됨';
    cacheIndicator.className = 'cache-indicator fresh';
    cacheTimer = setTimeout(() => cacheIndicator.classList.add('hidden'), 3000);
  }
  function hideCacheIndicator() { clearTimeout(cacheTimer); cacheIndicator.classList.add('hidden'); }

  // ─── 메시지 ────────────────────────────────────────────────────────────────
  function isCtxInvalid(msg) {
    return msg && (msg.includes('context invalidated') ||
                   msg.includes('Extension context') ||
                   msg.includes('receiving end does not exist'));
  }
  function sendMsg(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          const e = chrome.runtime.lastError;
          if (e) { if (isCtxInvalid(e.message)) { window.location.reload(); return; } reject(new Error(e.message)); }
          else resolve(res);
        });
      } catch (e) {
        if (isCtxInvalid(e?.message)) { window.location.reload(); return; }
        reject(e);
      }
    });
  }

  // ─── SW → 사이드패널 수신 ─────────────────────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg.type === 'GRAPH_UPDATED') {
        if (graphScreen.classList.contains('hidden')) return;
        applyGraphData(msg);
        showSynced();
      }
      if (msg.type === 'PAGE_ACTIVE') {
        settings.localPageId = msg.pageId;
        const n = currentNodes.find(n => n.id === msg.pageId);
        settings.localPageTitle = n ? n.title : null;
        updateLocalPageInfo();
        if (settings.localMode) applyFiltersAndRender();
        // content script 탭 정보로 knownTabId/WindowId 최신화
        if (sender?.tab?.id) {
          knownTabId    = sender.tab.id;
          knownWindowId = sender.tab.windowId;
        }
      }
    });
  } catch (e) { if (isCtxInvalid(e?.message)) window.location.reload(); }

  // ─── 초기화 ────────────────────────────────────────────────────────────────
  async function init() {
    bindSettings();
    initPresets();
    initTimelineControls();
    // 수동 DB 정렬 순서 로드
    const { [DB_ORDER_KEY]: savedOrder } = await chrome.storage.local.get(DB_ORDER_KEY);
    if (Array.isArray(savedOrder)) dbOrder = savedOrder;
    try {
      const { hasToken } = await sendMsg({ type: 'GET_STATUS' });
      if (hasToken) { showScreen(graphScreen); loadGraph(); }
      else showScreen(tokenScreen);
    } catch { showScreen(tokenScreen); }
  }

  // ─── 토큰 저장 ─────────────────────────────────────────────────────────────
  tokenSave.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (!token.startsWith('ntn_') && !token.startsWith('secret_')) {
      showTokenError('토큰은 ntn_ 또는 secret_ 으로 시작해야 합니다.'); return;
    }
    hideTokenError();
    tokenSave.disabled = true; tokenSave.textContent = '저장 중...';
    try {
      const res = await sendMsg({ type: 'SET_TOKEN', token });
      if (!res.success) { showTokenError(res.error || '저장 실패'); return; }
      tokenInput.value = '';
      showScreen(graphScreen);
      loadGraph(true);
    } catch (e) { showTokenError('저장 중 오류: ' + e.message); }
    finally { tokenSave.disabled = false; tokenSave.textContent = '연결하기'; }
  });
  tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') tokenSave.click(); });

  // ─── 연결 해제 ─────────────────────────────────────────────────────────────
  btnDisconnect.addEventListener('click', async () => {
    await sendMsg({ type: 'CLEAR_TOKEN' });
    clearGraph(); showScreen(tokenScreen);
  });

  // ─── 새로고침 / 재시도 ─────────────────────────────────────────────────────
  btnRefresh.addEventListener('click', () => { searchInput.value = ''; savedZoomTransform = null; loadGraph(true); });
  btnRetry.addEventListener('click',   () => { hideError(); loadGraph(true); });

  // ─── 설정 패널 ─────────────────────────────────────────────────────────────
  btnSettings.addEventListener('click', () => {
    const open = settingsPanel.classList.toggle('hidden');
    btnSettings.classList.toggle('active', !open);
    if (!open) { populateDbFilter(); populatePresetList(); }
  });
  settingsClose.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
    btnSettings.classList.remove('active');
  });

  function bindSettings() {
    // 섹션 토글
    document.querySelectorAll('.sp-section-header').forEach(h => {
      h.addEventListener('click', () => h.closest('.sp-section').classList.toggle('collapsed'));
    });

    // 초기화
    document.getElementById('settings-reset').addEventListener('click', resetSettings);

    // DB 정렬
    const sortBtns = document.querySelectorAll('.sp-sort-btn');
    sortBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const prev = dbSortMode;
        dbSortMode = btn.dataset.sort;
        // 수동 모드로 처음 진입 시 현재 정렬 순서를 초기 순서로 저장
        if (dbSortMode === 'custom' && prev !== 'custom') {
          const pageCounts = new Map();
          currentNodes.forEach(n => pageCounts.set(n.parentDb, (pageCounts.get(n.parentDb) || 0) + 1));
          const base = prev === 'name'
            ? [...currentDbs].sort((a, b) => a.title.localeCompare(b.title, 'ko'))
            : [...currentDbs].sort((a, b) => (pageCounts.get(b.id) || 0) - (pageCounts.get(a.id) || 0));
          dbOrder = base.map(d => d.id);
          saveDbOrder();
        }
        sortBtns.forEach(b => b.classList.toggle('active', b === btn));
        populateDbFilter();
      });
    });

    const fmtInt = v => String(Math.round(v));
    const fmt1   = v => parseFloat(v).toFixed(1);
    const fmt2   = v => parseFloat(v).toFixed(2);

    function slider(id, valId, key, parse, fmt, onchange) {
      const el = document.getElementById(id);
      const vl = document.getElementById(valId);
      el.addEventListener('input', () => {
        settings[key] = parse(el.value);
        vl.textContent = fmt(settings[key]);
        onchange();
      });
    }
    function check(id, key, onchange) {
      const el = document.getElementById(id);
      el.addEventListener('change', () => { settings[key] = el.checked; onchange(); });
    }

    // 표시 (비DB 페이지)
    check ('s-show-page-nodes', 'showPageNodes',  applyFiltersAndRender);

    // 필터
    check ('s-hide-orphans',    'hideOrphans',    applyFiltersAndRender);
    slider('s-min-degree',      's-min-degree-val',      'minDegree',      parseInt,   fmtInt, applyFiltersAndRender);

    // 표시
    check ('s-show-arrows',     'showArrows',     applyFiltersAndRender);
    check ('s-show-labels',     'showLabels',     updateLabelVisibility);
    slider('s-label-threshold', 's-label-threshold-val', 'labelThreshold', parseFloat, fmt2,   updateLabelVisibility);
    slider('s-node-size',       's-node-size-val',       'nodeSizeScale',  parseFloat, fmt1,   applyFiltersAndRender);
    slider('s-link-width',      's-link-width-val',      'linkWidth',      parseFloat, fmt1,   () => {
      d3.selectAll('.link').style('stroke-width', settings.linkWidth + 'px');
    });

    // 장력
    slider('s-center-strength', 's-center-strength-val', 'centerStrength', parseFloat, fmt2,   applyFiltersAndRender);
    slider('s-repel',           's-repel-val',           'repelStrength',  parseFloat, fmt1,   applyFiltersAndRender);
    slider('s-repel-max',       's-repel-max-val',       'repelMaxDist',   parseInt,   fmtInt, applyFiltersAndRender);
    slider('s-link-strength',   's-link-strength-val',   'linkStrength',   parseFloat, fmt2,   applyFiltersAndRender);
    slider('s-link-distance',   's-link-distance-val',   'linkDistance',   parseInt,   fmtInt, applyFiltersAndRender);
  }

  function updateLabelVisibility() {
    const texts = d3.selectAll('.node text');
    if (!settings.showLabels) { texts.style('opacity', 0); return; }
    const minK = Math.pow(2, settings.labelThreshold);
    const fade = Math.max(0.01, minK * 0.35);
    const opacity = Math.min(1, Math.max(0, (currentZoomScale - (minK - fade)) / (fade * 2)));
    texts.style('opacity', opacity);
  }

  function syncSettingsUI() {
    document.getElementById('s-hide-orphans').checked    = settings.hideOrphans;
    document.getElementById('s-show-arrows').checked     = settings.showArrows;
    document.getElementById('s-show-labels').checked     = settings.showLabels;
    document.getElementById('s-show-page-nodes').checked = settings.showPageNodes;
    const fmtInt = v => String(Math.round(v));
    const fmt1   = v => parseFloat(v).toFixed(1);
    const fmt2   = v => parseFloat(v).toFixed(2);
    [
      ['s-min-degree',      's-min-degree-val',      settings.minDegree,      fmtInt],
      ['s-label-threshold', 's-label-threshold-val', settings.labelThreshold, fmt2],
      ['s-node-size',       's-node-size-val',       settings.nodeSizeScale,  fmt1],
      ['s-link-width',      's-link-width-val',       settings.linkWidth,      fmt1],
      ['s-center-strength', 's-center-strength-val', settings.centerStrength, fmt2],
      ['s-repel',           's-repel-val',           settings.repelStrength,  fmt1],
      ['s-repel-max',       's-repel-max-val',       settings.repelMaxDist,   fmtInt],
      ['s-link-strength',   's-link-strength-val',   settings.linkStrength,   fmt2],
      ['s-link-distance',   's-link-distance-val',   settings.linkDistance,   fmtInt],
    ].forEach(([id, valId, val, fmt]) => {
      document.getElementById(id).value = val;
      document.getElementById(valId).textContent = fmt(val);
    });
    populateDbFilter();
  }

  function resetSettings() {
    Object.assign(settings, DEFAULT_SETTINGS);
    settings.hiddenDbs.clear();
    syncSettingsUI();
    applyFiltersAndRender();
  }

  // ─── 프리셋 ────────────────────────────────────────────────────────────────
  const PRESET_KEY = 'graphPresets';

  async function loadPresets() {
    const r = await chrome.storage.local.get(PRESET_KEY);
    return r[PRESET_KEY] || [];
  }

  async function savePresets(presets) {
    await chrome.storage.local.set({ [PRESET_KEY]: presets });
  }

  function captureCurrentSettings() {
    return {
      ...DEFAULT_SETTINGS,
      ...Object.fromEntries(
        Object.keys(DEFAULT_SETTINGS).map(k => [k, settings[k]])
      ),
      hiddenDbs: [...settings.hiddenDbs],
    };
  }

  function applyPresetData(data) {
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (data[k] !== undefined) settings[k] = data[k];
    });
    settings.hiddenDbs = new Set(data.hiddenDbs || []);
    syncSettingsUI();
    applyFiltersAndRender();
  }

  async function populatePresetList() {
    const list = document.getElementById('preset-list');
    list.innerHTML = '';
    const presets = await loadPresets();
    if (presets.length === 0) {
      list.innerHTML = '<div style="font-size:11px;color:#444;padding:4px 2px">저장된 프리셋 없음</div>';
      return;
    }
    presets.forEach((preset, idx) => {
      const item = document.createElement('div');
      item.className = 'preset-item';

      const nameEl = document.createElement('span');
      nameEl.className = 'preset-name';
      nameEl.title = preset.name;
      nameEl.textContent = preset.name;

      const applyBtn = document.createElement('button');
      applyBtn.className = 'preset-apply-btn';
      applyBtn.textContent = '적용';
      applyBtn.addEventListener('click', () => applyPresetData(preset.data));

      const delBtn = document.createElement('button');
      delBtn.className = 'preset-del-btn';
      delBtn.title = '삭제';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', async () => {
        const ps = await loadPresets();
        ps.splice(idx, 1);
        await savePresets(ps);
        populatePresetList();
      });

      item.appendChild(nameEl);
      item.appendChild(applyBtn);
      item.appendChild(delBtn);
      list.appendChild(item);
    });
  }

  function initPresets() {
    const nameInput = document.getElementById('preset-name-input');
    document.getElementById('preset-save-btn').addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const presets = await loadPresets();
      presets.push({ name, data: captureCurrentSettings() });
      await savePresets(presets);
      nameInput.value = '';
      populatePresetList();
    });
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('preset-save-btn').click();
    });
    populatePresetList();
  }

  function getSortedDbsCustom() {
    const dbMap = new Map(currentDbs.map(d => [d.id, d]));
    const ordered = dbOrder.filter(id => dbMap.has(id)).map(id => dbMap.get(id));
    currentDbs.forEach(d => { if (!dbOrder.includes(d.id)) ordered.push(d); });
    return ordered;
  }

  async function saveDbOrder() {
    await chrome.storage.local.set({ [DB_ORDER_KEY]: dbOrder });
  }

  function populateDbFilter() {
    const list = document.getElementById('sp-db-list');
    list.innerHTML = '';
    if (currentDbs.length === 0) return;

    const pageCounts = new Map();
    currentNodes.forEach(n => pageCounts.set(n.parentDb, (pageCounts.get(n.parentDb) || 0) + 1));

    const sortedDbs =
      dbSortMode === 'name'   ? [...currentDbs].sort((a, b) => a.title.localeCompare(b.title, 'ko')) :
      dbSortMode === 'count'  ? [...currentDbs].sort((a, b) => (pageCounts.get(b.id) || 0) - (pageCounts.get(a.id) || 0)) :
      getSortedDbsCustom();

    // 전체 선택/취소
    const allLabel = document.createElement('label');
    allLabel.className = 'sp-db-item sp-db-all';
    const allCb = document.createElement('input');
    allCb.type = 'checkbox';
    function syncAllCb() {
      const h = currentDbs.filter(db => settings.hiddenDbs.has(db.id)).length;
      allCb.checked = h === 0; allCb.indeterminate = h > 0 && h < currentDbs.length;
    }
    syncAllCb();
    allCb.addEventListener('change', () => {
      if (allCb.checked) settings.hiddenDbs.clear();
      else currentDbs.forEach(db => settings.hiddenDbs.add(db.id));
      populateDbFilter(); applyFiltersAndRender();
    });
    allLabel.appendChild(allCb);
    allLabel.appendChild(document.createTextNode('전체'));
    list.appendChild(allLabel);
    list.appendChild(Object.assign(document.createElement('div'), { className: 'sp-db-divider' }));

    let dragSrcId = null;

    sortedDbs.forEach((db) => {
      const origIdx = currentDbs.findIndex(d => d.id === db.id);
      const item = document.createElement('div');
      item.className = 'sp-db-item sp-db-row';
      item.dataset.dbId = db.id;

      // 수동 정렬 드래그 핸들
      if (dbSortMode === 'custom') {
        item.draggable = true;
        const handle = document.createElement('span');
        handle.className = 'db-drag-handle';
        handle.textContent = '⠿';
        item.appendChild(handle);

        item.addEventListener('dragstart', e => {
          dragSrcId = db.id;
          e.dataTransfer.effectAllowed = 'move';
          item.classList.add('db-dragging');
        });
        item.addEventListener('dragend', () => {
          item.classList.remove('db-dragging');
          list.querySelectorAll('.db-drag-over').forEach(el => el.classList.remove('db-drag-over'));
        });
        item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('db-drag-over'); });
        item.addEventListener('dragleave', () => item.classList.remove('db-drag-over'));
        item.addEventListener('drop', e => {
          e.preventDefault();
          item.classList.remove('db-drag-over');
          if (!dragSrcId || dragSrcId === db.id) return;
          const arr = dbSortMode === 'custom' ? getSortedDbsCustom().map(d => d.id) : sortedDbs.map(d => d.id);
          // sync dbOrder with current view first
          dbOrder = arr;
          const si = dbOrder.indexOf(dragSrcId), ti = dbOrder.indexOf(db.id);
          if (si === -1 || ti === -1) return;
          dbOrder.splice(si, 1);
          dbOrder.splice(ti, 0, dragSrcId);
          saveDbOrder();
          populateDbFilter();
        });
      }

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !settings.hiddenDbs.has(db.id);
      cb.addEventListener('change', () => {
        if (cb.checked) settings.hiddenDbs.delete(db.id);
        else settings.hiddenDbs.add(db.id);
        syncAllCb(); applyFiltersAndRender();
      });

      const dot = document.createElement('span');
      dot.className = 'db-color-dot';
      dot.style.background = DB_COLORS[origIdx % DB_COLORS.length];

      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nameSpan.textContent = (db.icon ? db.icon + ' ' : '') + db.title;

      const countSpan = document.createElement('span');
      countSpan.style.cssText = 'font-size:10px;color:#444;flex-shrink:0;margin-left:4px';
      countSpan.textContent = pageCounts.get(db.id) || 0;

      item.appendChild(cb);
      item.appendChild(dot);
      item.appendChild(nameSpan);
      item.appendChild(countSpan);
      list.appendChild(item);
    });
  }

  // ─── 타임라인 ──────────────────────────────────────────────────────────────
  let tlPos     = 100; // 0~100
  let tlPlaying = false;
  let tlTimer   = null;
  let tlMinMs   = 0;
  let tlMaxMs   = 0;

  function initTimeline() {
    const dates = currentNodes
      .map(n => n.createdAt).filter(Boolean)
      .map(s => new Date(s).getTime()).filter(t => !isNaN(t));
    const slider  = document.getElementById('tl-slider');
    const playBtn = document.getElementById('tl-play');
    if (dates.length === 0) {
      slider.disabled = true; playBtn.disabled = true;
      document.getElementById('tl-date').textContent = '날짜 데이터 없음';
      return;
    }
    tlMinMs = Math.min(...dates);
    tlMaxMs = Math.max(...dates);
    slider.disabled = false; playBtn.disabled = false;
    updateTlLabel();
  }

  function updateTlLabel() {
    const ms = tlMinMs + (tlMaxMs - tlMinMs) * tlPos / 100;
    const d  = new Date(ms);
    document.getElementById('tl-date').textContent =
      tlPos >= 100 ? '전체'
        : `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
  }

  function getTlCutoff() {
    if (tlPos >= 100 || tlMinMs === 0) return null;
    return tlMinMs + (tlMaxMs - tlMinMs) * tlPos / 100;
  }

  // 시뮬레이션을 재시작하지 않고 opacity만 조절 (버벅임 방지)
  function updateTimelineVisibility() {
    const ns = window._graphNodeSel;
    const ls = window._graphLinkSel;
    if (!ns || !ls) return;
    const cutoff = getTlCutoff();
    if (cutoff === null) {
      ns.style('opacity', null);
      ls.style('opacity', null);
      return;
    }
    const visible = new Set(
      (window._graphSimNodes || [])
        .filter(n => !n.createdAt || new Date(n.createdAt).getTime() <= cutoff)
        .map(n => n.id)
    );
    ns.style('opacity', d => visible.has(d.id) ? 1 : 0);
    ls.style('opacity', e => {
      const s = typeof e.source === 'object' ? e.source.id : e.source;
      const t = typeof e.target === 'object' ? e.target.id : e.target;
      return visible.has(s) && visible.has(t) ? 1 : 0;
    });
  }

  function tlTogglePlay() {
    if (tlPlaying) {
      tlPlaying = false; clearInterval(tlTimer);
      document.getElementById('tl-play').textContent = '▶'; return;
    }
    if (tlPos >= 100) tlPos = 0;
    tlPlaying = true;
    document.getElementById('tl-play').textContent = '⏸';
    tlTimer = setInterval(() => {
      tlPos = Math.min(100, tlPos + 1);
      document.getElementById('tl-slider').value = tlPos;
      updateTlLabel();
      applyFiltersAndRender(); // 위치 저장 후 신규 노드만 랜덤 위치에서 장력 애니메이션
      if (tlPos >= 100) {
        tlPlaying = false; clearInterval(tlTimer);
        document.getElementById('tl-play').textContent = '▶';
      }
    }, 300);
  }

  function initTimelineControls() {
    document.getElementById('tl-slider').addEventListener('input', e => {
      tlPos = parseInt(e.target.value);
      updateTlLabel();
      applyFiltersAndRender();
    });
    document.getElementById('tl-play').addEventListener('click', tlTogglePlay);
  }

  // ─── 로컬 그래프 ───────────────────────────────────────────────────────────
  btnLocal.addEventListener('click', () => {
    settings.localMode = !settings.localMode;
    savedZoomTransform = null; // 모드 전환 시 줌 리셋
    btnLocal.classList.toggle('active', settings.localMode);
    localBar.classList.toggle('hidden', !settings.localMode);
    updateLocalPageInfo();
    applyFiltersAndRender();
  });

  depthSlider.addEventListener('input', () => {
    settings.localDepth = parseInt(depthSlider.value);
    depthVal.textContent = settings.localDepth;
    if (settings.localMode) applyFiltersAndRender();
  });

  function updateLocalPageInfo() {
    if (!settings.localPageId) {
      localPageName.textContent = '노션 페이지로 이동하세요';
      return;
    }
    const n = currentNodes.find(n => n.id === settings.localPageId);
    if (n) {
      settings.localPageTitle = n.title;
      localPageName.textContent = n.title;
    } else {
      localPageName.textContent = settings.localPageTitle
        ? settings.localPageTitle + ' (그래프 외부)'
        : '이 페이지는 그래프에 없습니다';
    }
  }

  // ─── 필터 적용 후 렌더 ─────────────────────────────────────────────────────
  function applyFiltersAndRender() {
    // 현재 시뮬레이션 노드 위치 저장 (re-render 시 기존 노드 위치 복원용)
    (window._graphSimNodes || []).forEach(n => {
      if (n.x != null) savedPositions.set(n.id, { x: n.x, y: n.y });
    });

    let nodes = [...currentNodes];
    let edges = [...currentEdges];

    // 0. 비DB 페이지 노드 필터
    if (!settings.showPageNodes) {
      nodes = nodes.filter(n => n.nodeType !== 'page');
      edges = edges.filter(e => e.type !== 'parent');
    }

    // 1. DB 숨기기
    if (settings.hiddenDbs.size > 0) {
      nodes = nodes.filter(n => !settings.hiddenDbs.has(n.parentDb));
      const ids = new Set(nodes.map(n => n.id));
      edges = edges.filter(e => ids.has(e.source) && ids.has(e.target));
    }

    // 2. 최소 연결 수 (필터된 그래프 기준 재계산)
    if (settings.minDegree > 0) {
      const deg = new Map();
      edges.forEach(e => {
        deg.set(e.source, (deg.get(e.source) || 0) + 1);
        deg.set(e.target, (deg.get(e.target) || 0) + 1);
      });
      nodes = nodes.filter(n => (deg.get(n.id) || 0) >= settings.minDegree);
      const ids = new Set(nodes.map(n => n.id));
      edges = edges.filter(e => ids.has(e.source) && ids.has(e.target));
    }

    // 3. 고립 노드 숨기기
    if (settings.hideOrphans) {
      const connected = new Set();
      edges.forEach(e => { connected.add(e.source); connected.add(e.target); });
      nodes = nodes.filter(n => connected.has(n.id));
    }

    // 4. 로컬 그래프
    if (settings.localMode && settings.localPageId) {
      const centerIds = getLocalSubgraphIds(settings.localPageId, nodes, edges, settings.localDepth);
      if (centerIds.size > 0) {
        nodes = nodes.filter(n => centerIds.has(n.id));
        const ids = new Set(nodes.map(n => n.id));
        edges = edges.filter(e => ids.has(e.source) && ids.has(e.target));
      } else {
        // 페이지가 필터된 그래프에 없음
        nodes = []; edges = [];
      }
    }

    // 5. 타임라인 필터
    const tlCutoff = getTlCutoff();
    if (tlCutoff !== null) {
      nodes = nodes.filter(n => !n.createdAt || new Date(n.createdAt).getTime() <= tlCutoff);
      const ids = new Set(nodes.map(n => n.id));
      edges = edges.filter(e => ids.has(e.source) && ids.has(e.target));
    }

    renderGraph(nodes, edges, currentDbs);
  }

  function getLocalSubgraphIds(centerId, nodes, edges, depth) {
    const nodeIds = new Set(nodes.map(n => n.id));
    if (!nodeIds.has(centerId)) return new Set();
    const included = new Set([centerId]);
    let frontier = new Set([centerId]);
    for (let d = 0; d < depth; d++) {
      const next = new Set();
      for (const e of edges) {
        if (frontier.has(e.source) && !included.has(e.target)) { included.add(e.target); next.add(e.target); }
        if (frontier.has(e.target) && !included.has(e.source)) { included.add(e.source); next.add(e.source); }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }
    return included;
  }

  // ─── 그래프 데이터 로드 ────────────────────────────────────────────────────
  async function loadGraph(force = false) {
    if (force) { showLoading('최신 데이터 불러오는 중…'); hideCacheIndicator(); }

    try {
      const res = await sendMsg({ type: 'FETCH_GRAPH', force });

      if (res.error === 'TOKEN_EXPIRED') {
        hideLoading(); await sendMsg({ type: 'CLEAR_TOKEN' });
        showScreen(tokenScreen); showTokenError('토큰이 만료됐습니다. 다시 입력해주세요.'); return;
      }
      if (res.error === 'NO_TOKEN') { hideLoading(); showScreen(tokenScreen); return; }
      if (res.error) {
        hideLoading();
        showError(ERR_MSG[res.error] || `오류: ${res.error}`); return;
      }
      if (res.warning === 'NO_DATABASES') {
        hideLoading();
        showWarning('접근 가능한 DB가 없습니다. Integration을 워크스페이스에 공유했는지 확인하세요.');
        clearGraph(); return;
      }

      applyGraphData(res);
      if (res.fromCache) showCacheAge(res.cachedAt);
      else { hideLoading(); if (force) showSynced(); }
    } catch (e) { hideLoading(); showError('연결 오류: ' + e.message); }
  }

  const ERR_MSG = {
    NO_ACCESS:    'Integration에 접근 권한이 없습니다.',
    RATE_LIMITED: 'API 요청 한도 초과. 잠시 후 다시 시도해주세요.',
    NOT_FOUND:    '리소스를 찾을 수 없습니다.',
  };

  function applyGraphData(res) {
    hideLoading();
    currentNodes = res.nodes || [];
    currentEdges = res.edges || [];
    currentDbs   = res.dbs   || [];
    dbCountEl.textContent = `${currentNodes.length}개 페이지 · ${currentDbs.length}개 DB`;

    // 현재 열린 탭에서 노션 페이지 ID 직접 감지
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) {
        knownWindowId = tab.windowId;
        knownTabId    = tab.id; // 노드 클릭 시 동기 navigate에 재사용
        const pid = extractPageIdFromUrl(tab.url || '');
        if (pid) {
          settings.localPageId = pid;
          const n = currentNodes.find(n => n.id === pid);
          settings.localPageTitle = n?.title || null;
        }
      }
      updateLocalPageInfo();
      populateDbFilter();
      initTimeline();
      applyFiltersAndRender();
    });
  }

  // ─── 그래프 초기화 ─────────────────────────────────────────────────────────
  function clearGraph() {
    if (simulation) simulation.stop();
    d3.select(svg).selectAll('*').remove();
    currentNodes = []; currentEdges = []; currentDbs = [];
    dbCountEl.textContent = '';
    warningBanner.classList.add('hidden');
    window._graphNodeSel = null;
    window._graphLinkSel = null;
    window._graphSimNodes = null;
  }

  // ─── D3 렌더 ───────────────────────────────────────────────────────────────
  function renderGraph(nodes, edges, dbs) {
    if (simulation) simulation.stop();
    d3.select(svg).selectAll('*').remove();
    warningBanner.classList.add('hidden');
    tooltip.classList.add('hidden');

    const W = svg.clientWidth  || svg.getBoundingClientRect().width  || 380;
    const H = svg.clientHeight || svg.getBoundingClientRect().height || 500;

    if (nodes.length === 0) return;

    // DB 색상 맵
    const dbColorMap = new Map();
    (dbs || []).forEach((db, i) => dbColorMap.set(db.id, DB_COLORS[i % DB_COLORS.length]));

    // 노드 반지름 (degree + 설정 배율)
    const maxDeg = Math.max(1, ...nodes.map(n => n.degree));
    const rScale = d3.scaleSqrt().domain([0, maxDeg]).range([4, 14]);
    const r = d => rScale(d.degree) * settings.nodeSizeScale;

    const root = d3.select(svg).attr('width', W).attr('height', H);

    // 화살표 마커 정의 (relation용 / parent용)
    const defs = root.append('defs');
    defs.append('marker').attr('id', 'arrow-end')
      .attr('viewBox', '0 -3 6 6').attr('refX', 6).attr('refY', 0)
      .attr('markerWidth', 3).attr('markerHeight', 3).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-3L6,0L0,3').attr('fill', '#5a5a6e');
    defs.append('marker').attr('id', 'arrow-start')
      .attr('viewBox', '0 -3 6 6').attr('refX', 0).attr('refY', 0)
      .attr('markerWidth', 3).attr('markerHeight', 3).attr('orient', 'auto-start-reverse')
      .append('path').attr('d', 'M0,-3L6,0L0,3').attr('fill', '#5a5a6e');
    // parent 엣지 전용 마커 (회색, 항상 표시)
    defs.append('marker').attr('id', 'arrow-parent')
      .attr('viewBox', '0 -3 6 6').attr('refX', 6).attr('refY', 0)
      .attr('markerWidth', 3).attr('markerHeight', 3).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-3L6,0L0,3').attr('fill', '#8b8b9e');

    const zoomG = root.append('g').attr('class', 'zoom-group');

    const zoom = d3.zoom().scaleExtent([0.01, 20])
      .on('zoom', e => {
        savedZoomTransform = e.transform;
        currentZoomScale   = e.transform.k;
        zoomG.attr('transform', e.transform);
        // 텍스트 크기: 줌에 반비율 적용 → 확대해도 노드보다 천천히 커짐
        zoomG.selectAll('.node text').style('font-size', `${10 / Math.pow(currentZoomScale, 0.6)}px`);
        updateLabelVisibility();
      });
    root.on('.zoom', null); // 이전 renderGraph에서 쌓인 zoom 리스너 제거
    root.call(zoom);
    // 합성 zoom 이벤트 없이 복원 — root.call(zoom.transform,...) 대신
    // svg.__zoom(D3 내부 정본값)을 직접 읽어 zoomG에 적용
    if (savedZoomTransform === null) svg.__zoom = d3.zoomIdentity; // 리셋 신호
    const restoreT = d3.zoomTransform(svg);
    currentZoomScale = restoreT.k;
    savedZoomTransform = restoreT;
    zoomG.attr('transform', restoreT);

    // 기존 노드: 저장된 위치 복원, 신규 노드: 중심 근처 랜덤 위치 (장력 애니메이션 시작점)
    const simNodes = nodes.map(n => {
      const saved = savedPositions.get(n.id);
      if (saved) return { ...n, x: saved.x, y: saved.y };
      const angle = Math.random() * 2 * Math.PI;
      const dist  = 40 + Math.random() * 120;
      return { ...n, x: W / 2 + Math.cos(angle) * dist, y: H / 2 + Math.sin(angle) * dist };
    });
    const hasNewNodes = nodes.some(n => !savedPositions.has(n.id));

    const simEdges = edges
      .filter(e => simNodes.some(n => n.id === e.source) && simNodes.some(n => n.id === e.target))
      .map(e => ({ ...e }));

    const linkSel = zoomG.append('g').attr('class', 'links')
      .selectAll('line').data(simEdges).enter().append('line')
      .attr('class', d => `link ${d.type || 'relation'}`)
      .style('stroke-width', settings.linkWidth + 'px')
      .attr('marker-end', d => {
        if (d.type === 'parent') return 'url(#arrow-parent)';
        return settings.showArrows ? 'url(#arrow-end)' : null;
      })
      .attr('marker-start', d => {
        if (d.type === 'parent') return null;
        return settings.showArrows && d.bidirectional ? 'url(#arrow-start)' : null;
      });

    const nodeSel = zoomG.append('g').attr('class', 'nodes')
      .selectAll('g').data(simNodes).enter().append('g')
      .attr('class', 'node')
      .call(makeDrag());

    nodeSel.append('circle')
      .attr('r', d => {
        const base = r(d);
        return (settings.localMode && d.id === settings.localPageId) ? base + 4 : base;
      })
      .attr('fill', d => d.nodeType === 'page' ? '#7e7e9a' : (dbColorMap.get(d.parentDb) || '#6366f1'))
      .classed('page-node', d => d.nodeType === 'page')
      .classed('local-center', d => settings.localMode && d.id === settings.localPageId);

    const initFontSize = `${10 / Math.pow(Math.max(0.1, currentZoomScale), 0.6)}px`;
    nodeSel.append('text')
      .attr('dy', d => r(d) + 10)
      .attr('text-anchor', 'middle')
      .text(d => trunc(d.title, 16))
      .style('font-size', initFontSize)
      .classed('local-center', d => settings.localMode && d.id === settings.localPageId);

    updateLabelVisibility();

    // 신규 노드가 있을 때만 충분한 alpha로 장력 애니메이션, 기존 노드만 있으면 미세 재정착
    simulation = d3.forceSimulation(simNodes)
      .alpha(hasNewNodes ? 0.5 : 0.1)
      .alphaDecay(hasNewNodes ? 0.008 : 0.03) // 낮은 decay → 더 오래 움직임 (장력 효과 가시화)
      .force('link',      d3.forceLink(simEdges).id(d => d.id)
               .distance(settings.linkDistance).strength(settings.linkStrength))
      .force('charge',    d3.forceManyBody().strength(-settings.repelStrength * 25).distanceMax(settings.repelMaxDist))
      .force('center',    d3.forceCenter(W / 2, H / 2).strength(settings.centerStrength))
      .force('collision', d3.forceCollide().radius(d => r(d) + 5))
      .on('tick', () => {
        if (settings.showArrows) {
          linkSel.each(function(d) {
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const tr = r(d.target) + 5, sr = d.bidirectional ? r(d.source) + 5 : 0;
            d3.select(this)
              .attr('x1', d.source.x + dx / dist * sr)
              .attr('y1', d.source.y + dy / dist * sr)
              .attr('x2', d.target.x - dx / dist * tr)
              .attr('y2', d.target.y - dy / dist * tr);
          });
        } else {
          linkSel.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
                 .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        }
        nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
      });

    // 인접 맵
    const nbMap = new Map();
    simEdges.forEach(e => {
      const s = e.source.id || e.source, t = e.target.id || e.target;
      if (!nbMap.has(s)) nbMap.set(s, new Set());
      if (!nbMap.has(t)) nbMap.set(t, new Set());
      nbMap.get(s).add(t); nbMap.get(t).add(s);
    });

    // 호버
    nodeSel
      .on('mouseenter', (event, d) => {
        if (draggingNode) return; // 드래그 중 다른 노드에 hover 금지
        const nb = nbMap.get(d.id) || new Set();
        nodeSel.selectAll('circle')
          .classed('highlighted', n => n.id === d.id || nb.has(n.id))
          .classed('faded',       n => n.id !== d.id && !nb.has(n.id));
        nodeSel.selectAll('text')
          .classed('highlighted', n => n.id === d.id || nb.has(n.id))
          .classed('faded',       n => n.id !== d.id && !nb.has(n.id));
        linkSel.classed('highlighted', e => {
            const s = e.source.id || e.source, t = e.target.id || e.target;
            return s === d.id || t === d.id;
          }).classed('faded', e => {
            const s = e.source.id || e.source, t = e.target.id || e.target;
            return s !== d.id && t !== d.id;
          });

        const nbNodes = Array.from(nb).map(id => simNodes.find(n => n.id === id)).filter(Boolean).slice(0, 7);
        const col = dbColorMap.get(d.parentDb) || '#6366f1';
        let html = `<div class="tooltip-title">${trunc(d.title, 30)}</div>`;
        html += `<div class="tooltip-db" style="color:${col}">${d.parentDbIcon ? d.parentDbIcon + ' ' : '📁'}${trunc(d.parentDbTitle, 22)}</div>`;
        html += nbNodes.length
          ? `<div class="tooltip-neighbors">연결: ${nbNodes.map(n => `<span class="tooltip-neighbor">${trunc(n.title, 14)}</span>`).join(', ')}${nb.size > 7 ? ` 외 ${nb.size - 7}개` : ''}</div>`
          : `<div class="tooltip-neighbors">연결된 페이지 없음</div>`;
        tooltip.innerHTML = html;
        tooltip.classList.remove('hidden');
        positionTooltip(event);
      })
      .on('mousemove', e => positionTooltip(e))
      .on('mouseleave', () => {
        if (draggingNode) return; // 드래그 중에는 highlight 유지
        nodeSel.selectAll('circle').classed('highlighted', false).classed('faded', false);
        nodeSel.selectAll('text').classed('highlighted', false).classed('faded', false);
        linkSel.classed('highlighted', false).classed('faded', false);
        tooltip.classList.add('hidden');
        if (activeSearch) applySearchHighlight(activeSearch); // 검색 강조 복원
      });

    window._graphNodeSel  = nodeSel;
    window._graphLinkSel  = linkSel;
    window._graphSimNodes = simNodes;
  }

  // ─── 툴팁 위치 ─────────────────────────────────────────────────────────────
  function positionTooltip(event) {
    const rect = svg.getBoundingClientRect();
    const pw = document.body.clientWidth;
    let x = event.clientX - rect.left + 12;
    let y = event.clientY - rect.top  + 12;
    if (x + 240 > pw) x = event.clientX - rect.left - 240;
    tooltip.style.left = x + 'px';
    tooltip.style.top  = y + 'px';
  }

  // ─── 드래그 ────────────────────────────────────────────────────────────────
  function makeDrag() {
    return d3.drag()
      .on('start', (e, d) => {
        draggingNode = d;
        // 화면 픽셀 기준으로 저장 (그래프 좌표계는 줌에 따라 달라지므로)
        d._dragStartCX = e.sourceEvent?.clientX ?? 0;
        d._dragStartCY = e.sourceEvent?.clientY ?? 0;
        d._dragMoved   = false;
        if (!e.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (e, d) => {
        const dx = (e.sourceEvent?.clientX ?? 0) - d._dragStartCX;
        const dy = (e.sourceEvent?.clientY ?? 0) - d._dragStartCY;
        if (dx * dx + dy * dy > 25) d._dragMoved = true; // 화면 5px 이상이면 드래그
        d.fx = e.x; d.fy = e.y;
      })
      .on('end', (e, d) => {
        const wasDrag = d._dragMoved;
        draggingNode  = null;
        d._dragMoved  = false;
        if (!e.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
        if (!wasDrag) {
          if (!d.url) {
            console.warn('[notion-graph] 클릭한 노드에 url 없음:', d.id, d.title);
            return;
          }
          if (knownTabId) {
            chrome.tabs.update(knownTabId, { url: d.url }, () => {
              if (chrome.runtime.lastError) {
                console.warn('[notion-graph] tabs.update 실패, 새 탭 열기:', chrome.runtime.lastError.message);
                chrome.tabs.create({ url: d.url });
              }
            });
          } else {
            console.warn('[notion-graph] knownTabId 없음, 새 탭 열기');
            chrome.tabs.create({ url: d.url });
          }
        }
      });
  }

  // ─── 검색 ──────────────────────────────────────────────────────────────────
  function applySearchHighlight(q) {
    const ns = window._graphNodeSel, ls = window._graphLinkSel;
    if (!ns) return;
    if (!q) {
      ns.selectAll('circle').classed('search-match', false).classed('faded', false);
      ns.selectAll('text').classed('search-match', false).classed('faded', false);
      if (ls) ls.classed('faded', false);
      return;
    }
    const match = n => n.title.toLowerCase().includes(q) || (n.parentDbTitle || '').toLowerCase().includes(q);
    ns.selectAll('circle').classed('search-match', d => match(d)).classed('faded', d => !match(d));
    ns.selectAll('text').classed('search-match', d => match(d)).classed('faded', d => !match(d));
    if (ls) ls.classed('faded', true);
  }

  searchInput.addEventListener('input', () => {
    activeSearch = searchInput.value.trim().toLowerCase();
    applySearchHighlight(activeSearch);
    if (activeSearch) {
      const match = n => n.title.toLowerCase().includes(activeSearch) || (n.parentDbTitle || '').toLowerCase().includes(activeSearch);
      const first = (window._graphSimNodes || []).find(match);
      if (first?.x != null) {
        const W = svg.clientWidth || 380, H = svg.clientHeight || 500;
        d3.select(svg).call(
          d3.zoom().scaleExtent([0.05, 10]).transform,
          d3.zoomIdentity.translate(W / 2 - first.x, H / 2 - first.y)
        );
      }
    }
  });

  // ─── 리사이즈 (디바운스: 드래그 중 재렌더 방지) ──────────────────────────
  let _resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (currentNodes.length > 0 && !graphScreen.classList.contains('hidden'))
        applyFiltersAndRender();
    }, 150);
  }).observe(svg);

  // ─── 유틸 ──────────────────────────────────────────────────────────────────
  function trunc(s, n) { if (!s) return ''; return s.length > n ? s.slice(0, n) + '…' : s; }

  // ─── 시작 ──────────────────────────────────────────────────────────────────
  init();

})();
