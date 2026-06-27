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

  const DEFAULT_SETTINGS = {
    hideOrphans:    false,
    minDegree:      0,
    nodeSizeScale:  1.0,
    showLabels:     true,
    labelThreshold: 0,
    showArrows:     false,
    linkWidth:      1.5,
    linkDistance:   70,
    repelStrength:  180,
    centerStrength: 0.52,
    linkStrength:   0.5,
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
    chrome.runtime.onMessage.addListener((msg) => {
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
      }
    });
  } catch (e) { if (isCtxInvalid(e?.message)) window.location.reload(); }

  // ─── 초기화 ────────────────────────────────────────────────────────────────
  async function init() {
    bindSettings();
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
    if (!open) populateDbFilter(); // DB 목록 최신화
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
    slider('s-repel',           's-repel-val',           'repelStrength',  parseInt,   fmtInt, applyFiltersAndRender);
    slider('s-link-strength',   's-link-strength-val',   'linkStrength',   parseFloat, fmt2,   applyFiltersAndRender);
    slider('s-link-distance',   's-link-distance-val',   'linkDistance',   parseInt,   fmtInt, applyFiltersAndRender);
  }

  function updateLabelVisibility() {
    if (!settings.showLabels) {
      d3.selectAll('.node text').style('display', 'none');
    } else {
      const minK = Math.pow(2, settings.labelThreshold);
      d3.selectAll('.node text').style('display', currentZoomScale >= minK ? null : 'none');
    }
  }

  function syncSettingsUI() {
    document.getElementById('s-hide-orphans').checked  = settings.hideOrphans;
    document.getElementById('s-show-arrows').checked   = settings.showArrows;
    document.getElementById('s-show-labels').checked   = settings.showLabels;
    const fmtInt = v => String(Math.round(v));
    const fmt1   = v => parseFloat(v).toFixed(1);
    const fmt2   = v => parseFloat(v).toFixed(2);
    [
      ['s-min-degree',      's-min-degree-val',      settings.minDegree,      fmtInt],
      ['s-label-threshold', 's-label-threshold-val', settings.labelThreshold, fmt2],
      ['s-node-size',       's-node-size-val',       settings.nodeSizeScale,  fmt1],
      ['s-link-width',      's-link-width-val',       settings.linkWidth,      fmt1],
      ['s-center-strength', 's-center-strength-val', settings.centerStrength, fmt2],
      ['s-repel',           's-repel-val',           settings.repelStrength,  fmtInt],
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

  function populateDbFilter() {
    const list = document.getElementById('sp-db-list');
    list.innerHTML = '';
    if (currentDbs.length === 0) return;

    // 전체 선택/취소 마스터 체크박스
    const allLabel = document.createElement('label');
    allLabel.className = 'sp-db-item sp-db-all';
    const allCb = document.createElement('input');
    allCb.type = 'checkbox';

    function syncAllCb() {
      const hiddenCount = currentDbs.filter(db => settings.hiddenDbs.has(db.id)).length;
      allCb.checked       = hiddenCount === 0;
      allCb.indeterminate = hiddenCount > 0 && hiddenCount < currentDbs.length;
    }
    syncAllCb();

    allCb.addEventListener('change', () => {
      if (allCb.checked) settings.hiddenDbs.clear();
      else currentDbs.forEach(db => settings.hiddenDbs.add(db.id));
      populateDbFilter();
      applyFiltersAndRender();
    });
    allLabel.appendChild(allCb);
    allLabel.appendChild(document.createTextNode('전체'));
    list.appendChild(allLabel);

    const divider = document.createElement('div');
    divider.className = 'sp-db-divider';
    list.appendChild(divider);

    // 개별 DB 체크박스
    currentDbs.forEach((db, i) => {
      const label = document.createElement('label');
      label.className = 'sp-db-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !settings.hiddenDbs.has(db.id);
      cb.addEventListener('change', () => {
        if (cb.checked) settings.hiddenDbs.delete(db.id);
        else settings.hiddenDbs.add(db.id);
        syncAllCb();
        applyFiltersAndRender();
      });

      const dot = document.createElement('span');
      dot.className = 'db-color-dot';
      dot.style.background = DB_COLORS[i % DB_COLORS.length];

      label.appendChild(cb);
      label.appendChild(dot);
      label.appendChild(document.createTextNode(
        (db.icon ? db.icon + ' ' : '') + db.title
      ));
      list.appendChild(label);
    });
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
    let nodes = [...currentNodes];
    let edges = [...currentEdges];

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
    updateLocalPageInfo();
    populateDbFilter();
    applyFiltersAndRender();
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

    // 화살표 마커 정의
    const defs = root.append('defs');
    defs.append('marker').attr('id', 'arrow-end')
      .attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#4a4a5a');
    defs.append('marker').attr('id', 'arrow-start')
      .attr('viewBox', '0 -4 8 8').attr('refX', 0).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto-start-reverse')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#4a4a5a');

    const zoomG = root.append('g').attr('class', 'zoom-group');

    const zoom = d3.zoom().scaleExtent([0.05, 10])
      .on('zoom', e => {
        savedZoomTransform = e.transform;
        currentZoomScale   = e.transform.k;
        zoomG.attr('transform', e.transform);
        updateLabelVisibility();
      });
    root.call(zoom);
    if (savedZoomTransform) {
      currentZoomScale = savedZoomTransform.k;
      root.call(zoom.transform, savedZoomTransform);
    }

    const simNodes = nodes.map(n => ({ ...n }));
    const simEdges = edges
      .filter(e => simNodes.some(n => n.id === e.source) && simNodes.some(n => n.id === e.target))
      .map(e => ({ ...e }));

    const linkSel = zoomG.append('g').attr('class', 'links')
      .selectAll('line').data(simEdges).enter().append('line')
      .attr('class', 'link')
      .style('stroke-width', settings.linkWidth + 'px')
      .attr('marker-end',   settings.showArrows ? 'url(#arrow-end)'   : null)
      .attr('marker-start', settings.showArrows ? d => d.bidirectional ? 'url(#arrow-start)' : null : null);

    const nodeSel = zoomG.append('g').attr('class', 'nodes')
      .selectAll('g').data(simNodes).enter().append('g')
      .attr('class', 'node')
      .call(makeDrag());

    nodeSel.append('circle')
      .attr('r', d => {
        const base = r(d);
        return (settings.localMode && d.id === settings.localPageId) ? base + 4 : base;
      })
      .attr('fill', d => dbColorMap.get(d.parentDb) || '#6366f1')
      .classed('local-center', d => settings.localMode && d.id === settings.localPageId);

    nodeSel.append('text')
      .attr('dy', d => r(d) + 10)
      .attr('text-anchor', 'middle')
      .text(d => trunc(d.title, 16))
      .classed('local-center', d => settings.localMode && d.id === settings.localPageId);

    updateLabelVisibility();

    simulation = d3.forceSimulation(simNodes)
      .force('link',      d3.forceLink(simEdges).id(d => d.id)
               .distance(settings.linkDistance).strength(settings.linkStrength))
      .force('charge',    d3.forceManyBody().strength(-settings.repelStrength))
      .force('center',    d3.forceCenter(W / 2, H / 2).strength(settings.centerStrength))
      .force('collision', d3.forceCollide().radius(d => r(d) + 5))
      .on('tick', () => {
        if (settings.showArrows) {
          linkSel.each(function(d) {
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const tr = r(d.target) + 9, sr = d.bidirectional ? r(d.source) + 9 : 0;
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

    // 클릭 → 현재 탭을 해당 노션 페이지로 이동
    nodeSel.on('click', async (_e, d) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.update(tab.id, { url: d.url });
      else chrome.tabs.create({ url: d.url });
    });

    // 호버
    nodeSel
      .on('mouseenter', (event, d) => {
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
        nodeSel.selectAll('circle').classed('highlighted', false).classed('faded', false);
        nodeSel.selectAll('text').classed('highlighted', false).classed('faded', false);
        linkSel.classed('highlighted', false).classed('faded', false);
        tooltip.classList.add('hidden');
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
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; });
  }

  // ─── 검색 ──────────────────────────────────────────────────────────────────
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const ns = window._graphNodeSel, ls = window._graphLinkSel;
    if (!ns) return;
    if (!q) {
      ns.selectAll('circle').classed('search-match', false).classed('faded', false);
      ns.selectAll('text').classed('search-match', false).classed('faded', false);
      if (ls) ls.classed('faded', false); return;
    }
    const match = n => n.title.toLowerCase().includes(q) || (n.parentDbTitle || '').toLowerCase().includes(q);
    ns.selectAll('circle').classed('search-match', d => match(d)).classed('faded', d => !match(d));
    ns.selectAll('text').classed('search-match', d => match(d)).classed('faded', d => !match(d));
    if (ls) ls.classed('faded', true);
    const first = (window._graphSimNodes || []).find(match);
    if (first?.x != null) {
      const W = svg.clientWidth || 380, H = svg.clientHeight || 500;
      d3.select(svg).call(
        d3.zoom().scaleExtent([0.05, 10]).transform,
        d3.zoomIdentity.translate(W / 2 - first.x, H / 2 - first.y)
      );
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
