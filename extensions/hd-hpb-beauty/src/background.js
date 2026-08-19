/**
 * background.js
 * v3.3.0 — 断線自動復旧・リトライPING方式・上限/次ページ処理修正版
 */

'use strict';

// ── Service Worker キープアライブ ─────────────────────────────────────────
function keepAlive() {
    chrome.runtime.getPlatformInfo(() => { });
    setTimeout(keepAlive, 20000);
}
keepAlive();

// ── 状態管理 ──────────────────────────────────────────────────────────────
const crawlState = new Map();

function getState(tabId) {
    if (!crawlState.has(tabId)) {
        crawlState.set(tabId, {
            running:        false,
            logs:           [],
            collected:      0,
            maxItems:       0,
            page:           1,
            metadata:       {},
            results:        [],
            currentUrl:     '',
            nextUrl:        '',
            waitingForLoad: false,
            downloaded:     false,
            stopRequested:  false,
            stopTimeoutId:  null,
        });
    }
    return crawlState.get(tabId);
}

async function backupCrawlData(tabId) {
    const state = getState(tabId);
    try {
        await chrome.storage.local.set({
            [`crawl_backup_${tabId}`]: {
                results: state.results,
                metadata: state.metadata,
                collected: state.collected,
                page: state.page,
                maxItems: state.maxItems,
                currentUrl: state.currentUrl,
                timestamp: Date.now()
            }
        });
        console.log(`[BG] Backup saved for tab ${tabId}. Count: ${state.results.length}`);
    } catch (e) {
        console.error('[BG] Failed to save backup:', e);
    }
}

function pushLog(tabId, msg, type = 'info') {
    const state = getState(tabId);
    const time  = new Date().toLocaleTimeString('ja-JP', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    state.logs.push({ time, msg, type });
    if (state.logs.length > 300) state.logs.shift();
}

// ── ユーティリティ ────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ── Offscreen ドキュメント管理 ────────────────────────────────────────────
const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen.html';
let isOffscreenReady     = false;
let offscreenReadyResolve = null;

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

    const readyPromise = new Promise(resolve => {
        offscreenReadyResolve = resolve;
    });

    try {
        await chrome.offscreen.createDocument({
            url:           OFFSCREEN_DOCUMENT_PATH,
            reasons:       [chrome.offscreen.Reason.DOM_PARSER],
            justification: 'バックグラウンドで安定した詳細パースを行うため',
        });
        // offscreen.js から OFFSCREEN_READY が届くまで待機
        await readyPromise;
    } catch (e) {
        console.error('[BG] offscreen 作成失敗:', e);
    }
}

// ── content.js 生存確認（タイムアウト付き単発PING）────────────────────────
function pingContentScript(tabId) {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 600);
        try {
            chrome.tabs.sendMessage(tabId, { action: 'PING' }, res => {
                clearTimeout(timer);
                if (chrome.runtime.lastError || !res || res.pong !== true) {
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        } catch (_) {
            clearTimeout(timer);
            resolve(false);
        }
    });
}

/**
 * content.js の生存確認 → 必要なら再注入 → リスナー登録完了までリトライPINGで待機
 *
 * 「executeScript完了 ≠ リスナー登録完了」という競合を
 * 200ms間隔×最大15回のリトライPINGで確実に解消する。
 */
async function ensureContentScriptReady(tabId) {
    // まず現在のcontent.jsが生きているか確認
    if (await pingContentScript(tabId)) return true;

    // 断線確認 → 再注入
    console.log('[BG] content.js 未応答。再注入を試みます...');
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files:  ['src/content.js'],
        });
    } catch (e) {
        console.error('[BG] executeScript 失敗:', e.message);
        return false;
    }

    // 注入後、リスナー登録完了をリトライPINGで確認（最大3秒）
    const MAX_RETRIES     = 15;
    const RETRY_INTERVAL  = 200; // ms
    for (let i = 0; i < MAX_RETRIES; i++) {
        await sleep(RETRY_INTERVAL);
        if (await pingContentScript(tabId)) {
            console.log(`[BG] content.js 応答確認 (${(i + 1) * RETRY_INTERVAL}ms後)`);
            return true;
        }
    }

    console.error('[BG] content.js が規定時間内に応答しませんでした。');
    return false;
}

// ── CSV生成 ───────────────────────────────────────────────────────────────
function generateCSV(data) {
    const headers = [
        '店名', 'ジャンル', '取得元ジャンル', '都道府県', '市区町村', '住所', '電話番号',
        '定休日', '営業日', '営業開始A', '営業終了A', '営業開始B', '営業終了B',
        '営業時間原文', 'URL', 'HP有無', '媒体', '取得元URL', '取得日時'
    ];
    const keyMap = {
        '店名': 'name', 'ジャンル': 'genre', '取得元ジャンル': 'sourceGenre',
        '都道府県': 'prefecture', '市区町村': 'city', '住所': 'address', '電話番号': 'phone',
        '定休日': 'regularHoliday', '営業日': 'businessDays',
        '営業開始A': 'openTimeA', '営業終了A': 'closeTimeA',
        '営業開始B': 'openTimeB', '営業終了B': 'closeTimeB',
        '営業時間原文': 'rawHours', 'URL': 'url', 'HP有無': 'hasWebsite',
        '媒体': 'source', '取得元URL': 'sourceUrl', '取得日時': 'scrapedAt'
    };
    const ef = v => {
        let s = String(v ?? '');
        if (s === '未判定') s = '';
        return (s.includes(',') || s.includes('\n') || s.includes('"'))
            ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = data.map(r => headers.map(h => ef(r[keyMap[h]])).join(','));
    return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

function buildFilename(metadata, ext) {
    const area     = metadata.area     || '不明';
    const industry = metadata.industry || 'サロン';
    const media    = 'ホットペッパービューティー';
    const now      = new Date();
    const ts       = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    return `${area}_${industry}_${media}_${ts}.${ext}`.replace(/[\/\\:*?"<>|]/g, '_');
}

async function triggerDownload(results, metadata, tabId) {
    if (!results || results.length === 0) return;
    if (tabId) {
        const state = getState(tabId);
        if (state.downloaded) {
            console.log(`[BG] tab ${tabId} has already downloaded CSV. Skipping.`);
            return;
        }
        state.downloaded = true;
    }
    const csv      = generateCSV(results);
    const base64   = btoa(unescape(encodeURIComponent(csv)));
    const dataUrl  = 'data:text/csv;charset=utf-8;base64,' + base64;
    const filename = buildFilename(metadata, 'csv');
    try {
        await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    } catch (err) {
        console.error('[BG] CSVダウンロード失敗:', err);
    }
}

// ── クロール開始 ──────────────────────────────────────────────────────────
async function startTabCrawl(tabId, maxItems, listUrl) {
    const state         = getState(tabId);
    state.running       = true;
    state.collected     = 0;
    state.maxItems      = maxItems;   // Infinity or 数値
    state.page          = 1;
    state.results       = [];
    state.logs          = [];
    state.currentUrl    = listUrl;
    state.nextUrl       = '';
    state.waitingForLoad = false;
    state.downloaded     = false;
    state.stopRequested  = false;
    if (state.stopTimeoutId) {
        clearTimeout(state.stopTimeoutId);
        state.stopTimeoutId = null;
    }

    // 古いバックアップを削除
    chrome.storage.local.remove([`crawl_backup_${tabId}`]).catch(() => {});

    await setupOffscreenDocument();
    await executeNextPageCrawl(tabId);
}

// ── 1ページ分のクロール実行 ───────────────────────────────────────────────
async function executeNextPageCrawl(tabId) {
    const state = getState(tabId);
    if (!state.running) return;

    pushLog(tabId, `📄 ${state.page}ページ目 解析開始 (取得済み: ${state.collected}件)`, 'info');
    chrome.runtime.sendMessage({
        tabId, type: 'PAGE_START',
        page: state.page, collected: state.collected
    }).catch(() => { });

    // ★ 再注入後のリスナー登録完了をリトライPINGで確認してから送信
    const isReady = await ensureContentScriptReady(tabId);
    if (!isReady) {
        pushLog(tabId,
            '❌ content.js との通信を確立できませんでした。対象タブを手動でF5更新後、再度お試しください。',
            'err'
        );
        chrome.runtime.sendMessage({ tabId, type: 'ERROR', message: '画面通信失敗（復旧不能）' }).catch(() => { });
        state.running = false;
        return;
    }

    // PING確認済み → sendMessage は必ず届く
    chrome.tabs.sendMessage(tabId, { action: 'EXTRACT_LIST_DATA' }, async response => {
        if (chrome.runtime.lastError || !response) {
            const detail = chrome.runtime.lastError?.message || '応答なし';
            pushLog(tabId, `❌ EXTRACT_LIST_DATA 失敗 (${detail})`, 'err');
            chrome.runtime.sendMessage({ tabId, type: 'ERROR', message: '画面通信失敗' }).catch(() => { });
            state.running = false;
            return;
        }

        let { links, nextUrl, area } = response;

        state.metadata = { area: area || '不明', industry: 'サロン' };
        state.nextUrl  = nextUrl || '';

        // 重複除去
        const seen = new Set(state.results.map(r => r.url));
        links = links.filter(l => !seen.has(l));

        // 上限まで切り詰め（Infinityは slice に undefined を渡して全件）
        if (state.maxItems !== Infinity) {
            const remaining = state.maxItems - state.collected;
            links = links.slice(0, remaining);
        }

        if (links.length === 0) {
            pushLog(tabId, 'ℹ️ このページに未取得のサロンがありません。', 'info');
            finalizeCrawl(tabId);
            return;
        }

        pushLog(tabId,
            `📋 ${state.page}ページ目: ${links.length}件をバックグラウンド解析へ送信...`,
            'info'
        );

        // offscreen へ詳細パースを依頼
        chrome.runtime.sendMessage({
            target:         'offscreen',
            action:         'PARSE_DETAIL_LINKS',
            tabId,
            links,
            currentListUrl: state.currentUrl || '一覧ページ',
        });
    });
}

// ── クロール完了処理 ──────────────────────────────────────────────────────
function finalizeCrawl(tabId) {
    const state   = getState(tabId);
    state.running = false;
    state.stopRequested = false;
    if (state.stopTimeoutId) {
        clearTimeout(state.stopTimeoutId);
        state.stopTimeoutId = null;
    }
    pushLog(tabId, `🎉 完了！ 合計 ${state.results.length} 件取得`, 'good');
    chrome.runtime.sendMessage({
        tabId, type: 'DONE',
        results:  state.results,
        metadata: state.metadata,
    }).catch(() => { });
    backupCrawlData(tabId);
    triggerDownload(state.results, state.metadata, tabId);
}

// ── タブ遷移完了検知（次ページ読み込み待ち）─────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const state = crawlState.get(tabId);
    if (state && state.running && state.waitingForLoad && changeInfo.status === 'complete') {
        state.waitingForLoad = false;
        setTimeout(() => executeNextPageCrawl(tabId), 1500);
    }
});

// ── メッセージハンドラ ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // ── offscreen / background 間メッセージ ──
    if (message.target === 'background') {

        if (message.type === 'OFFSCREEN_READY') {
            isOffscreenReady = true;
            if (offscreenReadyResolve) { offscreenReadyResolve(); offscreenReadyResolve = null; }
            sendResponse({ ok: true });
            return true;
        }

        if (message.type === 'DOWNLOAD_CSV') {
            triggerDownload(message.results, message.metadata, message.tabId);
            sendResponse({ ok: true });
            return true;
        }

        // offscreen → 詳細1件パース完了
        if (message.type === 'DETAIL_PARSED_PROGRESS') {
            const { tabId, detail } = message;
            const state = getState(tabId);

            if (state.running || state.stopRequested) {
                state.results.push(detail);
                state.collected++;
                pushLog(tabId, `✅ ${detail.name}`, 'good');
                chrome.runtime.sendMessage({
                    tabId,
                    type:     'PROGRESS',
                    collected: state.collected,
                    maxItems:  state.maxItems,
                    latest:    detail.name,
                    page:      state.page,
                }).catch(() => { });

                // 10件ごとにバックアップ保存
                if (state.collected % 10 === 0) {
                    backupCrawlData(tabId);
                }

                // ★ 上限到達チェック：CHUNK_PARSED_DONEを待たず即完了
                if (state.maxItems !== Infinity && state.collected >= state.maxItems) {
                    finalizeCrawl(tabId);
                }
            }
            sendResponse({ ok: true });
            return true;
        }

        // offscreen → 1ページ分の詳細パース全件完了
        if (message.type === 'CHUNK_PARSED_DONE') {
            const { tabId } = message;
            const state     = getState(tabId);

            if (state.stopRequested) {
                finalizeCrawl(tabId);
                sendResponse({ ok: true });
                return true;
            }

            if (!state.running) {
                // 上限到達などで既に完了済み → 何もしない
                sendResponse({ ok: true });
                return true;
            }

            // ページ完了ごとにバックアップ保存
            backupCrawlData(tabId);

            if (!state.nextUrl) {
                // 次ページなし → 終了
                finalizeCrawl(tabId);
            } else {
                // 次ページへ遷移
                state.page++;
                state.currentUrl    = state.nextUrl;
                state.nextUrl       = '';           // ★ 必ずクリア
                state.waitingForLoad = true;
                chrome.tabs.update(tabId, { url: state.currentUrl });
            }
            sendResponse({ ok: true });
            return true;
        }

        // content.js 経由でジャンルリンクを取得（一括取得モード用）
        if (message.type === 'GET_GENRE_LINKS_FROM_CONTENT') {
            chrome.tabs.sendMessage(
                message.tabId,
                { action: 'GET_GENRE_LINKS', siteType: message.siteType },
                links => {
                    chrome.runtime.sendMessage({
                        target: 'offscreen',
                        type:   'GENRE_LINKS_FROM_CONTENT_RESULT',
                        tabId:  message.tabId,
                        links,
                    }).catch(() => { });
                }
            );
            sendResponse({ ok: true });
            return true;
        }
    }

    // ── popup → background ──
    if (message.action === 'START_CRAWL') {
        const maxItems = (message.maxItems === undefined || message.maxItems === null)
            ? Infinity : message.maxItems;
        startTabCrawl(message.tabId, maxItems, message.listUrl);
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'START_POPULAR_GENRE_CRAWL') {
        const maxItems = message.maxItems || Infinity;
        startTabCrawl(message.tabId, maxItems, message.listUrl);
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'STOP_CRAWL') {
        const tabId = message.tabId;
        const state = getState(tabId);

        if (state.stopRequested || state.downloaded) {
            sendResponse({ ok: true });
            return true;
        }

        state.running = false;
        state.stopRequested = true;
        pushLog(tabId, '⏹ 途中停止を受け付けました。現在処理中のサロンの完了を待っています（最大15秒）...', 'warn');

        // offscreenに停止メッセージを送信
        chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'STOP_CRAWL',
            tabId
        }).catch(() => { });

        backupCrawlData(tabId);

        // 最大15秒待機するタイマーを始動
        state.stopTimeoutId = setTimeout(() => {
            if (state.stopRequested && !state.downloaded) {
                pushLog(tabId, '⏹ 待機タイムアウトのため、取得済みのデータのみで確定します。', 'warn');
                finalizeCrawl(tabId);
            }
        }, 15000);

        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'GET_STATE') {
        const state = getState(message.tabId);
        sendResponse({ ok: true, state });
        return true;
    }

    if (message.action === 'GET_RESULTS') {
        const state = getState(message.tabId);
        sendResponse({ results: state.results, running: state.running, metadata: state.metadata });
        return true;
    }

    return false;
});
