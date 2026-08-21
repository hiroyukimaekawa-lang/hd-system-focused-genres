// popup-v3.js
// ============================================================
// v3.0 Popup UI
//   - エリア選択（区チェックボックス）
//   - 全ジャンル自動取得 開始 / 停止 / リセット
//   - リアルタイム進捗表示
//   - ログ表示
//   - 最新20件プレビュー
//   - CSV / XLSX 出力（共通スキーマ対応）
//   - chrome.storage による状態復元
// ============================================================

const V3K = {
  state:        'v3_state',
  city:         'v3_city',
  areas:        'v3_areas',
  genres:       'v3_genres',
  totalAreas:   'v3_totalAreas',
  totalGenres:  'v3_totalGenres',
  areaIdx:      'v3_areaIdx',
  genreIdx:     'v3_genreIdx',
  currentArea:  'v3_currentArea',
  currentGenre: 'v3_currentGenre',
  currentUrl:   'v3_currentUrl',
  currentKw:    'v3_currentKeyword',
  logs:         'v3_logs',
  collected:    'v3_collectedData',
  startTime:    'v3_startTime',
  comboDurations: 'v3_comboDurations',
  maxItems:     'v3_maxItems',
  scrapeMode:   'v3_scrapeMode',
  rangeMode:    'v3_rangeMode'
};

// 出力項目（共通スキーマ + デバッグ項目）
const OUTPUT_HEADERS = [
  '店名', 'ジャンル', '検索ジャンル', '取得元ジャンル', '都道府県', '市区町村', '小エリア', '住所', '電話番号',
  '定休日', '営業日', '営業開始A', '営業終了A', '営業開始B', '営業終了B',
  '営業時間原文', 'URL', 'HP有無', '媒体', '取得元URL', '取得日時',
  '取得モード', '取得範囲モード', '取得ステータス', '除外理由', '一覧取得順', '詳細取得リトライ回数'
];

document.addEventListener('DOMContentLoaded', () => {
  // ---- DOM refs ----
  const elCity        = document.getElementById('v3-city-input');
  const btnLoadAreas  = document.getElementById('v3-load-areas');
  const elAreas       = document.getElementById('v3-areas-container');
  const elAreasActs   = document.getElementById('v3-areas-actions');
  const btnSelAll     = document.getElementById('v3-select-all');
  const btnClrAll     = document.getElementById('v3-clear-all');
  const elAreasSum    = document.getElementById('v3-areas-summary');
  const elGenres      = document.getElementById('v3-genres-container');
  const elGenresActs  = document.getElementById('v3-genres-actions');
  const btnGenreSelAll= document.getElementById('v3-genre-select-all');
  const btnGenreClrAll= document.getElementById('v3-genre-clear-all');
  const elGenresSum   = document.getElementById('v3-genres-summary');
  const elMaxRange    = document.getElementById('v3-max-items');
  const elMaxVal      = document.getElementById('v3-max-val');
  const elScrapeMode  = document.getElementById('v3-scrape-mode');
  const elRangeMode   = document.getElementById('v3-range-mode');
  const btnStart      = document.getElementById('v3-start');
  const btnStop       = document.getElementById('v3-stop');
  const btnReset      = document.getElementById('v3-reset');
  const btnCsv        = document.getElementById('v3-download-csv');
  const btnXlsx       = document.getElementById('v3-download-xlsx');
  const elCurArea     = document.getElementById('v3-cur-area');
  const elCurGenre    = document.getElementById('v3-cur-genre');
  const elAreaProg    = document.getElementById('v3-area-progress');
  const elGenreProg   = document.getElementById('v3-genre-progress');
  const elTotalCnt    = document.getElementById('v3-total-count');
  const elElapsed     = document.getElementById('v3-elapsed');
  const elEta         = document.getElementById('v3-eta');
  const elCurKw       = document.getElementById('v3-cur-keyword');
  const elCurUrl      = document.getElementById('v3-cur-url');
  const elBar         = document.getElementById('v3-bar');
  const elLog         = document.getElementById('v3-log');
  const elPrevBody    = document.getElementById('v3-preview-body');
  const elPrevSum     = document.getElementById('v3-preview-summary');

  // ---- util ----
  const sendMsg = (msg) => new Promise(resolve => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) {
        console.error(`[popup-v3] ${msg.action} failed:`, chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
  const storageGet = (keys) => new Promise(r => chrome.storage.local.get(keys, r));
  const storageSet = (obj)  => new Promise(r => chrome.storage.local.set(obj, r));
  const fmtHMS = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
    const z = n => String(n).padStart(2,'0');
    return `${z(h)}:${z(m)}:${z(s)}`;
  };

  // ---- 初期化 ----
  (async () => {
    const stored = await storageGet([V3K.city, V3K.maxItems, V3K.scrapeMode, V3K.rangeMode]);
    if (stored[V3K.city]) elCity.value = stored[V3K.city];
    if (stored[V3K.scrapeMode]) elScrapeMode.value = stored[V3K.scrapeMode];
    if (stored[V3K.rangeMode]) elRangeMode.value = stored[V3K.rangeMode];
    if (stored[V3K.maxItems]) {
      elMaxRange.value = stored[V3K.maxItems];
      elMaxVal.textContent = stored[V3K.maxItems];
    }

    // ジャンル表示
    const gRes = await sendMsg({ action: 'v3_getGenres' });
    if (gRes && gRes.ok && Array.isArray(gRes.genres)) {
      renderGenres(gRes.genres);
    } else {
      console.error('[popup-v3] v3_getGenres returned an invalid response:', gRes);
      renderGenres([]);
    }

    // エリア入力済みなら自動で区一覧を取得
    if (elCity.value.trim()) loadAreas();

    // 状態復元
    refreshStatus(true);
    setInterval(refreshStatus, 1000);
  })();

  // ---- ジャンル一覧表示 ----
  function renderGenres(genres) {
    elGenres.className = 'v3-genres-container';
    elGenres.innerHTML = '';
    if (!genres || !genres.length) {
      elGenres.className = 'v3-genres-container empty';
      elGenres.innerHTML = '<span class="v3-empty">ジャンル未設定</span>';
      elGenresActs.style.display = 'none';
      return;
    }
    genres.forEach((name, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'v3-genre-item checked';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id = `v3-genre-${i}`;
      chk.checked = true;
      chk.value = name;
      const lbl = document.createElement('label');
      lbl.htmlFor = chk.id;
      lbl.textContent = name;
      chk.addEventListener('change', () => {
        wrap.classList.toggle('checked', chk.checked);
        updateGenreSummary();
      });
      wrap.appendChild(chk);
      wrap.appendChild(lbl);
      elGenres.appendChild(wrap);
    });
    elGenresActs.style.display = '';
    updateGenreSummary();
  }

  function getSelectedGenres() {
    return Array.from(elGenres.querySelectorAll('input[type="checkbox"]'))
      .filter(c => c.checked).map(c => c.value);
  }
  function allGenres() {
    return Array.from(elGenres.querySelectorAll('input[type="checkbox"]')).map(c => c.value);
  }
  function updateGenreSummary() {
    const sel = getSelectedGenres().length;
    const tot = elGenres.querySelectorAll('input[type="checkbox"]').length;
    elGenresSum.textContent = `${sel} / ${tot} ジャンル 選択中`;
  }

  function normalizeAreaText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .trim();
  }

  function displayAreaName(value) {
    const normalized = normalizeAreaText(value);
    const match = normalized.match(/^((?:北海道|東京都|大阪府|京都府|.{2,3}県))?((?:.+?郡.+?[町村]|.+?市.+?区|.+?[市区町村]))?/);
    return match?.[2] || normalized;
  }

  function clearAreas() {
    elAreas.className = 'v3-areas-container empty';
    elAreas.innerHTML = '<div class="v3-empty">エリアを入力して「区を取得」を押すと、取得対象エリアが表示されます。</div>';
    elAreasActs.style.display = 'none';
    elAreasSum.textContent = '';
  }

  // ---- 区一覧読み込み ----
  async function loadAreas() {
    const city = elCity.value.trim();
    if (!city) {
      clearAreas();
      return;
    }
    await storageSet({ [V3K.city]: city });
    btnLoadAreas.textContent = '取得中...';
    btnLoadAreas.disabled = true;
    try {
      const res = await sendMsg({ action: 'v3_getAreas', city });
      if (!res || !res.ok || !res.areas.length) {
        renderAreas([displayAreaName(city)]);
        return;
      }
      renderAreas(res.areas);
    } finally {
      btnLoadAreas.textContent = '区を取得';
      btnLoadAreas.disabled = false;
    }
  }

  function renderAreas(areas) {
    elAreas.className = 'v3-areas-container';
    elAreas.innerHTML = '';
    areas.forEach((name, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'v3-area-item checked';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id = `v3-area-${i}`;
      chk.checked = true;
      chk.value = name;
      const lbl = document.createElement('label');
      lbl.htmlFor = chk.id;
      lbl.textContent = name;
      chk.addEventListener('change', () => {
        wrap.classList.toggle('checked', chk.checked);
        updateSummary();
      });
      wrap.appendChild(chk);
      wrap.appendChild(lbl);
      elAreas.appendChild(wrap);
    });
    elAreasActs.style.display = '';
    updateSummary();
  }

  function getSelectedAreas() {
    return Array.from(elAreas.querySelectorAll('input[type="checkbox"]'))
      .filter(c => c.checked).map(c => c.value);
  }
  function allAreas() {
    return Array.from(elAreas.querySelectorAll('input[type="checkbox"]')).map(c => c.value);
  }
  function updateSummary() {
    const sel = getSelectedAreas().length;
    const tot = elAreas.querySelectorAll('input[type="checkbox"]').length;
    elAreasSum.textContent = `${sel} / ${tot} エリア 選択中`;
  }

  btnLoadAreas.addEventListener('click', loadAreas);
  elCity.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadAreas(); } });
  elCity.addEventListener('input', () => {
    clearAreas();
    storageSet({ [V3K.city]: elCity.value.trim(), [V3K.areas]: [] });
  });
  btnSelAll.addEventListener('click', () => {
    elAreas.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = true; c.dispatchEvent(new Event('change')); });
  });
  btnClrAll.addEventListener('click', () => {
    elAreas.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = false; c.dispatchEvent(new Event('change')); });
  });
  btnGenreSelAll.addEventListener('click', () => {
    elGenres.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = true; c.dispatchEvent(new Event('change')); });
  });
  btnGenreClrAll.addEventListener('click', () => {
    elGenres.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = false; c.dispatchEvent(new Event('change')); });
  });

  // ---- max items ----
  elMaxRange.addEventListener('input', e => {
    elMaxVal.textContent = e.target.value;
    storageSet({ [V3K.maxItems]: parseInt(e.target.value, 10) });
  });
  elScrapeMode.addEventListener('change', e => storageSet({ [V3K.scrapeMode]: e.target.value }));
  elRangeMode.addEventListener('change', e => storageSet({ [V3K.rangeMode]: e.target.value }));

  // ---- 開始 ----
  btnStart.addEventListener('click', async () => {
    const city = elCity.value.trim();
    if (!city) { alert('エリア（例: さいたま市）を入力してください'); return; }

    let selAreas = getSelectedAreas();
    const all = allAreas();
    if (all.length === 0) {
      selAreas = [];
    } else if (selAreas.length === 0) {
      selAreas = all;
    }

    let genres = getSelectedGenres();
    const allG = allGenres();
    if (genres.length === 0) {
      genres = allG;
    }

    const max = parseInt(elMaxRange.value, 10) || 100;
    const scrapeMode = elScrapeMode.value || 'standard';
    const rangeMode = elRangeMode.value || 'split';
    const res = await sendMsg({
      action: 'v3_start',
      city, areas: selAreas, genres, maxItems: max, scrapeMode, rangeMode
    });
    if (res && res.ok) {
      btnStart.disabled = true;
      btnStop.disabled = false;
    }
  });

  // ---- 停止 ----
  btnStop.addEventListener('click', async () => {
    if (!confirm('取得を停止しますか？')) return;
    await sendMsg({ action: 'v3_stop' });
    btnStop.disabled = true;
    btnStart.disabled = false;
  });

  // ---- リセット ----
  btnReset.addEventListener('click', async () => {
    if (!confirm('進捗・ログ・取得済みデータをすべて削除しますか？')) return;
    await sendMsg({ action: 'v3_reset' });
    refreshStatus(true);
  });

  // ---- ダウンロード ----
  btnCsv.addEventListener('click', () => downloadAs('csv'));
  btnXlsx.addEventListener('click', () => downloadAs('xlsx'));

  async function downloadAs(kind) {
    const r = await storageGet([V3K.collected, V3K.city]);
    const data = Array.isArray(r[V3K.collected]) ? r[V3K.collected] : [];
    if (!data.length) { alert('取得データがありません'); return; }
    const city = r[V3K.city] || 'GoogleMap';

    if (kind === 'csv') {
      const res = await sendMsg({ action: 'triggerV3Download', runId: `manual_${Date.now()}` });
      if (!res || !res.ok) alert('CSV出力に失敗しました');
      return;
    }

    const uniqueGenres = Array.from(new Set(data.map(it => it.sourceGenre).filter(Boolean)));
    const genresStr = uniqueGenres.length > 0
      ? uniqueGenres.slice(0, 5).join('_') + (uniqueGenres.length > 5 ? '等' : '')
      : '全ジャンル';

    const d = new Date();
    const z = n => String(n).padStart(2,'0');
    const dateStr = `${d.getFullYear()}${z(d.getMonth()+1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
    const sanitize = s => String(s || '').replace(/[\\/:*?"<>|]/g,'').replace(/\s+/g,'_').slice(0,50);

    const fileNameBase = `${sanitize(city)}_${sanitize(genresStr)}_${dateStr}`;

    const blob = toXlsxBlob(data);
    triggerDl(blob, `${fileNameBase}.xlsx`);
  }

  function toCsv(data) {
    const esc = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    let csv = OUTPUT_HEADERS.join(',') + '\n';
    for (const it of data) {
      csv += [
        esc(it.name),
        esc(it.genre),
        esc(it.searchGenre),
        esc(it.sourceGenre),
        esc(it.prefecture),
        esc(it.city),
        esc(it.subArea),
        esc(it.address),
        esc(it.phone),
        esc(it.regularHoliday),
        esc(it.businessDays),
        esc(it.openTimeA),
        esc(it.closeTimeA),
        esc(it.openTimeB),
        esc(it.closeTimeB),
        esc(it.rawHours),
        esc(it.url),
        esc(it.hasWebsite || '無'),
        esc(it.source || 'GoogleMap'),
        esc(it.sourceUrl),
        esc(it.scrapedAt),
        esc(it.scrapeMode || ''),
        esc(it.rangeMode || ''),
        esc(it.acquisitionStatus || '取得成功'),
        esc(it.excludeReason || ''),
        esc(it.listRank ?? ''),
        esc(it.detailRetryCount ?? '')
      ].join(',') + '\n';
    }
    return csv;
  }

  function triggerDl(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- XLSX (SpreadsheetML 2003 / .xlsx 互換 ASCII XML) ----
  function toXlsxBlob(data) {
    // 改行を Excelセル内の改行 (&#10;) に変換
    const escXml = s => String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&apos;')
      .replace(/\n/g, '&#10;');

    const rows = data.map(it => `
      <Row>
        ${[
           it.name, it.genre, it.searchGenre, it.sourceGenre, it.prefecture, it.city, it.subArea, it.address, it.phone,
           it.regularHoliday, it.businessDays, it.openTimeA, it.closeTimeA, it.openTimeB, it.closeTimeB,
           it.rawHours, it.url, it.hasWebsite || '無', it.source || 'GoogleMap', it.sourceUrl, it.scrapedAt,
           it.scrapeMode || '', it.rangeMode || '', it.acquisitionStatus || '取得成功', it.excludeReason || '',
           it.listRank ?? '', it.detailRetryCount ?? ''
          ].map(v => `<Cell><Data ss:Type="String">${escXml(v ?? '')}</Data></Cell>`).join('')}
      </Row>`).join('');

    const headerRow = `<Row>${OUTPUT_HEADERS.map(h =>
      `<Cell ss:StyleID="header"><Data ss:Type="String">${escXml(h)}</Data></Cell>`).join('')}</Row>`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="header">
      <Font ss:Bold="1" ss:Color="#FFFFFF"/>
      <Interior ss:Color="#1A73E8" ss:Pattern="Solid"/>
    </Style>
  </Styles>
  <Worksheet ss:Name="Scraped Data">
    <Table>
      ${headerRow}
      ${rows}
    </Table>
  </Worksheet>
</Workbook>`;
    return new Blob(['\uFEFF' + xml], { type: 'application/vnd.ms-excel' });
  }

  // ---- 状態取得 & 画面反映 ----
  async function refreshStatus(forceLogs = false) {
    const r = await sendMsg({ action: 'v3_getStatus' });
    if (!r || !r.ok) return;
    const s = r.status;

    const state = s[V3K.state] || 'idle';
    const running = state === 'running';
    btnStart.disabled = running;
    btnStop.disabled  = !running;

    // 状態に応じたヘッダー色・テキスト
    const header = document.querySelector('.v3-header') || document.querySelector('header');
    if (header) {
      header.style.borderBottom = '';
      if (state === 'running') {
        header.style.borderBottom = '3px solid #1A73E8';
      } else if (state === 'stopped_by_user') {
        header.style.borderBottom = '3px solid #F29900';
      } else if (state === 'done') {
        header.style.borderBottom = '3px solid #34A853';
      } else if (state === 'error') {
        header.style.borderBottom = '3px solid #EA4335';
      }
    }

    // ステータス表示
    const statusBadge = document.getElementById('v3-status-badge');
    if (statusBadge) {
      const statusMap = {
        running:          { text: '実行中', color: '#1A73E8' },
        stopped_by_user:  { text: 'ユーザー停止', color: '#F29900' },
        done:             { text: '完了', color: '#34A853' },
        error:            { text: 'エラー', color: '#EA4335' },
        idle:             { text: '待機中', color: '#999' }
      };
      const s2 = statusMap[state] || statusMap.idle;
      statusBadge.textContent = s2.text;
      statusBadge.style.color = s2.color;
    }

    elCurArea.textContent  = s[V3K.currentArea]  || '-';
    elCurGenre.textContent = s[V3K.currentGenre] || '-';
    elCurKw.textContent    = s[V3K.currentKw]    || '-';
    elCurUrl.textContent   = s[V3K.currentUrl]   || '-';
    elCurUrl.title         = s[V3K.currentUrl]   || '';

    const tA = s[V3K.totalAreas]  || 0;
    const tG = s[V3K.totalGenres] || 0;
    const aI = (s[V3K.areaIdx]  || 0);
    const gI = (s[V3K.genreIdx] || 0);
    elAreaProg.textContent  = `${Math.min(aI + (running?1:0), tA)} / ${tA}`;
    elGenreProg.textContent = `${Math.min(gI + (running?1:0), tG)} / ${tG}`;

    const collected = Array.isArray(s[V3K.collected]) ? s[V3K.collected] : [];
    elTotalCnt.textContent = `${collected.length}件`;
    btnCsv.disabled  = collected.length === 0;
    btnXlsx.disabled = collected.length === 0;

    // 経過時間
    const start = s[V3K.startTime] || 0;
    const elapsedSec = start ? ((Date.now() - start) / 1000) : 0;
    elElapsed.textContent = fmtHMS(elapsedSec);

    // 進捗率
    const totalCombos = tA * tG;
    const doneCombos = aI * tG + gI;
    const pct = totalCombos > 0 ? Math.min(100, (doneCombos / totalCombos) * 100) : 0;
    elBar.style.width = pct.toFixed(1) + '%';

    // バーの色を状態で変える
    const bar = document.getElementById('v3-bar');
    if (bar) {
      if (state === 'stopped_by_user') bar.style.background = '#F29900';
      else if (state === 'done')       bar.style.background = '#34A853';
      else if (state === 'error')      bar.style.background = '#EA4335';
      else                             bar.style.background = '';
    }

    // ETA
    const durations = Array.isArray(s[V3K.comboDurations]) ? s[V3K.comboDurations] : [];
    const avg = durations.length ? durations.reduce((a,b)=>a+b,0) / durations.length : 0;
    const remain = Math.max(0, totalCombos - doneCombos);
    if (running && avg > 0 && remain > 0) {
      elEta.textContent = fmtHMS(avg * remain);
    } else if (state === 'done' || state === 'stopped_by_user') {
      elEta.textContent = '00:00:00';
    } else {
      elEta.textContent = '--:--:--';
    }

    // ログ
    const logs = Array.isArray(s[V3K.logs]) ? s[V3K.logs] : [];
    if (forceLogs || elLog.dataset.logCount !== String(logs.length)) {
      renderLogs(logs);
      elLog.dataset.logCount = String(logs.length);
    }

    // プレビュー
    renderPreview(collected);
  }

  function renderLogs(logs) {
    const last = logs.slice(-200);
    elLog.innerHTML = last.map(L =>
      `<div class="row"><span class="ts">[${L.t}]</span><span class="msg">${escapeHtml(L.msg)}</span></div>`
    ).join('');
    elLog.scrollTop = elLog.scrollHeight;
  }

  function renderPreview(collected) {
    const last20 = collected.slice(-20).reverse();
    elPrevBody.innerHTML = last20.map(it => `
      <tr>
        <td title="${escapeHtml(it.name||'')}">${escapeHtml(it.name||'-')}</td>
        <td title="${escapeHtml(it.genre||'')}">${escapeHtml(it.genre||'-')}</td>
        <td title="${escapeHtml(it.address||'')}">${escapeHtml(it.address||'-')}</td>
      </tr>
    `).join('');
    elPrevSum.textContent = collected.length ? `（累計 ${collected.length}件）` : '';
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  chrome.runtime.onMessage.addListener((req) => {
    if (!req || !req.action) return;
    if (req.action === 'v3_logPush' || req.action === 'v3_progress' || req.action === 'v3_done') {
      refreshStatus();
    }
  });
});
