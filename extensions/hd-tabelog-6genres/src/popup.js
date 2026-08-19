/**
 * popup.js
 * クロール制御 UI ロジック
 */

// ============================================================
// DOM
// ============================================================
const maxSlider = document.getElementById('maxSlider');
const maxVal = document.getElementById('maxVal');
const dot = document.getElementById('dot');
const statusMain = document.getElementById('statusMain');
const statusSub = document.getElementById('statusSub');
const progressBar = document.getElementById('progressBar');
const logScroll = document.getElementById('logScroll');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const dlBtn = document.getElementById('dlBtn');
const previewSection = document.getElementById('previewSection');
const previewList = document.getElementById('previewList');

// 高度な設定・詳細カウンターのDOM
const tabelogConcurrency = document.getElementById('tabelogConcurrency');
const tabelogDelay = document.getElementById('tabelogDelay');
const hotpepperConcurrency = document.getElementById('hotpepperConcurrency');
const hotpepperDelay = document.getElementById('hotpepperDelay');
const maxRetries = document.getElementById('maxRetries');
const fetchTimeout = document.getElementById('fetchTimeout');
const maxPages = document.getElementById('maxPages');
const popularGenreChoices = document.getElementById('popularGenreChoices');

const cntSuccess = document.getElementById('cntSuccess');
const cntFailed = document.getElementById('cntFailed');
const cntRetrying = document.getElementById('cntRetrying');
const cntBlock = document.getElementById('cntBlock');
const cntTimeout = document.getElementById('cntTimeout');
const cntNoName = document.getElementById('cntNoName');
const cntNoAddress = document.getElementById('cntNoAddress');
const cntNoPhone = document.getElementById('cntNoPhone');
const cntHtmlMismatch = document.getElementById('cntHtmlMismatch');
const cntOtherFail = document.getElementById('cntOtherFail');
const throttlingIndicator = document.getElementById('throttlingIndicator');
const activeParams = document.getElementById('activeParams');
const currentConcurrency = document.getElementById('currentConcurrency');
const currentDelay = document.getElementById('currentDelay');
const speedMode = document.getElementById('speedMode');

const SPEED_PRESETS = {
  safe:     { tabelogConcurrency: 2, tabelogDelay: 2000, maxRetries: 1, fetchTimeout: 20 },
  standard: { tabelogConcurrency: 3, tabelogDelay: 1000, maxRetries: 1, fetchTimeout: 15 },
  fast:     { tabelogConcurrency: 4, tabelogDelay: 700,  maxRetries: 0, fetchTimeout: 10 }
};

function applySpeedMode(mode) {
  const preset = SPEED_PRESETS[mode];
  if (!preset) return;
  tabelogConcurrency.value = preset.tabelogConcurrency;
  tabelogDelay.value = preset.tabelogDelay;
  maxRetries.value = preset.maxRetries;
  fetchTimeout.value = preset.fetchTimeout;
  validateInputs();
}

// 食べログで巡回する固定5カテゴリ。バー・お酒内の明示的なスナックは
// 詳細情報から「スナック」に分類するため、最終出力は6ジャンルになる。
// TABELOG_POPULAR_GENRE_SLUGS と名称を完全一致させること）。
// ここは「どのカテゴリページを巡回するか」の選択肢で、
// 巡回後のスナック判定は詳細ジャンルと店名を使う。
const HD_POPULAR_GENRES = ['カフェ', 'スイーツ', '居酒屋', 'バー・お酒', '焼き鳥'];

const DEFAULT_POPULAR_GENRES = [...HD_POPULAR_GENRES];

// 設定のバリデーションと保存
function validateInputs() {
  let tc = parseInt(tabelogConcurrency.value) || 3;
  if (tc < 1) tc = 1;
  if (tc > 5) tc = 5;
  tabelogConcurrency.value = tc;

  let td = parseInt(tabelogDelay.value) || 1000;
  if (td < 500) td = 500;
  if (td > 10000) td = 10000;
  tabelogDelay.value = td;

  let hc = parseInt(hotpepperConcurrency.value) || 6;
  if (hc < 1) hc = 1;
  if (hc > 10) hc = 10;
  hotpepperConcurrency.value = hc;

  let hd = parseInt(hotpepperDelay.value) || 500;
  if (hd < 200) hd = 200;
  if (hd > 3000) hd = 3000;
  hotpepperDelay.value = hd;

  let mr = parseInt(maxRetries.value);
  if (isNaN(mr) || mr < 0) mr = 1;
  if (mr > 3) mr = 3;
  maxRetries.value = mr;

  let ft = parseInt(fetchTimeout.value) || 20;
  if (ft < 5) ft = 5;
  if (ft > 30) ft = 30;
  fetchTimeout.value = ft;

  let mp = parseInt(maxPages.value) || 20;
  if (mp < 1) mp = 1;
  if (mp > 50) mp = 50;
  maxPages.value = mp;
}

function saveSettings() {
  validateInputs();
  chrome.storage.local.set({
    tabelogConcurrency: parseInt(tabelogConcurrency.value),
    tabelogDelay: parseInt(tabelogDelay.value),
    hotpepperConcurrency: parseInt(hotpepperConcurrency.value),
    hotpepperDelay: parseInt(hotpepperDelay.value),
    maxRetries: parseInt(maxRetries.value),
    fetchTimeout: parseInt(fetchTimeout.value),
    maxPages: parseInt(maxPages.value),
    selectedPopularGenres: getSelectedPopularGenres(),
    speedMode: speedMode?.value || ''
  });
}

[tabelogConcurrency, tabelogDelay, hotpepperConcurrency, hotpepperDelay, maxRetries, fetchTimeout, maxPages].forEach(el => {
  el.addEventListener('change', saveSettings);
});

if (speedMode) {
  speedMode.addEventListener('change', () => {
    applySpeedMode(speedMode.value);
    saveSettings();
  });
}

function renderPopularGenreChoices(selected = DEFAULT_POPULAR_GENRES) {
  if (!popularGenreChoices) return;
  const selectedSet = new Set(selected);
  popularGenreChoices.innerHTML = '';
  HD_POPULAR_GENRES.forEach(genre => {
    const label = document.createElement('label');
    label.className = 'genre-choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = genre;
    checkbox.checked = selectedSet.has(genre);
    checkbox.addEventListener('change', saveSettings);
    const span = document.createElement('span');
    span.textContent = genre;
    label.appendChild(checkbox);
    label.appendChild(span);
    popularGenreChoices.appendChild(label);
  });
}

function getSelectedPopularGenres() {
  return Array.from(popularGenreChoices?.querySelectorAll('input[type="checkbox"]:checked') || [])
    .map(input => input.value);
}

function loadSettings() {
  chrome.storage.local.get([
    'tabelogConcurrency', 'tabelogDelay', 'hotpepperConcurrency', 'hotpepperDelay',
    'maxRetries', 'fetchTimeout', 'maxPages', 'selectedPopularGenres', 'speedMode'
  ], (res) => {
    if (res.tabelogConcurrency != null) tabelogConcurrency.value = res.tabelogConcurrency;
    if (res.tabelogDelay != null) tabelogDelay.value = res.tabelogDelay;
    if (res.hotpepperConcurrency != null) hotpepperConcurrency.value = res.hotpepperConcurrency;
    if (res.hotpepperDelay != null) hotpepperDelay.value = res.hotpepperDelay;
    if (res.maxRetries != null) maxRetries.value = res.maxRetries;
    if (res.fetchTimeout != null) fetchTimeout.value = res.fetchTimeout;
    if (res.maxPages != null) maxPages.value = res.maxPages;
    if (speedMode && res.speedMode != null) speedMode.value = res.speedMode;
    renderPopularGenreChoices(Array.isArray(res.selectedPopularGenres) ? res.selectedPopularGenres : DEFAULT_POPULAR_GENRES);
    validateInputs();
  });
}

function updateCounters(msg) {
  if (msg.successCount != null) cntSuccess.textContent = msg.successCount;
  if (msg.failedCount != null) cntFailed.textContent = msg.failedCount;
  if (msg.retryingCount != null) cntRetrying.textContent = msg.retryingCount;
  if (msg.blockCount != null) cntBlock.textContent = msg.blockCount;
  if (msg.timeoutCount != null) cntTimeout.textContent = msg.timeoutCount;
  if (msg.noNameCount != null) cntNoName.textContent = msg.noNameCount;
  if (msg.noAddressCount != null) cntNoAddress.textContent = msg.noAddressCount;
  if (msg.noPhoneCount != null) cntNoPhone.textContent = msg.noPhoneCount;
  if (msg.htmlMismatchCount != null) cntHtmlMismatch.textContent = msg.htmlMismatchCount;
  if (msg.otherFailCount != null) cntOtherFail.textContent = msg.otherFailCount;
  
  if (msg.isThrottling) {
    throttlingIndicator.classList.remove('hidden');
  } else {
    throttlingIndicator.classList.add('hidden');
  }
  
  if (msg.activeConcurrency != null && msg.activeDelay != null) {
    activeParams.style.display = 'block';
    currentConcurrency.textContent = msg.activeConcurrency;
    currentDelay.textContent = msg.activeDelay;
  } else {
    activeParams.style.display = 'none';
  }
}

function resetCounters() {
  cntSuccess.textContent = '0';
  cntFailed.textContent = '0';
  cntRetrying.textContent = '0';
  cntBlock.textContent = '0';
  cntTimeout.textContent = '0';
  cntNoName.textContent = '0';
  cntNoAddress.textContent = '0';
  cntNoPhone.textContent = '0';
  cntHtmlMismatch.textContent = '0';
  cntOtherFail.textContent = '0';
  throttlingIndicator.classList.add('hidden');
  activeParams.style.display = 'none';
}

// ============================================================
// 状態
// ============================================================
let allResults = [];
let isRunning = false;
let maxItems = parseInt(maxSlider.value) >= 500 ? Infinity : parseInt(maxSlider.value || 300);
let currentTabId = null;
let metadata = { area: '', industry: '', media: '' };

// ============================================================
// スライダー
// ============================================================
maxSlider.addEventListener('input', () => {
  const val = parseInt(maxSlider.value);
  if (val >= 500) {
    maxItems = Infinity;
    maxVal.textContent = '上限なし';
  } else {
    maxItems = val;
    maxVal.textContent = val + '件';
  }
});

// ============================================================
// ログ出力
// ============================================================
function addLog(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${time}] ${msg}`;
  logScroll.appendChild(line);
  logScroll.scrollTop = logScroll.scrollHeight;
  while (logScroll.children.length > 300) logScroll.removeChild(logScroll.firstChild);
}

// ============================================================
// ステータス更新
// ============================================================
function setStatus(state, main, sub = '') {
  dot.className = `dot ${state}`;
  statusMain.textContent = main;
  statusSub.textContent = sub;
}

function updateProgress(collected, total) {
  if (total === Infinity) {
    const pct = Math.min(95, 10 + collected * 2);
    progressBar.style.width = pct + '%';
    return;
  }
  const pct = total > 0 ? Math.min(100, Math.round(collected / total * 100)) : 0;
  progressBar.style.width = pct + '%';
}

// ============================================================
// プレビュー描画
// ============================================================
function renderPreview(data) {
  previewList.innerHTML = '';
  const items = data.slice(-30).reverse();
  items.forEach(r => {
    const el = document.createElement('div');
    el.className = 'preview-item';

    let hoursPreview = '';
    if (r.businessDays || r.openTimeA || r.closeTimeA) {
      hoursPreview += `<div class="pi-hours" style="font-size: 10px; color: var(--muted); margin-top: 3px;">🕒 営業: ${esc(r.businessDays)} ${esc(r.openTimeA)}〜${esc(r.closeTimeA)}</div>`;
    }
    if (r.regularHoliday) {
      hoursPreview += `<div class="pi-closed" style="font-size: 10px; color: var(--red); margin-top: 1px;">📅 定休日: ${esc(r.regularHoliday)}</div>`;
    }

    el.innerHTML = `
      <div class="pi-name">${esc(r.name)}</div>
      <div class="pi-meta">
        ${r.address ? esc(r.address) : '<span style="opacity:.5">住所なし</span>'}
        ${r.phone ? `<span class="pi-phone"> · 📞 ${esc(r.phone)}</span>` : ''}
        ${hoursPreview}
      </div>
    `;
    previewList.appendChild(el);
  });
  previewSection.style.display = 'block';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// CSV 生成・ダウンロード
// ============================================================
function toCSV(data) {
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

  const ef = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('\n') || s.includes('"'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const rows = data.map(r => headers.map(h => ef(r[keyMapping[h]])).join(','));
  return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

function downloadCSV() {
  if (!allResults.length) return;
  chrome.runtime.sendMessage({
    target: 'background',
    type: 'DOWNLOAD_CSV',
    tabId: currentTabId,
    results: allResults,
    metadata
  }, res => {
    // [FIX] 以前はbackground側が常にok:trueを返していたため、実際の
    // ダウンロード失敗（容量超過・ブラウザのダウンロード設定など）が
    // 起きてもここでは検知できず「開始しました」としか表示されなかった。
    // 実際のエラー内容を表示するよう変更。
    if (chrome.runtime.lastError) {
      addLog(`CSV出力に失敗しました: ${chrome.runtime.lastError.message}`, 'err');
      return;
    }
    if (res?.ok) {
      addLog(`CSV出力完了: ${allResults.length}件`, 'good');
    } else {
      addLog(`CSV出力に失敗しました: ${res?.error || '原因不明'}`, 'err');
    }
  });
}

// ============================================================
// ボタン状態切り替え
// ============================================================
function setButtons(running) {
  isRunning = running;
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  maxSlider.disabled = running;
  // 人気ジャンルボタンも連動して制御
  popularGenreBtn.disabled = running;
}

// ============================================================
// background からのメッセージ受信
// ============================================================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tabId !== currentTabId) return;

  switch (msg.type) {
    case 'PAGE_START':
      addLog(`📄 ${msg.siteName ? msg.siteName + ' ' : ''}${msg.page}ページ目 開始 (取得済み: ${msg.collected}件)`, 'info');
      setStatus('running', `${msg.page}ページ目をクロール中...`, `取得済み ${msg.collected} 件`);
      updateCounters(msg);
      break;

    case 'PROGRESS':
      if (msg.latest) {
        addLog(`✅ ${msg.latest}`, 'good');
      }
      setStatus('running', `取得中... ${msg.collected} 件`, `${msg.page}ページ目`);
      updateProgress(msg.collected, msg.maxItems);
      updateCounters(msg);
      chrome.runtime.sendMessage({ action: 'GET_RESULTS', tabId: currentTabId }, res => {
        if (res?.results) {
          allResults = res.results;
          metadata = res.metadata || metadata;
          renderPreview(allResults);
          if (allResults.length > 0) dlBtn.disabled = false;
        }
      });
      break;

    case 'INFO':
      addLog(`ℹ️ ${msg.message}`, 'info');
      updateCounters(msg);
      break;

    case 'ERROR':
      addLog(`❌ ${msg.message}`, 'err');
      setStatus('error', 'エラーが発生しました', msg.message);
      updateCounters(msg);
      setButtons(false);
      break;

    case 'DONE':
      allResults = msg.results || allResults;
      metadata = msg.metadata || metadata;
      addLog(`🎉 完了！ 合計 ${allResults.length} 件取得`, 'good');
      setStatus('done', `取得完了 ${allResults.length} 件`, 'CSVダウンロードできます');
      progressBar.style.width = '100%';
      updateCounters(msg);
      setButtons(false);
      renderPreview(allResults);
      if (allResults.length > 0) dlBtn.disabled = false;
      break;
  }
});

// ============================================================
// 取得開始（既存 START_CRAWL: 変更なし）
// ============================================================
function detectSite(url) {
  if (/tabelog\.com/.test(url)) return 'tabelog';
  if (/hotpepper\.jp/.test(url)) return 'hotpepper';
  return null;
}

startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    addLog('アクティブタブが見つかりません', 'err');
    return;
  }

  const url = tab.url || '';
  const siteType = detectSite(url);

  if (!siteType) {
    addLog('対応サイトの検索結果ページを開いてください', 'warn');
    setStatus('error', '対応サイトではありません', '食べログ・ホットペッパー専用です');
    return;
  }

  allResults = [];
  resetCounters();
  logScroll.innerHTML = '';
  previewList.innerHTML = '';
  previewSection.style.display = 'none';
  dlBtn.disabled = true;
  updateProgress(0, maxItems);

  const siteName = siteType === 'tabelog' ? '食べログ' : 'ホットペッパー';
  const limitText = maxItems === Infinity ? '上限なし' : `上限 ${maxItems}件`;
  addLog(`${siteName} クロール開始 (${limitText})`, 'good');
  setStatus('running', `${siteName} をクロール中...`, limitText);
  setButtons(true);

  chrome.runtime.sendMessage({
    action: 'START_CRAWL',
    tabId: tab.id,
    listUrl: tab.url,
    maxItems: maxItems,
    tabelogConcurrency: parseInt(tabelogConcurrency.value) || 2,
    tabelogDelay: parseInt(tabelogDelay.value) || 2000,
    hotpepperConcurrency: parseInt(hotpepperConcurrency.value) || 6,
    hotpepperDelay: parseInt(hotpepperDelay.value) || 500,
    maxRetries: parseInt(maxRetries.value) ?? 1,
    fetchTimeout: parseInt(fetchTimeout.value) || 20,
    maxPages: parseInt(maxPages.value) || 20,
  }, res => {
    if (!res?.ok) {
      addLog('クロール開始失敗: ' + (res?.error || '不明'), 'err');
      setButtons(false);
    }
  });
});

// ============================================================
// 停止
// ============================================================
stopBtn.addEventListener('click', async () => {
  if (!currentTabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) currentTabId = tab.id;
  }
  if (!currentTabId) {
    addLog('停止対象のタブが不明です', 'err');
    return;
  }
  chrome.runtime.sendMessage({ action: 'STOP_CRAWL', tabId: currentTabId });
  addLog('⏹ 停止リクエスト送信', 'warn');
  setStatus('idle', '停止中...', '');
  setButtons(false);
});

// ============================================================
// CSV ダウンロード
// ============================================================
dlBtn.addEventListener('click', downloadCSV);

// ============================================================
// 人気ジャンル一括取得ボタン（追加）
// ============================================================
const popularGenreBtn = document.getElementById('popularGenreBtn');

popularGenreBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    addLog('アクティブタブが見つかりません', 'err');
    return;
  }

  const url = tab.url || '';
  const siteType = detectSite(url);

  if (!siteType) {
    addLog('対応サイトの検索結果ページを開いてください', 'warn');
    setStatus('error', '対応サイトではありません', '食べログ・ホットペッパー専用です');
    return;
  }

  // UI リセット
  allResults = [];
  resetCounters();
  logScroll.innerHTML = '';
  previewList.innerHTML = '';
  previewSection.style.display = 'none';
  dlBtn.disabled = true;
  updateProgress(0, maxItems);

  const siteName = siteType === 'tabelog' ? '食べログ' : 'ホットペッパー';
  const limitText = maxItems === Infinity ? '上限なし' : `上限 ${maxItems}件`;
  addLog(`${siteName} 人気ジャンル一括取得 開始 (${limitText})`, 'good');
  setStatus('running', `${siteName} のジャンルリンクを抽出中...`, limitText);
  setButtons(true);

  chrome.runtime.sendMessage({
    action: 'START_POPULAR_GENRE_CRAWL',
    tabId: tab.id,
    listUrl: tab.url,
    maxItems: maxItems,
    tabelogConcurrency: parseInt(tabelogConcurrency.value) || 2,
    tabelogDelay: parseInt(tabelogDelay.value) || 2000,
    hotpepperConcurrency: parseInt(hotpepperConcurrency.value) || 6,
    hotpepperDelay: parseInt(hotpepperDelay.value) || 500,
    maxRetries: parseInt(maxRetries.value) ?? 1,
    fetchTimeout: parseInt(fetchTimeout.value) || 20,
    maxPages: parseInt(maxPages.value) || 20,
    selectedGenres: getSelectedPopularGenres(),
  }, res => {
    if (!res?.ok) {
      addLog('人気ジャンル一括取得 開始失敗: ' + (res?.error || '不明'), 'err');
      setButtons(false);
    }
  });
});

// ============================================================
// 起動時
// ============================================================
(async () => {
  loadSettings();
  const val = parseInt(maxSlider.value);
  if (val >= 500) {
    maxItems = Infinity;
    maxVal.textContent = '上限なし';
  } else {
    maxItems = val;
    maxVal.textContent = val + '件';
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTabId = tab.id;

  // background から状態とログを復元
  chrome.runtime.sendMessage({ action: 'GET_STATE', tabId: currentTabId }, res => {
    if (!res?.state) return;
    const state = res.state;

    // ログを復元
    if (state.logs?.length) {
      state.logs.forEach(({ time, msg, type }) => {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = `[${time}] ${msg}`;
        logScroll.appendChild(line);
      });
      logScroll.scrollTop = logScroll.scrollHeight;
    }

    // 実行中なら停止ボタンを有効化
    if (state.running) {
      setButtons(true);
      setStatus('running', `クロール実行中... ${state.collected}件`, `${state.page}ページ目`);
      updateProgress(state.collected, state.maxItems === 0 ? Infinity : state.maxItems);
    }
  });

  // 結果を復元
  chrome.runtime.sendMessage({ action: 'GET_RESULTS', tabId: currentTabId }, res => {
    if (res?.results?.length) {
      allResults = res.results;
      metadata = res.metadata || metadata;
      renderPreview(allResults);
      dlBtn.disabled = false;
      if (!res.running) {
        setStatus('done', `前回の結果 ${allResults.length} 件`, 'CSVダウンロード可能');
        updateProgress(allResults.length, maxItems);
      }
    }
  });
})();
