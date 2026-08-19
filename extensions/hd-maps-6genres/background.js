// background.js  v3.4.0 (共通スキーマ対応版)

const downloadedRunIds = new Set();

// =====================================================================
// CSVヘッダー定義 (共通スキーマ + デバッグ項目)
// =====================================================================
const CSV_HEADERS = [
  '店名', 'ジャンル', '検索ジャンル', '取得元ジャンル', '都道府県', '市区町村', '住所', '電話番号',
  '定休日', '営業日', '営業開始A', '営業終了A', '営業開始B', '営業終了B',
  '営業時間原文', 'URL', 'HP有無', '媒体', '取得元URL', '取得日時',
  '検索エリア', '検索クエリ', 'Googleマップジャンル', '取得モード', '取得ステータス'
];

function normalizeExportRecord(item) {
  return {
    name: item.name || '',
    genre: item.genre || '',
    sourceGenre: item.sourceGenre || '',
    prefecture: item.prefecture || '',
    city: item.city || '',
    subArea: item.subArea || '',
    address: item.address || '',
    phone: item.phone || '',
    regularHoliday: item.regularHoliday || '',
    businessDays: item.businessDays || '',
    openTimeA: item.openTimeA || '',
    closeTimeA: item.closeTimeA || '',
    openTimeB: item.openTimeB || '',
    closeTimeB: item.closeTimeB || '',
    rawHours: item.rawHours || '',
    url: item.url || '',
    hasWebsite: item.hasWebsite || '無',
    source: item.source || 'GoogleMap',
    sourceUrl: item.sourceUrl || '',
    scrapedAt: item.scrapedAt || '',
    area: item.area || item.searchArea || '',
    searchGenre: item.searchGenre || '',
    searchKey: item.searchKey || '',
    searchQuery: item.searchQuery || '',
    googleGenre: item.googleGenre || item.sourceGenre || '',
    scrapeMode: item.scrapeMode || '',
    rangeMode: item.rangeMode || '',
    acquisitionStatus: item.acquisitionStatus || '取得成功',
    excludeReason: item.excludeReason || '',
    detailRetryCount: item.detailRetryCount ?? '',
    listRank: item.listRank ?? ''
  };
}

function escapeCsvValue(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildCsvContent(data) {
  let csv = '\uFEFF' + CSV_HEADERS.join(',') + '\n';
  data.forEach(item => {
    const r = normalizeExportRecord(item);
    csv += [
      escapeCsvValue(r.name),
      escapeCsvValue(r.genre),
      escapeCsvValue(r.searchGenre),
      escapeCsvValue(r.sourceGenre),
      escapeCsvValue(r.prefecture),
      escapeCsvValue(r.city),
      escapeCsvValue(r.address),
      escapeCsvValue(r.phone),
      escapeCsvValue(r.regularHoliday),
      escapeCsvValue(r.businessDays),
      escapeCsvValue(r.openTimeA),
      escapeCsvValue(r.closeTimeA),
      escapeCsvValue(r.openTimeB),
      escapeCsvValue(r.closeTimeB),
      escapeCsvValue(r.rawHours),
      escapeCsvValue(r.url),
      escapeCsvValue(r.hasWebsite),
      escapeCsvValue(r.source),
      escapeCsvValue(r.sourceUrl),
      escapeCsvValue(r.scrapedAt),
      escapeCsvValue(r.area),
      escapeCsvValue(r.searchQuery || r.searchKey),
      escapeCsvValue(r.googleGenre),
      escapeCsvValue(r.scrapeMode),
      escapeCsvValue(r.acquisitionStatus)
    ].join(',') + '\n';
  });
  return csv;
}

// =====================================================================
// ファイル名生成
// 形式: [ジャンル1_ジャンル2_...]_[地域名].csv
// =====================================================================
function buildFilename(query, filterConfig, targetGenres) {
  const trimmed = (query || '').trim();
  const { area } = trimmed ? parseQueryToAreaGenre(trimmed) : { area: '' };
  const areaStr = sanitizeFilename(area);

  let genres = [];
  if (Array.isArray(targetGenres)) {
    genres = targetGenres.map(g => g.trim()).filter(Boolean);
  } else if (typeof targetGenres === 'string' && targetGenres.trim()) {
    genres = targetGenres.split(/[\n,]/).map(g => g.trim()).filter(Boolean);
  }
  const genreStr = genres.map(g => sanitizeFilename(g)).filter(Boolean).join('_');

  if (genreStr && areaStr) return `${genreStr}_${areaStr}.csv`;
  if (genreStr) return `${genreStr}.csv`;
  if (areaStr) return `${areaStr}.csv`;
  return `Googleマップ.csv`;
}

// =====================================================================
// クエリ解析（エリア / ジャンル 分離）
// =====================================================================
function parseQueryToAreaGenre(query) {
  if (query.includes('✖️') || query.includes('×')) {
    const sep = query.includes('✖️') ? '✖️' : '×';
    const parts = query.split(sep).map(s => s.trim()).filter(Boolean);
    const ai = parts.findIndex(p => isAreaToken(p));
    if (ai !== -1) return { area: parts[ai], genre: parts.find((_, i) => i !== ai) || '' };
    return { area: parts[0] || '', genre: parts[1] || '' };
  }

  const tokens = query.split(/[\s\u3000]+/).filter(Boolean);
  if (!tokens.length) return { area: '', genre: '' };
  if (tokens.length === 1) {
    return isAreaToken(tokens[0])
      ? { area: tokens[0], genre: '' }
      : { area: '', genre: tokens[0] };
  }

  let areaTokens = [], genreTokens = [], switched = false;
  for (const t of tokens) {
    if (!switched && isAreaToken(t)) areaTokens.push(t);
    else { switched = true; genreTokens.push(t); }
  }
  if (!areaTokens.length) { areaTokens = [tokens[0]]; genreTokens = tokens.slice(1); }
  return { area: areaTokens.join(''), genre: genreTokens.join('') };
}

function isAreaToken(token) {
  if (/[市区町村都府道県]$/.test(token)) return true;
  const list = [
    '北海道', '東京', '大阪', '京都', '神奈川', '愛知', '福岡', '沖縄',
    '埼玉', '千葉', '兵庫', '静岡', '茨城', '広島', '宮城',
    '渋谷', '新宿', '池袋', '銀座', '品川', '秋葉原', '浅草', '上野',
    '吉祥寺', '横浜', '梅田', '難波', '心斎橋', '天王寺', '栄',
    '名古屋', '博多', '天神', '札幌', '仙台', '神戸', '川崎', '船橋',
  ];
  return list.includes(token);
}

function sanitizeFilename(str) {
  return String(str || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50);
}

function formatTimestamp(date = new Date()) {
  const z = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${z(date.getMonth() + 1)}${z(date.getDate())}_${z(date.getHours())}${z(date.getMinutes())}`;
}

function splitAreaText(area) {
  const text = String(area || '').replace(/\s+/g, '').trim();
  const m = text.match(/^((?:北海道|東京都|大阪府|京都府|.{2,3}県))?((?:.+?郡.+?[町村]|.+?市.+?区|.+?[市区町村]))?/);
  return {
    prefecture: m?.[1] || '',
    city: m?.[2] || text
  };
}

function exportAreaParts(record, fallback = {}) {
  const fallbackArea = splitAreaText(fallback.area || '');
  const searchArea = splitAreaText(record.area || record.searchArea || '');
  const pref = searchArea.prefecture || record.prefecture || fallback.prefecture || fallbackArea.prefecture || '';
  const city = searchArea.city || record.city || fallback.city || fallbackArea.city || pref || '';
  return { prefecture: pref, city };
}

function dedupeByUrl(data) {
  const seen = new Set();
  return data.filter(item => {
    const url = item?.url || '';
    if (!url) return true;
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function groupForCsvDownloads(data, fallback = {}) {
  const groups = new Map();

  data.forEach(item => {
    const r = normalizeExportRecord(item);
    const { prefecture: pref, city } = exportAreaParts(r, fallback);
    const genre = r.genre || fallback.genre || r.searchGenre || 'ジャンル';
    const key = [pref, city, genre].join('\u0001');

    if (!groups.has(key)) {
      groups.set(key, { prefecture: pref, city, genre, items: [] });
    }
    groups.get(key).items.push(item);
  });

  return Array.from(groups.values())
    .map(group => ({ ...group, items: dedupeByUrl(group.items) }))
    .filter(group => group.items.length > 0);
}

async function downloadGroupedCsvFiles(data, fallback = {}) {
  const timestamp = formatTimestamp();
  const groups = groupForCsvDownloads(data, fallback);

  for (const group of groups) {
    const filename = [
      group.city,
      group.genre,
      timestamp
    ].map(sanitizeFilename).filter(Boolean).join('_') + '.csv';
    await downloadCsvFile(group.items, filename);
    await appendV3Log(`CSV出力完了: ${filename} (${group.items.length}件)`);
  }

  return groups.length;
}

async function appendV3Log(message) {
  console.log(message);
  try {
    const current = await chrome.storage.local.get(['v3_logs']);
    const logs = Array.isArray(current.v3_logs) ? current.v3_logs : [];
    const d = new Date();
    const z = n => String(n).padStart(2, '0');
    const entry = { t: `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`, msg: message };
    logs.push(entry);
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    await chrome.storage.local.set({ v3_logs: logs });
    chrome.runtime.sendMessage({ action: 'v3_logPush', entry }).catch(() => { });
  } catch (_) { }
}

async function downloadCsvFile(data, filename) {
  const encodedUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(buildCsvContent(data));
  await chrome.downloads.download({ url: encodedUri, filename, saveAs: false });
}

function safeTabSendMessage(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) { /* Receiving end does not exist */ }
    });
  } catch (_) { /* ignore */ }
}

// =====================================================================
// 自動ダウンロード
// =====================================================================
async function handleAutomaticDownload(tabId, data, filterConfig) {
  let query = '';
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'getQuery' });
    query = res?.query || '';
  } catch (e) { /* ignore */ }

  if (!query) {
    const r = await chrome.storage.local.get(['lastQuery']);
    query = r.lastQuery || '';
  }

  const stored = await chrome.storage.local.get(['targetGenres']);
  const targetGenres = stored.targetGenres || '';

  const parsed = parseQueryToAreaGenre(query);
  await downloadGroupedCsvFiles(data, {
    area: parsed.area,
    genre: parsed.genre || (Array.isArray(targetGenres) ? targetGenres[0] : targetGenres),
    media: 'GoogleMap'
  });
}

// =====================================================================
// Service Worker リスナー
// =====================================================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    scrapingState: 'inactive',
    scrapedData: [],
    maxItems: 50,
    targetGenres: ''
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'backgroundSleep') {
    setTimeout(() => sendResponse({ success: true }), request.ms);
    return true;
  }

  if (request.action === 'updateData') {
    chrome.storage.local.get(['scrapedData'], result => {
      const current = Array.isArray(result.scrapedData) ? result.scrapedData : [];
      const incoming = Array.isArray(request.data) ? request.data : [];

      const existingUrls = new Set(current.map(i => i?.url).filter(Boolean));
      const unique = incoming.filter(i => i?.url && !existingUrls.has(i.url));
      const updated = [...current, ...unique];

      chrome.storage.local.set({ scrapedData: updated }, () => {
        sendResponse({ success: true, count: updated.length });
      });
    });
    return true;
  }

  if (request.action === 'setState') {
    chrome.storage.local.set({ scrapingState: request.state }, async () => {
      if (request.state === 'active') {
        chrome.power.requestKeepAwake('display');
        chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
      } else {
        chrome.power.releaseKeepAwake();
        chrome.alarms.clear('keepAlive');
      }

      if (request.state === 'done' || request.state === 'stopped_by_user') {
        chrome.storage.local.get(['scrapedData', 'filterConfig', 'currentRunId'], async result => {
          const runId = result.currentRunId || 'default_run';
          if (downloadedRunIds.has(runId)) {
            console.log(`[BG] Download for runId ${runId} already executed. Skipping duplicate.`);
            return;
          }
          downloadedRunIds.add(runId);

          const data = Array.isArray(result.scrapedData) ? result.scrapedData : [];
          const filterConfig = result.filterConfig || null;

          const isUserStop = request.state === 'stopped_by_user';
          const notificationTitle = isUserStop ? '抽出を停止しました' : '抽出が完了しました';
          const notificationMsg = isUserStop 
            ? `ユーザー停止: 取得済み ${data.length} 件のデータをCSV出力します。`
            : `合計 ${data.length} 件のデータを取得しました。自動でダウンロードを開始します。`;

          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: notificationTitle,
            message: notificationMsg,
            priority: 2
          });

          if (data.length > 0) {
            const tabId = sender?.tab?.id || (await findActiveMapsTabId());
            if (tabId != null) {
              handleAutomaticDownload(tabId, data, filterConfig)
                .catch(e => console.error('Download failed:', e));
            }
          }
        });
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'triggerV3Download') {
    (async () => {
      const runId = request.runId;
      if (downloadedRunIds.has(runId)) {
        console.log(`[BG] V3 Download for runId ${runId} already executed. Skipping duplicate.`);
        sendResponse({ ok: true, duplicate: true });
        return;
      }
      downloadedRunIds.add(runId);

      chrome.storage.local.get(['v3_collectedData', 'v3_city', 'v3_genres'], async result => {
        const data = Array.isArray(result.v3_collectedData) ? result.v3_collectedData : [];
        if (data.length === 0) {
          sendResponse({ ok: true, reason: 'no data' });
          return;
        }

        try {
          const count = await downloadGroupedCsvFiles(data, { area: result.v3_city || '', media: 'GoogleMap' });
          sendResponse({ ok: true, count });
        } catch (e) {
          console.error('[BG] V3 download failed:', e);
          sendResponse({ ok: false, error: e.message });
        }
      });
    })();
    return true;
  }

  if (request.action === 'triggerV3GenreDownload') {
    (async () => {
      const data = Array.isArray(request.data) ? request.data : [];
      if (data.length === 0) {
        sendResponse({ ok: true, reason: 'no data' });
        return;
      }

      const downloadId = request.downloadId || `genre_${Date.now()}`;
      if (downloadedRunIds.has(downloadId)) {
        sendResponse({ ok: true, duplicate: true });
        return;
      }
      downloadedRunIds.add(downloadId);

      try {
        const count = await downloadGroupedCsvFiles(data, {
          area: request.area || data[0]?.area || '',
          genre: request.genre || data[0]?.sourceGenre || '',
          media: 'GoogleMap'
        });
        sendResponse({ ok: true, count });
      } catch (e) {
        console.error('[BG] V3 genre download failed:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'keepAlive') return;
  chrome.storage.local.get(['scrapingState'], result => {
    if (result.scrapingState !== 'active') return;
    chrome.tabs.query(
      { url: ['https://www.google.com/maps/*', 'https://www.google.co.jp/maps/*'] },
      tabs => tabs.forEach(tab => safeTabSendMessage(tab.id, { action: 'ping' }))
    );
  });
});

async function findActiveMapsTabId() {
  const tabs = await chrome.tabs.query({
    url: ['https://www.google.com/maps/*', 'https://www.google.co.jp/maps/*']
  });
  return tabs[0]?.id ?? null;
}
