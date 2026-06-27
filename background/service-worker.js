const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const MAX_RETRIES = 3;
const MAX_PAGES_PER_DB = 500;
const CACHE_KEY = 'graphCache';
const CACHE_VERSION = 2; // 형식 변경 시 증가 → 구 캐시 자동 무효화

// ─── 아이콘 클릭 → 사이드패널 바로 열기 ──────────────────────────────────────

if (chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// ─── 캐시 ────────────────────────────────────────────────────────────────────

async function getCachedGraph() {
  const result = await chrome.storage.local.get(CACHE_KEY);
  const cache = result[CACHE_KEY];
  if (!cache || cache.version !== CACHE_VERSION) return null;
  return cache;
}

async function setCachedGraph(data) {
  await chrome.storage.local.set({
    [CACHE_KEY]: {
      version: CACHE_VERSION,
      nodes: data.nodes,
      edges: data.edges,
      dbs: data.dbs,
      cachedAt: Date.now(),
    },
  });
}

async function clearCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}

// ─── 백그라운드 갱신 (중복 방지 플래그) ──────────────────────────────────────

let isRefreshing = false;

async function backgroundRefresh(token) {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    const graph = await buildGraphData(token);
    await setCachedGraph(graph);
    chrome.runtime.sendMessage({
      type: 'GRAPH_UPDATED',
      nodes: graph.nodes,
      edges: graph.edges,
      dbs: graph.dbs,
      cachedAt: Date.now(),
    }).catch(() => {}); // 사이드패널이 닫혀 있으면 무시
  } catch (err) {
    console.warn('[notion-graph] 백그라운드 갱신 실패:', err.message);
  } finally {
    isRefreshing = false;
  }
}

// ─── Token ───────────────────────────────────────────────────────────────────

async function getToken() {
  const { notionToken } = await chrome.storage.local.get('notionToken');
  return notionToken || null;
}

// ─── Core fetch (429 retry) ───────────────────────────────────────────────────

async function notionFetch(path, token, options = {}, retryCount = 0) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (res.status === 429) {
    if (retryCount >= MAX_RETRIES) throw new Error('RATE_LIMITED');
    const wait = (parseInt(res.headers.get('Retry-After') || '2') || 2) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return notionFetch(path, token, options, retryCount + 1);
  }
  if (res.status === 401) throw new Error('TOKEN_EXPIRED');
  if (res.status === 403) throw new Error('NO_ACCESS');
  if (res.status === 404) throw new Error('NOT_FOUND');
  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);
  return res.json();
}

// ─── DB 목록 ─────────────────────────────────────────────────────────────────

async function fetchAllDatabases(token) {
  const databases = [];
  let cursor;
  do {
    const body = { filter: { value: 'database', property: 'object' }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch('/search', token, { method: 'POST', body: JSON.stringify(body) });
    for (const item of data.results) {
      if (item.object === 'database' && !item.archived) databases.push(item);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return databases;
}

// ─── DB 내 페이지 목록 ────────────────────────────────────────────────────────

async function queryAllPages(dbId, token) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${dbId}/query`, token, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const item of data.results) {
      if (item.object === 'page' && !item.archived) pages.push(item);
    }
    cursor = (data.has_more && pages.length < MAX_PAGES_PER_DB)
      ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// ─── 제목 추출 ────────────────────────────────────────────────────────────────

function extractDbTitle(db) {
  return (db.title || []).map(t => t.plain_text).join('').trim() || '(Untitled DB)';
}

function extractPageTitle(page) {
  for (const prop of Object.values(page.properties || {})) {
    if (prop.type === 'title') {
      return (prop.title || []).map(t => t.plain_text).join('').trim();
    }
  }
  return '';
}

function extractIcon(db) {
  return db.icon?.type === 'emoji' ? db.icon.emoji : null;
}

// ─── 그래프 데이터 빌드 ───────────────────────────────────────────────────────

async function buildGraphData(token) {
  const databases = await fetchAllDatabases(token);
  if (databases.length === 0) return { nodes: [], edges: [], dbs: [], warning: 'NO_DATABASES' };

  const dbInfoMap = new Map();
  for (const db of databases) {
    const id = db.id.replace(/-/g, '');
    dbInfoMap.set(id, { id, notionId: db.id, title: extractDbTitle(db), icon: extractIcon(db) });
  }

  const pageNodes = new Map();
  const edgeSet = new Set();
  const edges = [];

  for (const dbInfo of dbInfoMap.values()) {
    let pages;
    try {
      pages = await queryAllPages(dbInfo.notionId, token);
    } catch (err) {
      console.warn(`[notion-graph] DB "${dbInfo.title}" 조회 실패: ${err.message}`);
      continue;
    }

    for (const page of pages) {
      const pageId = page.id.replace(/-/g, '');
      pageNodes.set(pageId, {
        id: pageId,
        title: extractPageTitle(page) || '(제목 없음)',
        url: page.url,
        parentDb: dbInfo.id,
        parentDbTitle: dbInfo.title,
        parentDbIcon: dbInfo.icon,
        createdAt: page.created_time || null,
        degree: 0,
      });

      for (const [propName, propValue] of Object.entries(page.properties || {})) {
        if (propValue.type !== 'relation') continue;
        for (const rel of (propValue.relation || [])) {
          const targetId = rel.id.replace(/-/g, '');
          const canonical = [pageId, targetId].sort().join('|');
          if (edgeSet.has(canonical)) {
            // 이미 반대 방향 엣지가 있으면 양방향으로 표시
            const existing = edges.find(e => [e.source, e.target].sort().join('|') === canonical);
            if (existing) existing.bidirectional = true;
            continue;
          }
          edgeSet.add(canonical);
          edges.push({ source: pageId, target: targetId, label: propName, bidirectional: false });
        }
      }
    }
  }

  const degreeMap = new Map();
  for (const { source, target } of edges) {
    degreeMap.set(source, (degreeMap.get(source) || 0) + 1);
    degreeMap.set(target, (degreeMap.get(target) || 0) + 1);
  }

  const nodes = Array.from(pageNodes.values()).map(n => ({
    ...n,
    degree: degreeMap.get(n.id) || 0,
  }));
  const validEdges = edges.filter(e => pageNodes.has(e.source) && pageNodes.has(e.target));
  const dbs = Array.from(dbInfoMap.values()).map(d => ({ id: d.id, title: d.title, icon: d.icon }));

  return { nodes, edges: validEdges, dbs };
}

// ─── 메시지 핸들러 ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    case 'SET_TOKEN': {
      const token = message.token;
      if (!token || (!token.startsWith('ntn_') && !token.startsWith('secret_'))) {
        sendResponse({ success: false, error: 'INVALID_TOKEN_FORMAT' });
        break;
      }
      // 토큰 변경 시 캐시 초기화
      clearCache().then(() =>
        chrome.storage.local.set({ notionToken: token }, () => sendResponse({ success: true }))
      );
      return true;
    }

    case 'CLEAR_TOKEN': {
      clearCache().then(() =>
        chrome.storage.local.remove('notionToken', () => sendResponse({ success: true }))
      );
      return true;
    }

    case 'GET_STATUS': {
      getToken()
        .then(token => sendResponse({ hasToken: !!token }))
        .catch(() => sendResponse({ hasToken: false }));
      return true;
    }

    case 'FETCH_GRAPH': {
      const force = message.force === true;
      handleFetchGraph(force, sendResponse);
      return true;
    }

    case 'PAGE_ACTIVE': {
      // content-script → SW → side panel relay
      chrome.runtime.sendMessage({ type: 'PAGE_ACTIVE', pageId: message.pageId }).catch(() => {});
      break;
    }

    default:
      break;
  }
});

async function handleFetchGraph(force, sendResponse) {
  const token = await getToken();
  if (!token) { sendResponse({ error: 'NO_TOKEN' }); return; }

  // 강제 갱신이 아니면 캐시 먼저 반환
  if (!force) {
    const cached = await getCachedGraph();
    if (cached) {
      sendResponse({ nodes: cached.nodes, edges: cached.edges, dbs: cached.dbs,
                     fromCache: true, cachedAt: cached.cachedAt });
      // 캐시 반환 후 백그라운드에서 최신 데이터 패치
      backgroundRefresh(token);
      return;
    }
  }

  // 캐시 없거나 강제 갱신: 직접 패치 후 응답
  try {
    const graph = await buildGraphData(token);
    await setCachedGraph(graph);
    sendResponse({ nodes: graph.nodes, edges: graph.edges, dbs: graph.dbs,
                   fromCache: false, cachedAt: Date.now() });
  } catch (err) {
    if (err.message === 'TOKEN_EXPIRED') {
      await chrome.storage.local.remove('notionToken');
      sendResponse({ error: 'TOKEN_EXPIRED' });
      return;
    }
    // 패치 실패 시 만료된 캐시라도 반환
    const stale = await getCachedGraph();
    if (stale) {
      sendResponse({ nodes: stale.nodes, edges: stale.edges, dbs: stale.dbs,
                     fromCache: true, stale: true, cachedAt: stale.cachedAt });
    } else {
      sendResponse({ error: err.message || 'UNKNOWN_ERROR' });
    }
  }
}
