/**
 * offscreen.js
 * サロン個別詳細パース特化エンジン v3.4.0
 * 改善点:
 *   - ジャンルを美容院に統一
 *   - 定休日から営業日を生成
 *   - 営業時間パース強化（10時～20時・平日/土日祝・最終受付 など）
 *   - HP有無判定改善（SNS・予約サイトを公式HPと誤判定しない）
 *   - STOP_CRAWL メッセージを受信したら処理中チャンクを完了後に確定
 */

'use strict';

const CHUNK_SIZE = 3;
const DELAY_BETWEEN_CHUNKS = 1200; // ms

// stopRequested フラグ（タブIDごとに管理）
const stopFlags = new Map();

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ── 住所パース ────────────────────────────────────────────────────────────
function parseAddress(address) {
    const clean = address.replace(/(?:〒\d{3}-\d{4}\s*|日本、\s*)/g, '').trim();
    const m = clean.match(
        /^((?:北海道|東京都|大阪府|京都府|.{2,3}県))?((?:.+?郡.+?[町村]|.+?市.+?区|.+?[市区町村]))?(.+)?$/
    );
    if (!m) return { prefecture: '', city: '' };
    return { prefecture: m[1] || '', city: m[2] || '' };
}

// ── テーブルセルのテキスト取得（br→スペース） ────────────────────────────
function _extractCellText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode(' ')));
    return clone.textContent.replace(/\s+/g, ' ').trim();
}

// ── 電話番号選定（050より実番号優先）─────────────────────────────────────
function selectBestPhoneNumber(rawText) {
    if (!rawText) return '';
    const matches = rawText.match(/(?:\d{2,5}-\d{1,4}-\d{3,4}|\d{10,11})/g);
    if (!matches || matches.length === 0) return rawText.replace(/[^\d\-]/g, '');
    const non050 = matches.filter(n => !n.startsWith('050'));
    return (non050.length > 0 ? non050[0] : matches[0]).replace(/[^\d\-]/g, '');
}

/**
 * 営業時間テキストから時刻をパースして構造化する
 * 対応形式:
 *   10:00~20:00  /  9:00-19:00
 *   10時～20時  /  10時30分～20時
 *   平日10:00～20:00  /  土日祝9:00～19:00
 *   月～金 10:00～20:00
 *   最終受付19:00 （単独時刻のみ→ openTimeA に入れる、closeTimeA は空）
 */
function parseBusinessHours(hoursText) {
    const result = { openTimeA: '', closeTimeA: '', openTimeB: '', closeTimeB: '' };
    if (!hoursText || hoursText === '-') return result;

    // 全角数字・コロン・チルダ・ハイフンを正規化
    let normalized = hoursText
        .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/[：]/g, ':')
        .replace(/[～〜]/g, '~')
        .replace(/ー/g, '-');

    // 「10時30分」→「10:30」「10時」→「10:00」に変換
    normalized = normalized.replace(/(\d{1,2})時(\d{2})分/g, '$1:$2');
    normalized = normalized.replace(/(\d{1,2})時(?!\d)/g, '$1:00');

    // HH:MM ~ HH:MM パターンを全抽出
    const rangePattern = /(\d{1,2}:\d{2})\s*[~\-]\s*(\d{1,2}:\d{2})/g;
    const ranges = [];
    let m;
    while ((m = rangePattern.exec(normalized)) !== null) {
        const open  = m[1].replace(/^(\d):/, '0$1:');  // 9:00 → 09:00
        const close = m[2].replace(/^(\d):/, '0$1:');
        // 重複除去
        if (!ranges.some(r => r.open === open && r.close === close)) {
            ranges.push({ open, close });
        }
    }

    if (ranges.length > 0) {
        result.openTimeA  = ranges[0].open;
        result.closeTimeA = ranges[0].close;
        if (ranges.length >= 2) {
            const b = ranges[1];
            if (b.open !== result.openTimeA || b.close !== result.closeTimeA) {
                result.openTimeB  = b.open;
                result.closeTimeB = b.close;
            }
        }
        return result;
    }

    // 単独時刻（最終受付19:00 など）→ openTimeA のみ埋める
    const singlePattern = /(\d{1,2}:\d{2})/;
    const single = singlePattern.exec(normalized);
    if (single) {
        result.openTimeA = single[1].replace(/^(\d):/, '0$1:');
        console.warn('[offscreen] parseBusinessHours: 単独時刻のみ検出。closeTimeA は空。入力:', hoursText);
        return result;
    }

    console.warn('[offscreen] parseBusinessHours: 時刻パース失敗。入力:', hoursText);
    return result;
}

/**
 * 定休日テキストから営業日を生成する
 * - 'なし' / '-' / 無休  → 月・火・水・木・金・土・日
 * - '不定休'             → '' （空欄）
 * - '月・水' など曜日あり → 全曜日 - 定休曜日
 * - 判定不能             → 月・火・水・木・金・土・日
 */
function getBusinessDaysFromHoliday(holiday) {
    const ALL_DAYS = ['月', '火', '水', '木', '金', '土', '日'];
    if (!holiday || holiday === '-' || holiday === 'なし' || /無休/.test(holiday)) {
        return ALL_DAYS.join('・');
    }
    if (/不定休|不定|シフト/.test(holiday)) {
        return '';
    }
    // 曜日文字を抽出
    const holidayDays = ALL_DAYS.filter(d => holiday.includes(d));
    if (holidayDays.length > 0) {
        const businessDays = ALL_DAYS.filter(d => !holidayDays.includes(d));
        return businessDays.length > 0 ? businessDays.join('・') : ALL_DAYS.join('・');
    }
    // 曜日が読み取れない場合は全曜日
    return ALL_DAYS.join('・');
}

/**
 * HP有無を判定する
 * 返り値: '有' | '無' | '未判定'
 * 除外ドメイン: SNS・予約サイト・ポータルサイトなど
 */
const EXCLUDED_DOMAINS = [
    'beauty.hotpepper.jp', 'hotpepper.jp',
    'instagram.com', 'twitter.com', 'x.com', 'facebook.com',
    'line.me', 'lin.ee', 'ameblo.jp',
    'youtube.com', 'tiktok.com',
    'tabelog.com', 'gnavi.co.jp', 'retty.me', 'gorp.jp',
    'yelp.com', 'tripadvisor.com',
    'cookpad.com',
];

function validateWebsiteUrl(href) {
    if (!href) return '無';
    try {
        const url = new URL(href);
        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        if (EXCLUDED_DOMAINS.some(d => host === d || host.endsWith('.' + d))) {
            return '無';
        }
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return '有';
        }
    } catch (_) {}
    return '無';
}

/**
 * rawHours用の1行テキストを生成（CSV格納用）
 * 改行なし・タブなし・連続スペース圧縮
 */
function buildRawHoursOneLine(fields) {
    const parts = [
        `【営業時間】${fields.businessHours}`,
        `【定休日】${fields.regularHoliday}`,
        `【カット価格】${fields.cutPrice}`,
        `【席数】${fields.seatCount}`,
        `【スタッフ数】${fields.staffCount}`,
        `【駐車場】${fields.parking}`,
        `【支払い方法】${fields.paymentMethod}`,
        `【こだわり条件】${fields.conditions}`,
        `【備考】${fields.remarks}`,
    ];
    return parts.join(' ／ ').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ── 詳細ページ1件フェッチ＆パース ────────────────────────────────────────
async function fetchAndParseDetail(link) {
    // ★ブログ・スタッフ・クチコミ等のサブページは取得しない
    const path = link.replace(/^https?:\/\/[^/]+/, '');
    if (!/\/slnH\d+\/([?#]|$)/.test(path)) {
        console.log('[offscreen] スキップ(サブページ):', link);
        return null;
    }

    try {
        const res = await fetch(link, { signal: AbortSignal.timeout(12000) });
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        let name = '';
        let sourceGenreRaw = '';
        let address = '';
        let hpPhoneText = '';
        let hasWebsite = '未判定';
        let businessHours = '-';
        let regularHoliday = '-';
        let paymentMethod = '-';
        let cutPrice = '-';
        let seatCount = '-';
        let staffCount = '-';
        let parking = '-';
        let conditions = '-';
        let remarks = '-';

        // ── 店名 ──
        name = (
            doc.querySelector('.salonHeaderName h1') ||
            doc.querySelector('h1.salonName') ||
            doc.querySelector('.salonName h1') ||
            doc.querySelector('h1')
        )?.textContent?.trim() || doc.title.split('｜')[0].trim();

        // ── 取得元ジャンル（パンくず2番目：ホットペッパービューティー上のカテゴリ名） ──
        sourceGenreRaw = doc.querySelector('.pa-breadcrumb li:nth-child(2)')?.textContent?.trim()
            || doc.querySelector('.breadcrumb li:nth-child(2)')?.textContent?.trim()
            || 'ヘアサロン';

        // ── テーブル行を総なめ（格子テーブル対応：th/tdが複数セット並ぶ行も処理） ──
        let hasHpField = false; // ホームページ行があったかどうか

        doc.querySelectorAll('table tr').forEach(tr => {
            const ths = tr.querySelectorAll('th');
            const tds = tr.querySelectorAll('td');
            for (let i = 0; i < ths.length; i++) {
                const label = ths[i]?.textContent?.trim() || '';
                const td = tds[i];
                if (!td) continue;

                const val = _extractCellText(td);

                if (label.includes('住所')) address = val;
                if (label.includes('営業時間')) businessHours = val;
                if (label.includes('定休日')) regularHoliday = val;
                if (label.includes('電話') || label.includes('TEL')) hpPhoneText += `\n${td.textContent}`;
                if (label.includes('支払') || label.includes('決済')) paymentMethod = val;
                if (label.includes('カット価格')) cutPrice = val;
                if (label.includes('席数')) seatCount = val;
                if (label.includes('スタッフ')) staffCount = val;
                if (label.includes('駐車場')) parking = val;
                if (label.includes('こだわり')) conditions = val;
                if (label.includes('備考')) remarks = val;

                // HP有無：テーブル行にホームページ/公式サイトのラベルがあれば判定
                if (label.includes('ホームページ') || label.includes('公式サイト') || label.includes('HP') || label.includes('WEB')) {
                    hasHpField = true;
                    const anchor = td.querySelector('a[href^="http"]');
                    if (anchor) {
                        hasWebsite = validateWebsiteUrl(anchor.getAttribute('href'));
                    } else if (val && val.startsWith('http')) {
                        hasWebsite = validateWebsiteUrl(val);
                    } else {
                        hasWebsite = '無';
                    }
                }
            }
        });

        // 住所フォールバック
        if (!address) {
            address = doc.querySelector('.salonAddress, .address')?.textContent?.trim() || '';
        }

        // HP有無：テーブルにHP行がなかった場合はページ内の外部リンクを検索
        if (!hasHpField) {
            const anchors = Array.from(doc.querySelectorAll('a[href^="http"], a[href^="https"]'));
            const officialAnchor = anchors.find(a => {
                const v = validateWebsiteUrl(a.getAttribute('href'));
                return v === '有';
            });
            if (officialAnchor) {
                hasWebsite = '有';
            } else if (
                doc.documentElement.textContent.includes('お店のホームページ') ||
                doc.documentElement.textContent.includes('公式サイト')
            ) {
                hasWebsite = '有';
            } else {
                hasWebsite = '無';
            }
        }

        // ── 電話番号 ──
        let phone = selectBestPhoneNumber(hpPhoneText);

        if (!phone || phone.startsWith('050')) {
            try {
                const telLinkEl = doc.querySelector('a[href*="/tel/"], .telLink');
                let telUrl = telLinkEl?.getAttribute('href') || '';
                if (telUrl && !telUrl.startsWith('http')) {
                    telUrl = telUrl.startsWith('/')
                        ? new URL(link).origin + telUrl
                        : link.replace(/\/?$/, '/') + telUrl.replace(/^\//, '');
                }
                if (!telUrl) telUrl = link.replace(/\/?$/, '/') + 'tel/';

                await sleep(450);
                const telRes = await fetch(telUrl, { signal: AbortSignal.timeout(8000) });
                const telDoc = new DOMParser().parseFromString(await telRes.text(), 'text/html');
                const telNode = telDoc.querySelector('.telNumber, .telephoneNumber, .telephone, p.bold, div.fs16');
                const ext = selectBestPhoneNumber(telNode ? telNode.textContent : telDoc.body?.textContent || '');
                if (ext) phone = ext;
            } catch (_) { }
        }

        // ── クリーニング ──
        address = address.replace(/地図を見る/g, '').replace(/\s+/g, ' ').trim();
        phone = phone.replace(/[^\d\-]/g, '');
        name = name.replace(/[\r\n]+/g, '').trim();
        sourceGenreRaw = sourceGenreRaw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

        // ★【定休日自動クリーンアップ＆中黒区切りフォーマット成形ロジック】
        let cleanedHoliday = 'なし';
        if (regularHoliday && regularHoliday !== '-') {
            if (/不定|シフト|交代|交替|随時|公休/.test(regularHoliday)) {
                cleanedHoliday = '不定休';
            } else if (/無休|なし|無し/.test(regularHoliday)) {
                cleanedHoliday = 'なし';
            } else {
                const targetDays = ['月', '火', '水', '木', '金', '土', '日'];
                const foundDays = [];
                targetDays.forEach(d => {
                    if (regularHoliday.includes(d)) foundDays.push(d);
                });
                if (foundDays.length > 0) {
                    cleanedHoliday = foundDays.join('・');
                } else {
                    cleanedHoliday = regularHoliday.split(/[\r\n]/)[0].trim().slice(0, 15);
                }
            }
        }
        regularHoliday = cleanedHoliday;

        // ── 営業時間パース ──
        const parsedHours = parseBusinessHours(businessHours);

        // ── rawHours: 1行フラットテキスト ──
        const rawHours = buildRawHoursOneLine({
            businessHours, regularHoliday, cutPrice, seatCount,
            staffCount, parking, paymentMethod, conditions, remarks
        });

        return {
            name,
            genre: '美容院',               // ★美容院はHPB専用拡張で取得
            sourceGenre: sourceGenreRaw,    // ★取得元ジャンル（媒体上のカテゴリ名）
            address,
            phone,
            rawHours,
            regularHoliday,
            hasWebsite,
            url: link,
            openTimeA: parsedHours.openTimeA,
            closeTimeA: parsedHours.closeTimeA,
            openTimeB: parsedHours.openTimeB,
            closeTimeB: parsedHours.closeTimeB,
        };

    } catch (e) {
        console.warn('[offscreen] fetchAndParseDetail 失敗:', link, e.message);
        return null;
    }
}

// ── チャンク単位で詳細ページを処理 ───────────────────────────────────────
async function processDetailLinks(tabId, links, currentListUrl) {
    for (let i = 0; i < links.length; i += CHUNK_SIZE) {
        // STOP_CRAWL を受け取ったらチャンクループを中断
        if (stopFlags.get(tabId)) {
            console.log(`[offscreen] tab ${tabId}: STOP受信。チャンクループを中断します。`);
            break;
        }

        const chunk = links.slice(i, i + CHUNK_SIZE);

        await Promise.all(chunk.map(async link => {
            try {
                const detail = await fetchAndParseDetail(link);
                if (detail && detail.name) {
                    const parsedAddr = parseAddress(detail.address);
                    const businessDays = getBusinessDaysFromHoliday(detail.regularHoliday);

                    const finalDetail = {
                        name: detail.name,
                        genre: detail.genre,                    // '美容院'
                        sourceGenre: detail.sourceGenre,        // 取得元ジャンル
                        prefecture: parsedAddr.prefecture,
                        city: parsedAddr.city,
                        address: detail.address,
                        phone: detail.phone || '',
                        regularHoliday: detail.regularHoliday,
                        businessDays,                           // 定休日から生成
                        openTimeA: detail.openTimeA,
                        closeTimeA: detail.closeTimeA,
                        openTimeB: detail.openTimeB,
                        closeTimeB: detail.closeTimeB,
                        rawHours: detail.rawHours,
                        url: detail.url,
                        hasWebsite: detail.hasWebsite,          // '有'/'無'/'未判定'
                        source: 'ホットペッパービューティー',
                        sourceUrl: currentListUrl,
                        scrapedAt: new Date().toISOString(),
                    };

                    chrome.runtime.sendMessage({
                        target: 'background',
                        type: 'DETAIL_PARSED_PROGRESS',
                        tabId,
                        detail: finalDetail,
                    }, () => { if (chrome.runtime.lastError) { /* 意図的に無視 */ } });
                }
            } catch (err) {
                console.error('[offscreen] 詳細パースエラー:', err);
            }
        }));

        await sleep(DELAY_BETWEEN_CHUNKS);
    }

    // チャンク完了（STOP後も必ず送信して background 側でデータを確定させる）
    stopFlags.delete(tabId);
    chrome.runtime.sendMessage({
        target: 'background',
        type: 'CHUNK_PARSED_DONE',
        tabId,
    }, () => { if (chrome.runtime.lastError) { /* 意図的に無視 */ } });
}

// ── メッセージリスナー ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    if (message.action === 'PARSE_DETAIL_LINKS') {
        stopFlags.set(message.tabId, false);
        processDetailLinks(message.tabId, message.links, message.currentListUrl);
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'STOP_CRAWL') {
        stopFlags.set(message.tabId, true);
        sendResponse({ ok: true });
        return true;
    }

    return false;
});

// offscreen 起動完了を background に通知
chrome.runtime.sendMessage({
    target: 'background',
    type: 'OFFSCREEN_READY',
}).catch(() => { });
