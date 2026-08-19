/**
 * popup.js v3.3.0
 */

'use strict';

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
const popularGenreBtn = document.getElementById('popularGenreBtn');

let allResults = [];
let isRunning = false;
let maxItems = 300;
let currentTabId = null;
let metadata = { area: '', industry: '', media: '' };

// ── スライダー ─────────────────────────────────────────────────────────────
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

// ── ログ追加 ───────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    const time = new Date().toLocaleTimeString('ja-JP', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    line.textContent = `[${time}] ${msg}`;
    logScroll.appendChild(line);
    logScroll.scrollTop = logScroll.scrollHeight;
    while (logScroll.children.length > 300) logScroll.removeChild(logScroll.firstChild);
}

// ── ステータス表示 ─────────────────────────────────────────────────────────
function setStatus(state, main, sub = '') {
    dot.className = `dot ${state}`;
    statusMain.textContent = main;
    statusSub.textContent = sub;
}

// ── プログレスバー ─────────────────────────────────────────────────────────
function updateProgress(collected, total) {
    if (total === Infinity || total === 0) {
        const pct = Math.min(95, 10 + collected * 2);
        progressBar.style.width = pct + '%';
        return;
    }
    const pct = Math.min(100, Math.round(collected / total * 100));
    progressBar.style.width = pct + '%';
}

// ── プレビューレンダリング ─────────────────────────────────────────────────
function esc(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPreview(data) {
    previewList.innerHTML = '';
    const items = data.slice(-30).reverse();
    items.forEach(r => {
        const el = document.createElement('div');
        el.className = 'preview-item';

        let hoursPreview = '';
        if (r.businessDays || r.openTimeA || r.closeTimeA) {
            hoursPreview += `<div class="pi-hours" style="font-size:10px;color:var(--muted);margin-top:3px;">🕒 営業: ${esc(r.businessDays)} ${esc(r.openTimeA)}〜${esc(r.closeTimeA)}</div>`;
        }
        if (r.regularHoliday) {
            hoursPreview += `<div class="pi-closed" style="font-size:10px;color:var(--red);margin-top:1px;">📅 定休日: ${esc(r.regularHoliday)}</div>`;
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

// ── CSV生成 & ダウンロード ─────────────────────────────────────────────────
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
    const csv = toCSV(allResults);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const area = metadata.area || '不明';
    const industry = metadata.industry || 'サロン';
    const media = 'ホットペッパービューティー';
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    let filename = `${area}_${industry}_${media}_${ts}.csv`;
    filename = filename.replace(/[\/\\:*?"<>|]/g, '_');

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    addLog(`CSV ダウンロード: ${allResults.length}件`, 'good');
}

// ── ボタン状態管理 ─────────────────────────────────────────────────────────
function setButtons(running) {
    isRunning = running;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    maxSlider.disabled = running;
    if (popularGenreBtn) popularGenreBtn.disabled = running;
}

// ── サイト判定 ────────────────────────────────────────────────────────────
function detectSite(url) {
    if (/beauty\.hotpepper\.jp/.test(url)) return 'beauty';
    return null;
}

// ── background からのメッセージ受信 ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
    // 自タブ以外は無視
    if (msg.tabId !== currentTabId) return;

    switch (msg.type) {
        case 'PAGE_START':
            addLog(`📄 ${msg.page}ページ目 開始 (取得済み: ${msg.collected}件)`, 'info');
            setStatus('running', `${msg.page}ページ目をクロール中...`, `取得済み ${msg.collected} 件`);
            break;

        case 'PROGRESS':
            addLog(`✅ ${msg.latest}`, 'good');
            setStatus('running', `取得中... ${msg.collected} 件`, `${msg.page}ページ目`);
            updateProgress(msg.collected, msg.maxItems);
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
            break;

        case 'ERROR':
            addLog(`❌ ${msg.message}`, 'err');
            setStatus('error', 'エラーが発生しました', msg.message);
            setButtons(false);
            break;

        case 'DONE':
            allResults = msg.results || allResults;
            metadata = msg.metadata || metadata;
            addLog(`🎉 完了！ 合計 ${allResults.length} 件取得`, 'good');
            setStatus('done', `取得完了 ${allResults.length} 件`, 'CSVダウンロードできます');
            progressBar.style.width = '100%';
            setButtons(false);
            renderPreview(allResults);
            if (allResults.length > 0) dlBtn.disabled = false;
            break;
    }
});

// ── 取得開始 ───────────────────────────────────────────────────────────────
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
        setStatus('error', '対応サイトではありません', 'ホットペッパービューティー専用です');
        return;
    }

    // ★ タブIDをここで確定
    currentTabId = tab.id;

    allResults = [];
    logScroll.innerHTML = '';
    previewList.innerHTML = '';
    previewSection.style.display = 'none';
    dlBtn.disabled = true;
    updateProgress(0, maxItems);

    const limitText = maxItems === Infinity ? '上限なし' : `上限 ${maxItems}件`;
    addLog(`ホットペッパービューティー クロール開始 (${limitText})`, 'good');
    setStatus('running', 'ホットペッパービューティーをクロール中...', limitText);
    setButtons(true);

    chrome.runtime.sendMessage({
        action: 'START_CRAWL',
        tabId: tab.id,
        listUrl: tab.url,
        maxItems: maxItems,
    }, res => {
        if (!res?.ok) {
            addLog('クロール開始失敗: ' + (res?.error || '不明'), 'err');
            setButtons(false);
        }
    });
});

// ── 停止 ───────────────────────────────────────────────────────────────────
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

// ── ダウンロード ───────────────────────────────────────────────────────────
dlBtn.addEventListener('click', downloadCSV);

// ── 一括取得ボタン（オプション）─────────────────────────────────────────
if (popularGenreBtn) {
    popularGenreBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;

        currentTabId = tab.id;
        allResults = [];
        logScroll.innerHTML = '';
        previewList.innerHTML = '';
        previewSection.style.display = 'none';
        dlBtn.disabled = true;
        updateProgress(0, maxItems);

        addLog('ホットペッパービューティー 条件一括取得 開始', 'good');
        setButtons(true);

        chrome.runtime.sendMessage({
            action: 'START_POPULAR_GENRE_CRAWL',
            tabId: tab.id,
            listUrl: tab.url,
            maxItems: maxItems,
        });
    });
}

// ── 初期化（ポップアップ再開時の状態復元）────────────────────────────────
(async () => {
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

    // 実行中ログの復元
    chrome.runtime.sendMessage({ action: 'GET_STATE', tabId: currentTabId }, res => {
        if (!res?.state) return;
        const state = res.state;

        if (state.logs?.length) {
            state.logs.forEach(({ time, msg, type }) => {
                const line = document.createElement('div');
                line.className = `log-line ${type}`;
                line.textContent = `[${time}] ${msg}`;
                logScroll.appendChild(line);
            });
            logScroll.scrollTop = logScroll.scrollHeight;
        }

        if (state.running) {
            setButtons(true);
            const mi = state.maxItems === 0 ? Infinity : state.maxItems;
            setStatus('running', `クロール実行中... ${state.collected}件`, `${state.page}ページ目`);
            updateProgress(state.collected, mi);
        }
    });

    // 前回結果の復元
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
