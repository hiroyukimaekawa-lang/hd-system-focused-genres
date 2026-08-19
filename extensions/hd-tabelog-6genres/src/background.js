/**
 * background.js (Service Worker)
 * ※ SheetJS は offscreen.html で読み込むため importScripts 不要
 */

// [FIX] 以前はService Worker内の例外・未処理rejectionを拾う仕組みが無く、
// ダウンロード失敗などのエラーが完全にサイレントになっていた
// （chrome://extensions のService Workerコンソールにすら出ないケースがあった）。
// 最低限console.errorには残るようにしておく。
self.addEventListener('error', event => {
  console.error('[BG error]', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    error: event.error && event.error.stack ? event.error.stack : event.error
  });
});
self.addEventListener('unhandledrejection', event => {
  console.error('[BG unhandledrejection]', event.reason && event.reason.stack ? event.reason.stack : event.reason);
});

// Service Worker をスリープさせない keepAlive
function keepAlive() {
  chrome.runtime.getPlatformInfo(() => { });
  setTimeout(keepAlive, 20000);
}
keepAlive();

const crawlState = new Map();

function getState(tabId) {
  if (!crawlState.has(tabId)) {
    crawlState.set(tabId, {
      running: false,
      logs: [],
      collected: 0,
      maxItems: 0,
      page: 1,
      metadata: {}
    });
  }
  return crawlState.get(tabId);
}

function pushLog(tabId, msg, type = 'info') {
  const state = getState(tabId);
  const time = new Date().toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  state.logs.push({ time, msg, type });
  if (state.logs.length > 300) state.logs.shift();
}

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen.html';
let isOffscreenReady = false;
let offscreenReadyResolver = null;

async function hasOffscreenDocument() {
  if (!chrome.offscreen) return false;
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
      });
      return contexts.length > 0;
    } catch (e) {
      return false;
    }
  }
  try {
    const matchedClients = await self.clients.matchAll();
    return matchedClients.some(
      (c) => c.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)
    );
  } catch (e) {
    return false;
  }
}

async function setupOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    isOffscreenReady = true;
    return;
  }
  isOffscreenReady = false;
  const readyPromise = new Promise((resolve) => {
    offscreenReadyResolver = resolve;
  });
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'バックグラウンドで非アクティブタブの制限を受けずにHTMLパースとスクレーピングを安定して行うため',
    });
    console.log('[BG] Offscreen document created.');
    await Promise.race([
      readyPromise,
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
  } catch (e) {
    console.error('[BG] Failed to create offscreen document:', e);
  }
}

function showNotification(title, message) {
  console.log(`[完了通知] ${title}: ${message}`);
}

function buildFilename(metadata, ext) {
  const area = metadata.area || '不明';
  const industry = metadata.industry || '飲食店';
  const media = metadata.media === 'tabelog'
    ? '食べログ'
    : (metadata.media === 'hotpepper' ? 'ホットペッパー' : '媒体不明');
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return `${area}_${industry}_${media}_${ts}.${ext}`.replace(/[\/\\:*?"<>|]/g, '_');
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50);
}

function formatTimestamp(date = new Date()) {
  const z = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${z(date.getMonth() + 1)}${z(date.getDate())}_${z(date.getHours())}${z(date.getMinutes())}`;
}

function mediaLabel(metadataMedia, recordSource) {
  if (recordSource === '食べログ' || metadataMedia === 'tabelog') return '食べログ';
  if (recordSource === 'ホットペッパー' || recordSource === 'ホットペッパーグルメ' || metadataMedia === 'hotpepper') {
    return 'ホットペッパーグルメ';
  }
  return recordSource || '媒体不明';
}

function splitAreaText(area) {
  const text = String(area || '').replace(/\s+/g, '').trim();
  const m = text.match(/^((?:北海道|東京都|大阪府|京都府|.{2,3}県))?((?:.+?郡.+?[町村]|.+?市.+?区|.+?[市区町村]))?/);
  return {
    prefecture: m?.[1] || '',
    city: m?.[2] || text
  };
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

function groupResultsForCsv(results, metadata = {}) {
  const groups = new Map();
  const fallbackArea = splitAreaText(metadata.area || '');

  results.forEach(record => {
    const prefecture = record.prefecture || fallbackArea.prefecture || '';
    const city = record.city || fallbackArea.city || '';
    const genre = record.genre || metadata.industry || record.sourceGenre || '飲食店';
    const media = mediaLabel(metadata.media, record.source);
    const key = [prefecture, city, genre].join('\u0001');

    if (!groups.has(key)) {
      groups.set(key, { prefecture, city, genre, media, items: [] });
    }
    groups.get(key).items.push(record);
  });

  return Array.from(groups.values())
    .map(group => ({ ...group, items: dedupeByUrl(group.items) }))
    .filter(group => group.items.length > 0);
}

// 【改修】共通スキーマ(全19項目)に合わせてCSVを生成
function generateCSV(data) {
  const headers = [
    '店名', 'ジャンル', '取得元ジャンル', '都道府県', '市区町村', '住所', '電話番号',
    '定休日', '営業日', '営業開始A', '営業終了A', '営業開始B', '営業終了B',
    '営業時間原文', 'URL', 'HP有無', '媒体', '取得元URL', '取得日時'
  ];
  
  const keyMapping = {
    '店名': 'name', 'ジャンル': 'genre', '取得元ジャンル': 'sourceGenre',
    '都道府県': 'prefecture', '市区町村': 'city', '住所': 'address', '電話番号': 'phone',
    '定休日': 'regularHoliday', '営業日': 'businessDays', 
    '営業開始A': 'openTimeA', '営業終了A': 'closeTimeA', 
    '営業開始B': 'openTimeB', '営業終了B': 'closeTimeB',
    '営業時間原文': 'rawHours', 'URL': 'url', 'HP有無': 'hasWebsite', 
    '媒体': 'source', '取得元URL': 'sourceUrl', '取得日時': 'scrapedAt'
  };

  const escapeField = v => {
    const s = String(v ?? '');
    // 改行も正しく出力できるように条件に \n を追加
    return (s.includes(',') || s.includes('\n') || s.includes('"'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const rows = data.map(r => headers.map(h => escapeField(r[keyMapping[h]])).join(','));
  return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

function generateFailedUrlsCSV(data) {
  const headers = ['取得日時', '媒体', 'ジャンル', 'ページURL', '店舗URL', '失敗理由', 'HTTPステータス', 'リトライ回数'];
  const keyMapping = {
    '取得日時': 'scrapedAt',
    '媒体': 'source',
    'ジャンル': 'genre',
    'ページURL': 'pageUrl',
    '店舗URL': 'storeUrl',
    '失敗理由': 'reason',
    'HTTPステータス': 'httpStatus',
    'リトライ回数': 'retries'
  };
  const escapeField = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('\n') || s.includes('"'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = data.map(r => headers.map(h => escapeField(r[keyMapping[h]])).join(','));
  return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

// [FIX] 以前はここで例外を握りつぶし console.error に出すだけだったため、
// ポップアップ側は失敗しても「成功」表示のまま何も起きず、ユーザーからは
// 原因不明の「CSVボタンを押しても何も起こらない」状態に見えていた。
// 呼び出し元に成否と失敗理由を返すよう変更する。
async function triggerDownload(results, metadata, tabId = null) {
  if (!results || results.length === 0) {
    return { ok: false, error: '取得結果が0件のためCSVを出力できません' };
  }

  let groups;
  try {
    groups = groupResultsForCsv(results, metadata);
  } catch (err) {
    console.error('[BG] CSVグループ化失敗:', err);
    return { ok: false, error: `データ整形エラー: ${err?.message || err}` };
  }

  if (!groups.length) {
    return { ok: false, error: '出力対象のグループが0件でした' };
  }

  const timestamp = formatTimestamp();
  const filenames = [];
  const errors = [];

  for (const group of groups) {
    try {
      const csv = generateCSV(group.items);
      const base64 = btoa(unescape(encodeURIComponent(csv)));
      const dataUrl = 'data:text/csv;charset=utf-8;base64,' + base64;
      const mediaPrefix = group.media === '食べログ'
        ? 'tabelog'
        : (group.media === 'ホットペッパーグルメ' ? 'hotpepper' : sanitizeFilenamePart(group.media || 'media'));
      const filename = [
        mediaPrefix,
        group.prefecture,
        group.city,
        group.genre,
        timestamp
      ].map(sanitizeFilenamePart).filter(Boolean).join('_') + '.csv';

      const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      if (downloadId == null) {
        // downloads.download は失敗時に例外を投げずundefinedを返すことがある
        // （ダウンロード設定でブロックされている場合など）
        throw new Error('chrome.downloads.downloadがdownloadIdを返しませんでした（ブラウザのダウンロード設定でブロックされている可能性があります）');
      }
      console.log('[BG] CSVダウンロード成功:', filename, 'id:', downloadId);
      filenames.push(filename);
      if (tabId != null) {
        pushLog(tabId, `CSV出力完了：${filename}`, 'good');
        chrome.runtime.sendMessage({
          tabId,
          type: 'INFO',
          message: `CSV出力完了：${filename}`
        }).catch(() => { });
      }
    } catch (err) {
      console.error('[BG] CSVダウンロード失敗:', err);
      errors.push(err?.message || String(err));
      if (tabId != null) {
        pushLog(tabId, `CSV出力失敗：${err?.message || err}`, 'err');
      }
    }
  }

  if (errors.length && !filenames.length) {
    return { ok: false, error: errors.join(' / ') };
  }
  return { ok: true, filenames, errors: errors.length ? errors : undefined };
}

async function triggerFailedUrlsDownload(failedUrls, metadata = {}, tabId = null) {
  if (!failedUrls || failedUrls.length === 0) return { ok: false, error: '失敗URLが0件です' };
  const timestamp = formatTimestamp();
  const media = metadata.media === 'tabelog' ? 'tabelog' : (metadata.media === 'hotpepper' ? 'hotpepper' : 'media');
  const csv = generateFailedUrlsCSV(failedUrls);
  const base64 = btoa(unescape(encodeURIComponent(csv)));
  const dataUrl = 'data:text/csv;charset=utf-8;base64,' + base64;
  const filename = `${media}_failed_urls_${timestamp}.csv`;
  try {
    const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    if (downloadId == null) {
      throw new Error('chrome.downloads.downloadがdownloadIdを返しませんでした（ブラウザのダウンロード設定でブロックされている可能性があります）');
    }
    console.log('[BG] 失敗URL CSVダウンロード成功:', filename, 'id:', downloadId);
    if (tabId != null) {
      pushLog(tabId, `失敗URL出力完了：${filename}`, 'warn');
      chrome.runtime.sendMessage({
        tabId,
        type: 'INFO',
        message: `失敗URL出力完了：${filename}`
      }).catch(() => { });
    }
    return { ok: true, filename };
  } catch (err) {
    console.error('[BG] 失敗URL CSVダウンロード失敗:', err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function triggerXlsxDownload(base64, metadata) {
  if (!base64) {
    console.warn('[BG] xlsx base64データなし');
    return { ok: false, error: 'Excelデータが空でした' };
  }
  const dataUrl = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + base64;
  const filename = buildFilename(metadata, 'xlsx');
  try {
    const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    if (downloadId == null) {
      throw new Error('chrome.downloads.downloadがdownloadIdを返しませんでした（ブラウザのダウンロード設定でブロックされている可能性があります）');
    }
    console.log('[BG] Excelダウンロード成功:', filename, 'id:', downloadId);
    return { ok: true, filename };
  } catch (err) {
    console.error('[BG] Excelダウンロード失敗:', err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function getGenreLinksFromContent(tabId, siteType) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'GET_GENRE_LINKS', siteType }, (response) => {
      if (chrome.runtime.lastError) { resolve([]); return; }
      resolve((response && response.links) ? response.links : []);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background') {
    if (message.type === 'OFFSCREEN_READY') {
      isOffscreenReady = true;
      if (offscreenReadyResolver) { offscreenReadyResolver(); offscreenReadyResolver = null; }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'GET_GENRE_LINKS_FROM_CONTENT') {
      getGenreLinksFromContent(message.tabId, message.siteType).then(links => {
        chrome.runtime.sendMessage({
          target: 'offscreen', type: 'GENRE_LINKS_FROM_CONTENT_RESULT',
          tabId: message.tabId, links
        }).catch(() => { });
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'DOWNLOAD_XLSX') {
      // [FIX] 以前はダウンロードの成否を待たずに ok:true を返していたため、
      // 実際に失敗していてもポップアップには「成功」としか表示されなかった。
      // 実際の結果を待ってから返すよう変更。
      (async () => {
        const result = await triggerXlsxDownload(message.base64, message.metadata);
        chrome.storage.local.set({
          [`last_results_${message.tabId}`]: {
            results: message.results, metadata: message.metadata, timestamp: Date.now()
          }
        });
        sendResponse(result);
      })();
      return true;
    }

    if (message.type === 'DOWNLOAD_CSV') {
      // [FIX] 同上。CSVダウンロードの実際の成否・エラー内容を返す。
      (async () => {
        const result = await triggerDownload(message.results, message.metadata, message.tabId);
        chrome.storage.local.set({
          [`last_results_${message.tabId}`]: {
            results: message.results, metadata: message.metadata, timestamp: Date.now()
          }
        });
        sendResponse(result);
      })();
      return true;
    }

    if (message.type === 'DOWNLOAD_FAILED_URLS') {
      (async () => {
        const result = await triggerFailedUrlsDownload(message.failedUrls, message.metadata, message.tabId);
        sendResponse(result || { ok: true });
      })();
      return true;
    }

    if (message.type === 'SHOW_NOTIFICATION') {
      showNotification(message.title, message.message);
      sendResponse({ ok: true });
      return true;
    }

    const tabId = message.tabId;
    const payload = message.payload || {};
    const state = getState(tabId);

    switch (message.type) {
      case 'PAGE_START':
        state.running = true;
        state.page = payload.page || state.page;
        state.collected = payload.collected || state.collected;
        pushLog(tabId, `📄 ${payload.siteName || ''}${payload.page}ページ目 開始 (取得済み: ${payload.collected}件)`, 'info');
        break;
      case 'PROGRESS':
        state.running = true;
        state.collected = payload.collected || state.collected;
        state.maxItems = payload.maxItems || state.maxItems;
        state.page = payload.page || state.page;
        if (payload.latest) pushLog(tabId, `✅ ${payload.latest}`, 'good');
        break;
      case 'INFO':
        pushLog(tabId, `ℹ️ ${payload.message}`, 'info');
        break;
      case 'ERROR':
        state.running = false;
        pushLog(tabId, `❌ ${payload.message}`, 'err');
        break;
      case 'DONE':
        state.running = false;
        state.collected = payload.collected || state.collected;
        state.metadata = payload.metadata || state.metadata;
        pushLog(tabId, `🎉 完了！ 合計 ${payload.collected} 件取得`, 'good');
        break;
    }

    chrome.runtime.sendMessage({
      tabId, type: message.type, ...payload
    }).catch(() => { });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'GET_GENRE_LINKS') {
    chrome.tabs.sendMessage(message.tabId, { action: 'GET_GENRE_LINKS', siteType: message.siteType }, (response) => {
      if (chrome.runtime.lastError) { sendResponse({ links: [] }); return; }
      sendResponse(response || { links: [] });
    });
    return true;
  }

  if (message.action === 'START_CRAWL') {
    const state = getState(message.tabId);
    state.running = true;
    state.logs = [];
    state.collected = 0;
    state.maxItems = message.maxItems || 0;
    state.page = 1;
    state.metadata = {};
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'START_POPULAR_GENRE_CRAWL') {
    const state = getState(message.tabId);
    state.running = true;
    state.logs = [];
    state.collected = 0;
    state.maxItems = message.maxItems || 0;
    state.page = 1;
    state.metadata = {};
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'GET_STATE') {
    const state = getState(message.tabId);
    sendResponse({ ok: true, state });
    return true;
  }

  if (message.action === 'STOP_CRAWL') {
    const state = getState(message.tabId);
    state.running = false;
    pushLog(message.tabId, '⏹ 停止リクエスト送信', 'warn');
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (res) => { sendResponse(res); });
    });
    return true;
  }

  if (message.action === 'GET_RESULTS') {
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (res) => { sendResponse(res); });
    });
    return true;
  }
});
