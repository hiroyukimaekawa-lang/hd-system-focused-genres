// popup.js

document.addEventListener('DOMContentLoaded', () => {
  const maxItemsSlider = document.getElementById('max-items');
  const maxItemsVal = document.getElementById('max-items-val');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnReset = document.getElementById('btn-reset');
  const btnDownload = document.getElementById('btn-download');
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const countDisplay = document.getElementById('count-display');
  const previewBody = document.getElementById('preview-body');

  const targetGenresTextarea = document.getElementById('target-genres');
  const containerPreset = document.getElementById('preset-genres');
  const suggestedGenresContainer = document.getElementById('suggested-genres');
  const btnFetchGenres = document.getElementById('btn-fetch-genres');
  const currentQuerySpan = document.getElementById('current-query');

  const searchAreaInput = document.getElementById('search-area');
  const searchKeywordInput = document.getElementById('search-keyword');
  const btnOpenMap = document.getElementById('btn-open-map');

  // HDシステム投入用ジャンルのプリセット
  const PRESET_GENRES_MAP = {
    'カフェ': ['カフェ'],
    '居酒屋': ['居酒屋'],
    'スナック': ['スナック'],
    'Bar': ['Bar'],
    'パン屋': ['パン屋'],
    '焼き鳥': ['焼き鳥'],
    '喫茶店': ['喫茶店'],
    'お好み焼き': ['お好み焼き'],
    '焼肉': ['焼肉'],
    'スイーツ': ['スイーツ'],
    '美容院': ['美容院'],
    '中華': ['中華'],
    'ハンバーガー': ['ハンバーガー'],
    '蕎麦・うどん': ['蕎麦・うどん'],
    '寿司': ['寿司'],
    '和食': ['和食'],
    '洋食': ['洋食'],
    '定食・食堂': ['定食・食堂'],
    '弁当': ['弁当'],
    '韓国': ['韓国'],
    'テイクアウト専門店': ['テイクアウト専門店'],
    'ラーメン': ['ラーメン'],
  };

  // ── 初期化 ────────────────────────────────────────────────
  chrome.storage.local.get(['scrapingState', 'scrapedData', 'maxItems', 'targetGenres', 'searchArea', 'searchKeyword'], (result) => {
    if (result.searchArea) searchAreaInput.value = result.searchArea;
    if (result.searchKeyword) searchKeywordInput.value = result.searchKeyword;

    if (result.maxItems) {
      maxItemsSlider.value = result.maxItems;
      updateMaxItemsText(result.maxItems);
    }

    if (result.targetGenres) {
      targetGenresTextarea.value = result.targetGenres;
    }

    renderPresetGenres();
    updateQueryDisplay();
    updateUI(result.scrapingState || 'inactive', result.scrapedData || []);
  });

  // 有効なGoogleマップタブであるかを検証して無駄な通信エラーを防止
  function isValidMapTab(tab) {
    if (!tab || !tab.url) return false;
    return tab.url.includes('google.co.jp/maps') || tab.url.includes('googleusercontent.com') || tab.url.includes('google.com/maps');
  }

  async function updateQueryDisplay() {
    const tab = await getCurrentTab();
    if (!isValidMapTab(tab)) {
      chrome.storage.local.get(['lastQuery'], (res) => { currentQuerySpan.textContent = res.lastQuery || '-'; });
      return;
    }

    try {
      chrome.tabs.sendMessage(tab.id, { action: 'getQuery' }, (response) => {
        if (chrome.runtime.lastError) {
          chrome.storage.local.get(['lastQuery'], (res) => { currentQuerySpan.textContent = res.lastQuery || '-'; });
          return;
        }
        if (response && response.query) {
          currentQuerySpan.textContent = response.query;
          chrome.storage.local.set({ lastQuery: response.query });
        } else {
          chrome.storage.local.get(['lastQuery'], (res) => { currentQuerySpan.textContent = res.lastQuery || '-'; });
        }
      });
    } catch (e) {
      chrome.storage.local.get(['lastQuery'], (res) => { currentQuerySpan.textContent = res.lastQuery || '-'; });
    }
  }

  maxItemsSlider.addEventListener('input', (e) => {
    const val = e.target.value;
    updateMaxItemsText(val);
    chrome.storage.local.set({ maxItems: parseInt(val, 10) });
  });

  function updateMaxItemsText(val) {
    maxItemsVal.textContent = val == 500 ? '上限なし' : val;
  }

  searchAreaInput.addEventListener('input', () => {
    chrome.storage.local.set({ searchArea: searchAreaInput.value });
  });

  searchKeywordInput.addEventListener('input', () => {
    chrome.storage.local.set({ searchKeyword: searchKeywordInput.value });
  });

  btnOpenMap.addEventListener('click', () => {
    const area = searchAreaInput.value.trim();
    const kw = searchKeywordInput.value.trim();
    if (!area && !kw) { alert('エリアまたはキーワードを入力してください'); return; }
    const query = `${area} ${kw}`.trim();
    chrome.storage.local.set({ searchArea: area, searchKeyword: kw, lastQuery: query }, () => {
      const url = `https://www.google.co.jp/maps/search/${encodeURIComponent(query)}`;
      chrome.tabs.create({ url });
    });
  });

  targetGenresTextarea.addEventListener('input', () => {
    chrome.storage.local.set({ targetGenres: targetGenresTextarea.value });
    renderPresetGenres();
  });

  btnFetchGenres.addEventListener('click', async () => {
    const tab = await getCurrentTab();
    if (!isValidMapTab(tab)) { alert('Googleマップの検索画面で実行してください。'); return; }
    btnFetchGenres.textContent = '取得中...';
    chrome.tabs.sendMessage(tab.id, { action: 'getGenresFromPage' }, (response) => {
      if (chrome.runtime.lastError) { btnFetchGenres.textContent = '読み込み失敗'; return; }
      btnFetchGenres.textContent = '現在のページからジャンルを読み込む';
      if (response && response.genres) { renderGenreChips(response.genres); }
    });
  });

  function renderGenreChips(genres) {
    suggestedGenresContainer.innerHTML = '';
    const currentGenres = targetGenresTextarea.value.split(/[\n,]/).map(s => s.trim());
    genres.forEach(genre => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      if (currentGenres.includes(genre)) chip.classList.add('active');
      chip.textContent = genre;
      chip.onclick = () => {
        let currentKeywords = targetGenresTextarea.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
        if (currentKeywords.includes(genre)) {
          currentKeywords = currentKeywords.filter(g => g !== genre);
          chip.classList.remove('active');
        } else {
          currentKeywords.push(genre);
          chip.classList.add('active');
        }
        targetGenresTextarea.value = currentKeywords.join(', ');
        chrome.storage.local.set({ targetGenres: targetGenresTextarea.value });
        renderPresetGenres();
      };
      suggestedGenresContainer.appendChild(chip);
    });
  }

  function renderPresetGenres() {
    if (!containerPreset) return;
    containerPreset.innerHTML = '';
    const currentKeywords = targetGenresTextarea.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);

    Object.keys(PRESET_GENRES_MAP).forEach((genre, index) => {
      const div = document.createElement('div');
      div.className = 'preset-item';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id = `preset-chk-${index}`;
      chk.value = genre;

      const extKeywords = PRESET_GENRES_MAP[genre];
      chk.checked = extKeywords.every(kw => currentKeywords.includes(kw));

      chk.addEventListener('change', () => {
        let currentKeywords = targetGenresTextarea.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
        if (chk.checked) {
          extKeywords.forEach(kw => { if (!currentKeywords.includes(kw)) currentKeywords.push(kw); });
        } else {
          currentKeywords = currentKeywords.filter(kw => !extKeywords.includes(kw));
        }
        targetGenresTextarea.value = currentKeywords.join(', ');
        chrome.storage.local.set({ targetGenres: targetGenresTextarea.value });
      });

      const lbl = document.createElement('label');
      lbl.htmlFor = chk.id;
      lbl.textContent = genre;

      div.appendChild(chk);
      div.appendChild(lbl);
      containerPreset.appendChild(div);
    });
  }

  function parseQueryToAreaGenre(query) {
    if (query.includes('✖️') || query.includes('×')) {
      const sep = query.includes('✖️') ? '✖️' : '×';
      const parts = query.split(sep).map(s => s.trim());
      const areaIdx = parts.findIndex(p => isAreaToken(p));
      if (areaIdx !== -1) return { area: parts[areaIdx], genre: parts.find((_, i) => i !== areaIdx) || '' };
      return { area: parts[0] || '', genre: parts[1] || '' };
    }
    const tokens = query.split(/[\s\u3000]+/).filter(Boolean);
    if (tokens.length === 0) return { area: '', genre: '' };
    if (tokens.length === 1) return isAreaToken(tokens[0]) ? { area: tokens[0], genre: '' } : { area: '', genre: tokens[0] };
    let areaTokens = [], genreTokens = [], switchedToGenre = false;
    for (const token of tokens) {
      if (!switchedToGenre && isAreaToken(token)) { areaTokens.push(token); } else { switchedToGenre = true; genreTokens.push(token); }
    }
    if (areaTokens.length === 0) { areaTokens = [tokens[0]]; genreTokens = tokens.slice(1); }
    return { area: areaTokens.join(''), genre: genreTokens.join('') };
  }

  function isAreaToken(token) {
    if (/[市区町村都府道県]$/.test(token)) return true;
    const prefectures = ['北海道', '東京', '大阪', '京都', '神奈川', '愛知', '福岡', '沖縄', '埼玉', '千葉', '兵庫', '静岡', '茨城', '広島', '宮城'];
    if (prefectures.includes(token)) return true;
    const cities = ['渋谷', '新宿', '池袋', '銀座', '品川', '秋葉原', '浅草', '上野', '吉祥寺', '横浜', '梅田', '難波', '心斎橋', '天王寺', '栄', '名古屋', '博多', '天神', '札幌', '仙台', '広島', '京都', '神戸', '川崎', '千葉', '船橋', '松山', '金沢', '高松', '那覇', '盛岡', '秋田', '山形', '水戸', '宇都宮', '前橋', '甲府', '長野', '岐阜', '津', '大津', '奈良', '和歌山', '鳥取', '松江', '岡山', '山口', '徳島', '高知', '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島'];
    return cities.includes(token);
  }

  function startScraping(tab, maxItems, targetGenres) {
  const areaInput = searchAreaInput.value.trim();
  let detectedArea = areaInput;

  if (!detectedArea) {
    const currentQ = currentQuerySpan.textContent || "";
    const parsed = parseQueryToAreaGenre(currentQ);
    detectedArea = parsed.area;
  }

  const runId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  chrome.storage.local.set({ 
    scrapingState: 'active',
    currentRunId: runId
  }, () => {
    try {
      chrome.tabs.sendMessage(tab.id, {
        action: 'startScraping',
        maxItems: maxItems,
        targetGenres: targetGenres,
        filterConfig: { enabled: false },
        searchArea: detectedArea,
        searchGenre: targetGenres.join(',')
      }, (response) => {
        if (chrome.runtime.lastError) {
          alert('ページの再読み込みが必要です。ページをリロードしてからお試しください。');
          chrome.storage.local.set({ scrapingState: 'inactive' });
        }
      });
    } catch (e) { }
  });
}

  btnStart.addEventListener('click', async () => {
    const tab = await getCurrentTab();
    if (!isValidMapTab(tab)) { alert('Googleマップの画面で実行してください。'); return; }

    const maxItems = maxItemsSlider.value == 500 ? 999999 : parseInt(maxItemsSlider.value, 10);
    const targetGenres = targetGenresTextarea.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);

    chrome.storage.local.get(['scrapedData'], (result) => {
      const currentData = result.scrapedData || [];
      if (currentData.length > 0) {
        if (confirm('既存のデータをクリアして新しく開始しますか？\n（「キャンセル」で既存データに追加取得します）')) {
          chrome.storage.local.set({ scrapedData: [] }, () => { startScraping(tab, maxItems, targetGenres); });
          return;
        }
      }
      startScraping(tab, maxItems, targetGenres);
    });
  });

  btnStop.addEventListener('click', async () => {
    const tab = await getCurrentTab();
    chrome.storage.local.set({ scrapingState: 'inactive' });
    if (tab && isValidMapTab(tab)) chrome.tabs.sendMessage(tab.id, { action: 'stopScraping' });
  });

  btnReset.addEventListener('click', () => {
    if (confirm('取得済みのデータをすべて削除しますか？')) {
      chrome.storage.local.set({ scrapedData: [], scrapingState: 'inactive' }, () => { updateUI('inactive', []); });
    }
  });

  btnDownload.addEventListener('click', async () => {
    const tab = await getCurrentTab();
    let query = '';
    if (tab && isValidMapTab(tab)) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'getQuery' });
        query = response ? response.query : '';
      } catch (e) { }
    }

    chrome.storage.local.get(['scrapedData'], (result) => {
      let data = result.scrapedData || [];
      if (data.length === 0) return;

      const headers = ['name', 'genre', 'address', 'phone', 'regular_holiday', 'opening_hours_details', 'rating', 'reviews', 'lat', 'lng', 'distance_m', 'url', 'source'];
      let csvContent = '\uFEFF' + headers.join(',') + '\n';

      data.forEach(item => {
        const row = [
          `"${(item.name || '').replace(/"/g, '""')}"`,
          `"${(item.genre || '').replace(/"/g, '""')}"`,
          `"${(item.address || '').replace(/"/g, '""')}"`,
          `"${(item.phone || '').replace(/"/g, '""')}"`,
          `"${(item.regularHoliday || '年中無休').replace(/"/g, '""')}"`,
          `"${(item.openingHoursDetails || '情報なし').replace(/"/g, '""')}"`,
          `"${(item.rating || '').replace(/"/g, '""')}"`,
          `"${(item.reviews || '').replace(/"/g, '""')}"`,
          `"${item.lat ?? ''}"`,
          `"${item.lng ?? ''}"`,
          `"${item.distanceMeters ?? ''}"`,
          `"${(item.url || '').replace(/"/g, '""')}"`,
          `"googlemaps"`
        ];
        csvContent += row.join(',') + '\n';
      });

      const date = new Date();
      const dateStr = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`;
      const filename = `${(query || 'Googleマップ').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_')}_Googleマップ_${dateStr}.csv`;

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  });

  function updateUI(state, data) {
    const totalCount = data.length;
    countDisplay.textContent = totalCount;

    previewBody.innerHTML = '';
    data.slice(-5).reverse().forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td title="${item.name}">${item.name || '-'}</td>
        <td title="${item.genre}">${item.genre || '-'}</td>
        <td>${item.phone || '-'}</td>
        <td title="${item.businessHours || ''}">${item.businessHours || '-'}</td>
        <td title="${item.regularHoliday || '年中無休'}">${item.regularHoliday || '年中無休'}</td>
      `;
      previewBody.appendChild(tr);
    });

    if (state === 'active') {
      statusIndicator.className = 'indicator active';
      statusText.textContent = `リストを自動スクロール中... ${totalCount}件取得済み`;
      btnStart.disabled = true;
      btnStop.disabled = false;
      btnDownload.disabled = totalCount === 0;
    } else if (state === 'done') {
      statusIndicator.className = 'indicator done';
      statusText.textContent = `抽出完了: 合計 ${totalCount}件取得しました`;
      btnStart.disabled = false;
      btnStart.textContent = '▶ 再開・追加取得';
      btnStop.disabled = true;
      btnDownload.disabled = totalCount === 0;
    } else {
      statusIndicator.className = 'indicator inactive';
      statusText.textContent = totalCount > 0 ? `停止中: ${totalCount}件保持` : 'Googleマップの検索結果ページを開いてください';
      btnStart.disabled = false;
      btnStart.textContent = totalCount > 0 ? '▶ 再開・追加取得' : '▶ 取得開始';
      btnStop.disabled = true;
      btnDownload.disabled = totalCount === 0;
    }
  }

  async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      chrome.storage.local.get(['scrapingState', 'scrapedData', 'targetGenres'], (result) => {
        updateUI(result.scrapingState || 'inactive', result.scrapedData || []);

        if (result.targetGenres !== undefined) {
          targetGenresTextarea.value = result.targetGenres;
          renderPresetGenres();
        }
      });
    }
  });
});
