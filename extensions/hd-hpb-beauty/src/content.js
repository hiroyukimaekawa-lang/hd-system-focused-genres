/**
 * content.js
 * ホットペッパービューティー 一覧ページ専用 DOM抽出スクリプト
 */

'use strict';

// ── サロン詳細リンク抽出 ──────────────────────────────────────────────────
function extractSalonLinks() {
    const seen  = new Set();
    const links = [];

    const selectors = [
        'a[href*="/slnH"]',
        '.salonNameLink',
        '.cL-salon-name a',
        'h3.mT5 a',
        '.mT10 a[href*="slnH"]'
    ];

    for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(a => {
            try {
                const url = new URL(a.href, location.origin).href;

                // ★ /slnH直下のトップページのみ許可（サブページを全除外）
                //   OK例:  /slnH000123456/
                //   NG例:  /slnH000123456/blog/  /slnH000123456/review/  など
                const isTopPage = /\/slnH\d+\/([?#]|$)/.test(
                    url.replace(/^https?:\/\/[^/]+/, '')
                );

                if (isTopPage && !seen.has(url)) {
                    seen.add(url);
                    links.push(url);
                }
            } catch (_) { }
        });
        if (links.length > 0) break;
    }

    return links;
}

// ── 次ページURL抽出 ───────────────────────────────────────────────────────
function extractNextPageUrl() {
    const candidates = [
        document.querySelector('a.pa-nextPage'),
        document.querySelector('a[class*="nextPage"]'),
        document.querySelector('li.pa-nextPage a'),
        document.querySelector('.pager a[rel="next"]'),
        document.querySelector('a[rel="next"]'),
        ...[...document.querySelectorAll('a')].filter(a =>
            /次(のページ)?[へ»›>]?/.test(a.textContent.trim()) && a.href
        )
    ];

    for (const el of candidates) {
        if (el && el.href && !el.href.includes('#')) {
            try {
                const url = new URL(el.href, location.origin).href;
                if (url !== location.href) return url;
            } catch (_) { }
        }
    }
    return null;
}

// ── エリア名抽出 ──────────────────────────────────────────────────────────
function extractAreaName() {
    const breadcrumbCandidates = [
        document.querySelector('.pa-breadcrumb li:last-child'),
        document.querySelector('.breadcrumb li:last-child'),
        document.querySelector('ol.breadcrumb li:last-child'),
        document.querySelector('ul.bcList li:last-child'),
        document.querySelector('nav[aria-label="パンくずリスト"] li:last-child')
    ];
    for (const el of breadcrumbCandidates) {
        const t = el?.textContent?.trim();
        if (t) return t;
    }

    const titleMatch = document.title.match(/^(.+?)(?:の美容院|のネイル|のまつげ|のリラク|のエステ)/);
    if (titleMatch) return titleMatch[1].trim();

    return '';
}

// ── メッセージリスナー ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'PING') {
        sendResponse({ pong: true });
        return true;
    }

    if (message.action === 'EXTRACT_LIST_DATA') {
        try {
            const links   = extractSalonLinks();
            const nextUrl = extractNextPageUrl();
            const area    = extractAreaName();
            sendResponse({ links, nextUrl, area });
        } catch (e) {
            console.error('[content] EXTRACT_LIST_DATA エラー:', e);
            sendResponse({ links: [], nextUrl: null, area: '' });
        }
        return true;
    }

    if (message.action === 'GET_GENRE_LINKS') {
        try {
            const links = [];
            const seen  = new Set();
            const genreSelectors = [
                '.pa-genreList a',
                '.genreList a',
                'ul.genre a',
                'a[href*="/genre/"]',
                'a[href*="/area/"]'
            ];
            for (const sel of genreSelectors) {
                document.querySelectorAll(sel).forEach(a => {
                    const url = a.href;
                    if (url && url.includes('beauty.hotpepper.jp') && !seen.has(url)) {
                        seen.add(url);
                        links.push(url);
                    }
                });
            }
            sendResponse(links);
        } catch (e) {
            sendResponse([]);
        }
        return true;
    }

    return false;
});