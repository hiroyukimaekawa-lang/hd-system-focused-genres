// popup-v3.js - 任意キーワード入力版
const V3K = {
  state: 'v3_state',
  city: 'v3_city',
  keyword: 'v3_keyword',
  outputGenre: 'v3_outputGenre',
  areas: 'v3_areas',
  genres: 'v3_genres',
  tasks: 'v3_tasks',
  totalTasks: 'v3_totalTasks',
  taskIdx: 'v3_taskIdx',
  totalAreas: 'v3_totalAreas',
  totalGenres: 'v3_totalGenres',
  areaIdx: 'v3_areaIdx',
  genreIdx: 'v3_genreIdx',
  currentArea: 'v3_currentArea',
  currentGenre: 'v3_currentGenre',
  currentUrl: 'v3_currentUrl',
  currentKw: 'v3_currentKeyword',
  logs: 'v3_logs',
  collected: 'v3_collectedData',
  startTime: 'v3_startTime',
  comboDurations: 'v3_comboDurations',
  maxItems: 'v3_maxItems',
  scrapeMode: 'v3_scrapeMode',
  rangeMode: 'v3_rangeMode',
  selectedAreas: 'v3_selectedAreas'
};
V3K.selectedGenres = 'v3_selectedGenres';

const OUTPUT_HEADERS = [
  '店名', 'ジャンル', '検索ジャンル', '取得元ジャンル', '都道府県', '市区町村', '住所', '電話番号',
  '定休日', '営業日', '営業開始A', '営業終了A', '営業開始B', '営業終了B',
  '営業時間原文', 'URL', 'HP有無', '媒体', '取得元URL', '取得日時',
  '検索エリア', '検索クエリ', 'Googleマップジャンル', '取得モード', '取得ステータス', '詳細取得リトライ回数', '一覧取得順'
];

document.addEventListener('DOMContentLoaded', () => {
  const elCity = document.getElementById('v3-city-input');
  const btnFetchAreas = document.getElementById('v3-fetch-areas');
  const elGenresContainer = document.getElementById('v3-genres-container');
  const elGenreSummary = document.getElementById('v3-genre-summary');
  const btnGenreAll = document.getElementById('v3-genre-all');
  const btnGenreClear = document.getElementById('v3-genre-clear');
  const elMaxRange = document.getElementById('v3-max-items');
  const elMaxVal = document.getElementById('v3-max-val');
  const elScrapeMode = document.getElementById('v3-scrape-mode');
  const btnStart = document.getElementById('v3-start');
  const btnStop = document.getElementById('v3-stop');
  const btnReset = document.getElementById('v3-reset');
  const btnCsv = document.getElementById('v3-download-csv');
  const btnXlsx = document.getElementById('v3-download-xlsx');
  const elAreaPicker = document.getElementById('v3-area-picker');
  const elAreasContainer = document.getElementById('v3-areas-container');
  const elAreaSummary = document.getElementById('v3-area-summary');
  const btnAreaAll = document.getElementById('v3-area-all');
  const btnAreaClear = document.getElementById('v3-area-clear');
  const elCurArea = document.getElementById('v3-cur-area');
  const elCurGenre = document.getElementById('v3-cur-genre');
  const elAreaProg = document.getElementById('v3-area-progress');
  const elGenreProg = document.getElementById('v3-genre-progress');
  const elTotalCnt = document.getElementById('v3-total-count');
  const elElapsed = document.getElementById('v3-elapsed');
  const elEta = document.getElementById('v3-eta');
  const elCurKw = document.getElementById('v3-cur-keyword');
  const elCurUrl = document.getElementById('v3-cur-url');
  const elBar = document.getElementById('v3-bar');
  const elLog = document.getElementById('v3-log');
  const elPrevBody = document.getElementById('v3-preview-body');
  const elPrevSum = document.getElementById('v3-preview-summary');

  const sendMsg = (msg) => new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  const storageGet = (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve));
  const storageSet = (obj) => new Promise(resolve => chrome.storage.local.set(obj, resolve));
  let availableAreas = [];
  let selectedAreas = [];
  let availableGenres = [];
  let selectedGenres = [];
  let fetchedAreaInput = '';

  const normalizeAreaText = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').trim();
  const composeSelectedArea = (baseArea, selectedArea) => {
    const base = String(baseArea || '').trim();
    const selected = String(selectedArea || '').trim();
    if (!selected) return base;
    if (base.includes(selected)) return base;
    return `${base} ${selected}`.trim();
  };
  const fmtHMS = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    const z = n => String(n).padStart(2, '0');
    return `${z(h)}:${z(m)}:${z(s)}`;
  };

  (async () => {
    const stored = await storageGet([V3K.city, V3K.maxItems, V3K.scrapeMode, V3K.selectedAreas, V3K.selectedGenres]);
    if (stored[V3K.city]) elCity.value = stored[V3K.city];
    selectedAreas = Array.isArray(stored[V3K.selectedAreas]) ? stored[V3K.selectedAreas] : [];
    selectedGenres = Array.isArray(stored[V3K.selectedGenres]) ? stored[V3K.selectedGenres] : [];
    if (stored[V3K.scrapeMode]) elScrapeMode.value = stored[V3K.scrapeMode];
    if (stored[V3K.maxItems]) {
      elMaxRange.value = stored[V3K.maxItems];
      elMaxVal.textContent = stored[V3K.maxItems];
    }
    await loadGenres();
    refreshStatus(true);
    setInterval(refreshStatus, 1000);
  })();

  elCity.addEventListener('input', () => {
    storageSet({ [V3K.city]: elCity.value.trim() });
    fetchedAreaInput = '';
    availableAreas = [];
    selectedAreas = [];
    elAreaPicker.hidden = true;
    persistSelectedAreas();
    renderAreaCheckboxes();
  });
  btnFetchAreas.addEventListener('click', loadAreasForInput);
  elCity.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loadAreasForInput();
    }
  });
  btnAreaAll.addEventListener('click', () => {
    selectedAreas = availableAreas.slice();
    persistSelectedAreas();
    renderAreaCheckboxes();
  });
  btnAreaClear.addEventListener('click', () => {
    selectedAreas = [];
    persistSelectedAreas();
    renderAreaCheckboxes();
  });
  btnGenreAll.addEventListener('click', () => {
    selectedGenres = availableGenres.slice();
    persistSelectedGenres();
    renderGenreCheckboxes();
  });
  btnGenreClear.addEventListener('click', () => {
    selectedGenres = [];
    persistSelectedGenres();
    renderGenreCheckboxes();
  });
  elMaxRange.addEventListener('input', e => {
    elMaxVal.textContent = e.target.value;
    storageSet({ [V3K.maxItems]: parseInt(e.target.value, 10) });
  });
  elScrapeMode.addEventListener('change', e => storageSet({ [V3K.scrapeMode]: e.target.value }));

  async function loadGenres() {
    const res = await sendMsg({ action: 'v3_getGenres' });
    availableGenres = res && res.ok && Array.isArray(res.genres) ? res.genres : [];
    selectedGenres = selectedGenres.filter(genre => availableGenres.includes(genre));
    if (!selectedGenres.length) selectedGenres = availableGenres.slice();
    persistSelectedGenres();
    renderGenreCheckboxes();
  }

  function persistSelectedGenres() {
    storageSet({ [V3K.selectedGenres]: selectedGenres });
  }

  function renderGenreCheckboxes() {
    elGenresContainer.innerHTML = availableGenres.map((genre, index) => {
      const id = `v3-genre-${index}`;
      const checked = selectedGenres.includes(genre);
      return `<label class="v3-genre-item${checked ? ' checked' : ''}" for="${id}">
        <input type="checkbox" id="${id}" value="${escapeHtml(genre)}" ${checked ? 'checked' : ''}>
        <span>${escapeHtml(genre)}</span>
      </label>`;
    }).join('');
    elGenresContainer.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.addEventListener('change', () => {
        selectedGenres = Array.from(elGenresContainer.querySelectorAll('input[type="checkbox"]:checked')).map(el => el.value);
        persistSelectedGenres();
        renderGenreCheckboxes();
      });
    });
    elGenreSummary.textContent = `${selectedGenres.length} / ${availableGenres.length} 選択`;
  }

  async function loadAreasForInput() {
    const area = elCity.value.trim();
    if (!area) { alert('市名を入力してください'); return; }

    const res = await sendMsg({ action: 'v3_getAreas', city: area });
    availableAreas = res && res.ok && Array.isArray(res.areas) ? res.areas : [];
    if (!availableAreas.length) {
      fetchedAreaInput = '';
      elAreaPicker.hidden = true;
      renderAreaCheckboxes();
      alert('エリアを取得できませんでした。「市」を含めて入力してください。');
      return;
    }
    fetchedAreaInput = normalizeAreaText(area);
    selectedAreas = selectedAreas.filter(areaName => availableAreas.includes(areaName));
    if (!selectedAreas.length && availableAreas.length) {
      selectedAreas = availableAreas.slice();
      persistSelectedAreas();
    }
    elAreaPicker.hidden = availableAreas.length === 0;
    renderAreaCheckboxes();
  }

  function persistSelectedAreas() {
    storageSet({ [V3K.selectedAreas]: selectedAreas });
  }

  function renderAreaCheckboxes() {
    if (!availableAreas.length) {
      elAreasContainer.className = 'v3-areas-container empty';
      elAreasContainer.innerHTML = '<span class="v3-empty">市名を入力して「区を取得」を押してください。</span>';
      elAreaSummary.textContent = '';
      return;
    }

    elAreasContainer.className = 'v3-areas-container';
    elAreasContainer.innerHTML = availableAreas.map((areaName, index) => {
      const id = `v3-area-${index}`;
      const checked = selectedAreas.includes(areaName);
      return `<label class="v3-area-item${checked ? ' checked' : ''}" for="${id}">
        <input type="checkbox" id="${id}" value="${escapeHtml(areaName)}" ${checked ? 'checked' : ''}>
        <span>${escapeHtml(areaName)}</span>
      </label>`;
    }).join('');

    elAreasContainer.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.addEventListener('change', () => {
        selectedAreas = Array.from(elAreasContainer.querySelectorAll('input[type="checkbox"]:checked')).map(el => el.value);
        persistSelectedAreas();
        renderAreaCheckboxes();
      });
    });
    elAreaSummary.textContent = `${selectedAreas.length} / ${availableAreas.length} 選択`;
  }

  btnStart.addEventListener('click', async () => {
    const area = elCity.value.trim();
    if (!area) { alert('エリアを入力してください'); return; }
    if (!selectedGenres.length) { alert('取得するジャンルを選択してください'); return; }
    if (normalizeAreaText(area) !== fetchedAreaInput) { alert('先に「区を取得」を押してください'); return; }
    if (!selectedAreas.length) { alert('取得するエリアを選択してください'); return; }
    const targetAreas = selectedAreas.map(areaName => composeSelectedArea(area, areaName));
    const tasks = targetAreas.flatMap(targetArea => selectedGenres.map(genre => ({
      area: targetArea,
      keyword: genre,
      outputGenre: genre
    })));

    const maxItems = parseInt(elMaxRange.value, 10) || 100;
    const scrapeMode = elScrapeMode.value || 'standard';
    const baseCity = elCity.value.trim() || tasks[0]?.area || '';
    await storageSet({
      [V3K.city]: baseCity,
      [V3K.selectedGenres]: selectedGenres,
      [V3K.maxItems]: maxItems,
      [V3K.scrapeMode]: scrapeMode
    });

    const res = await sendMsg({
      action: 'v3_start',
      city: baseCity,
      tasks,
      maxItems,
      scrapeMode,
      rangeMode: 'whole',
      keywordMode: true
    });
    if (res && res.ok) {
      btnStart.disabled = true;
      btnStop.disabled = false;
    } else {
      alert(`開始できませんでした: ${res?.error || 'unknown error'}`);
    }
  });

  btnStop.addEventListener('click', async () => {
    if (!confirm('取得を停止しますか？取得済みデータは保存されます。')) return;
    await sendMsg({ action: 'v3_stop' });
    btnStop.disabled = true;
    btnStart.disabled = false;
  });

  btnReset.addEventListener('click', async () => {
    if (!confirm('進捗・ログ・取得済みデータをすべて削除しますか？')) return;
    await sendMsg({ action: 'v3_reset' });
    refreshStatus(true);
  });

  btnCsv.addEventListener('click', async () => {
    const res = await sendMsg({ action: 'triggerV3Download', runId: `manual_${Date.now()}` });
    if (!res || !res.ok) alert('CSV出力に失敗しました');
  });
  btnXlsx.addEventListener('click', () => downloadXlsx());

  async function downloadXlsx() {
    const r = await storageGet([V3K.collected, V3K.city]);
    const data = Array.isArray(r[V3K.collected]) ? r[V3K.collected] : [];
    if (!data.length) { alert('取得データがありません'); return; }
    const blob = toSpreadsheetXmlBlob(data);
    const d = new Date();
    const z = n => String(n).padStart(2, '0');
    const name = `${buildExportName(data, r[V3K.city])}_${d.getFullYear()}${z(d.getMonth()+1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}.xls`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sanitize(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 50); }
  function splitAreaText(area) {
    const text = String(area || '').replace(/\s+/g, '').trim();
    const m = text.match(/^((?:北海道|東京都|大阪府|京都府|.{2,3}県))?((?:.+?郡.+?[町村]|.+?市.+?区|.+?[市区町村]))?/);
    return { prefecture: m?.[1] || '', city: m?.[2] || text };
  }
  function buildExportName(data, fallbackArea) {
    const first = data[0] || {};
    const area = splitAreaText(first.area || first.searchArea || fallbackArea || '');
    const city = area.city || area.prefecture || 'list';
    const genre = first.genre || first.searchGenre || 'ジャンル';
    const uniqueKeys = new Set(data.map(item => {
      const itemArea = splitAreaText(item.area || item.searchArea || fallbackArea || '');
      return `${itemArea.city || itemArea.prefecture || ''}\u0001${item.genre || item.searchGenre || ''}`;
    }));
    return sanitize(uniqueKeys.size === 1 ? `${city}_${genre}` : `${city}_${genre}_ほか`);
  }
  function escXml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\n/g, '&#10;');
  }
  function rowValues(it) {
    return [
      it.name, it.genre, it.searchGenre, it.sourceGenre, it.prefecture, it.city, it.address, it.phone,
      it.regularHoliday, it.businessDays, it.openTimeA, it.closeTimeA, it.openTimeB, it.closeTimeB,
      it.rawHours, it.url, it.hasWebsite || '無', it.source || 'GoogleMap', it.sourceUrl, it.scrapedAt,
      it.area || it.searchArea, it.searchQuery || it.searchKey, it.googleGenre || it.sourceGenre, it.scrapeMode, it.acquisitionStatus || '取得成功',
      it.detailRetryCount ?? '', it.listRank ?? ''
    ];
  }
  function toSpreadsheetXmlBlob(data) {
    const headerRow = `<Row>${OUTPUT_HEADERS.map(h => `<Cell><Data ss:Type="String">${escXml(h)}</Data></Cell>`).join('')}</Row>`;
    const rows = data.map(it => `<Row>${rowValues(it).map(v => `<Cell><Data ss:Type="String">${escXml(v)}</Data></Cell>`).join('')}</Row>`).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Scraped Data"><Table>${headerRow}${rows}</Table></Worksheet></Workbook>`;
    return new Blob(['\uFEFF' + xml], { type: 'application/vnd.ms-excel' });
  }

  async function refreshStatus(forceLogs = false) {
    const r = await sendMsg({ action: 'v3_getStatus' });
    if (!r || !r.ok) return;
    const s = r.status || {};
    const state = s[V3K.state] || 'idle';
    const running = state === 'running';
    btnStart.disabled = running;
    btnStop.disabled = !running;

    const statusBadge = document.getElementById('v3-status-badge');
    const statusMap = {
      running: ['実行中', '#1A73E8'],
      stopped_by_user: ['ユーザー停止', '#F29900'],
      done: ['完了', '#34A853'],
      error: ['エラー', '#EA4335'],
      idle: ['待機中', '#777']
    };
    const [label, color] = statusMap[state] || statusMap.idle;
    statusBadge.textContent = label;
    statusBadge.style.color = color;

    elCurArea.textContent = s[V3K.currentArea] || '-';
    elCurGenre.textContent = s[V3K.currentGenre] || '-';
    elCurKw.textContent = s[V3K.currentKw] || '-';
    elCurUrl.textContent = s[V3K.currentUrl] || '-';
    elCurUrl.title = s[V3K.currentUrl] || '';

    const totalTasks = s[V3K.totalTasks] || s[V3K.totalAreas] || 0;
    const taskIdx = s[V3K.taskIdx] ?? s[V3K.areaIdx] ?? 0;
    elAreaProg.textContent = `${Math.min(taskIdx + (running ? 1 : 0), totalTasks)} / ${totalTasks}`;
    elGenreProg.textContent = s[V3K.currentGenre] ? '任意入力' : '-';

    const collected = Array.isArray(s[V3K.collected]) ? s[V3K.collected] : [];
    elTotalCnt.textContent = `${collected.length}件`;
    btnCsv.disabled = collected.length === 0;
    btnXlsx.disabled = collected.length === 0;

    const start = s[V3K.startTime] || 0;
    const elapsedSec = start ? ((Date.now() - start) / 1000) : 0;
    elElapsed.textContent = fmtHMS(elapsedSec);

    const durations = Array.isArray(s[V3K.comboDurations]) ? s[V3K.comboDurations] : [];
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const remain = Math.max(0, totalTasks - taskIdx - (running ? 1 : 0));
    elEta.textContent = running && avg > 0 && remain > 0 ? fmtHMS(avg * remain) : (state === 'done' || state === 'stopped_by_user' ? '00:00:00' : '--:--:--');

    const pct = totalTasks > 0 ? Math.min(100, (taskIdx / totalTasks) * 100) : 0;
    elBar.style.width = pct.toFixed(1) + '%';

    const logs = Array.isArray(s[V3K.logs]) ? s[V3K.logs] : [];
    if (forceLogs || elLog.dataset.logCount !== String(logs.length)) {
      renderLogs(logs);
      elLog.dataset.logCount = String(logs.length);
    }
    renderPreview(collected);
  }

  function renderLogs(logs) {
    elLog.innerHTML = logs.slice(-200).map(L => `<div class="row"><span class="ts">[${L.t}]</span><span class="msg">${escapeHtml(L.msg)}</span></div>`).join('');
    elLog.scrollTop = elLog.scrollHeight;
  }
  function renderPreview(collected) {
    const last20 = collected.slice(-20).reverse();
    elPrevBody.innerHTML = last20.map(it => `<tr><td title="${escapeHtml(it.name || '')}">${escapeHtml(it.name || '-')}</td><td>${escapeHtml(it.genre || '-')}</td><td title="${escapeHtml(it.address || '')}">${escapeHtml(it.address || '-')}</td></tr>`).join('');
    elPrevSum.textContent = collected.length ? `（累計 ${collected.length}件）` : '';
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  chrome.runtime.onMessage.addListener(req => {
    if (!req || !req.action) return;
    if (['v3_logPush', 'v3_progress', 'v3_done'].includes(req.action)) refreshStatus();
  });
});
