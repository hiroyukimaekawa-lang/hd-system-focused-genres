/**
 * offscreen.js
 * 高速化改修版: URL収集/詳細取得分離 + ジャンル重複排除 + 詳細統計 + 自動速度調整
 */

const activeTasks = new Map();
const DELAY_LIST_FETCH = 600;
const genreLinksResolvers = new Map();

// 人気ジャンル一括取得では、詳細ページ側のジャンル欄の値に関わらず、
// 巡回中のカテゴリ名（例: 和食・ラーメン・カフェ...）でジャンルを問答無用で統一する。
// これをやらないと、詳細ページのジャンル欄が店ごとに「ラーメン、つけ麺」「ラーメン、餃子」等
// バラバラな複合表記になり、CSVがエリア＋ジャンルの組み合わせごとに大量に分裂してしまう
// （例: 千葉県_東金市_ラーメン_食堂.csv, 千葉県_東金市_ラーメン_つけ麺.csv, ...）。
// カテゴリ名で統一することで、エリア×カテゴリで1ファイルにまとまる。

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// =====================================================================
// 住所文字列から都道府県と市区町村を抽出
// =====================================================================
function parseAddress(address) {
  let cleanAddress = address.replace(/(?:〒\d{3}-\d{4}\s*|日本、\s*)/g, '').trim();
  const regex = /^((?:北海道|東京都|大阪府|京都府|.{2,3}県))?((?:.+?郡.+?[町村]|.+?市.+?区|.+?[市区町村]))?(.+)?$/;
  const m = cleanAddress.match(regex);
  if (!m) return { prefecture: '', city: '' };
  return { prefecture: m[1] || '', city: m[2] || '' };
}

// セルのテキストをbrタグ保持して取得
function _extractCellLines(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
  return clone.textContent.replace(/[ \t　]+/g, ' ').trim();
}

// =====================================================================
// 050予約専用番号を回避し実店舗固定電話等を優先抽出
// =====================================================================
function selectBestPhoneNumber(rawText) {
  if (!rawText) return '';
  const matches = rawText.match(/(?:\d{2,5}-\d{1,4}-\d{3,4}|\d{10,11})/g);
  if (!matches || matches.length === 0) {
    return rawText.replace(/[^\d\-]/g, '');
  }
  const non050Numbers = matches.filter(num => !num.startsWith('050'));
  if (non050Numbers.length > 0) {
    return non050Numbers[0].replace(/[^\d\-]/g, '');
  }
  return matches[0].replace(/[^\d\-]/g, '');
}

// 食べログの<title>タグ「店名 (ジャンル) - エリア | 食べログ」から
// 店名部分だけを取り出す（display-nameが取れなかった時の保険用フォールバック）
function cleanTabelogTitleName(rawTitle) {
  let t = String(rawTitle || '').split('|')[0].trim();
  if (!t) return t;
  const parenIdx = t.search(/[（(]/);
  if (parenIdx > 0) {
    t = t.slice(0, parenIdx).trim();
  } else {
    const dashIdx = t.indexOf(' - ');
    if (dashIdx > 0) t = t.slice(0, dashIdx).trim();
  }
  return t;
}

function getSiteType(url) {
  if (/tabelog\.com/.test(url)) return 'tabelog';
  if (/hotpepper\.jp/.test(url)) return 'hotpepper';
  return null;
}

function resolveUrl(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).href;
  } catch (e) {
    return href;
  }
}

function normalizeListUrl(url) {
  return String(url || '').split('#')[0].split('?')[0].replace(/\/$/, '');
}

function addUniqueLink(links, href) {
  const normalized = normalizeListUrl(href);
  if (normalized && !links.includes(normalized)) links.push(normalized);
}

function isLikelyNextAnchor(a) {
  if (!a) return false;
  const text = (a.textContent || '').replace(/\s+/g, '');
  const label = `${a.getAttribute('aria-label') || ''} ${a.getAttribute('title') || ''}`.replace(/\s+/g, '');
  const rel = (a.getAttribute('rel') || '').toLowerCase();
  const cls = a.className || '';
  return rel === 'next'
    || /次|次へ|Next|next/.test(text)
    || /次|次へ|Next|next/.test(label)
    || /next|pa_next|pagination-next/.test(String(cls));
}

function deriveTabelogNextUrl(currentUrl, pageNum) {
  try {
    const url = new URL(currentUrl);
    const nextPage = pageNum + 1;
    const parts = url.pathname.split('/').filter(Boolean);
    const rstIdx = parts.indexOf('rstLst');
    if (rstIdx === -1) return null;
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) {
      parts[parts.length - 1] = String(nextPage);
    } else {
      parts.push(String(nextPage));
    }
    url.pathname = '/' + parts.join('/') + '/';
    return url.href;
  } catch (e) {
    return null;
  }
}

function deriveHotpepperNextUrl(currentUrl, pageNum) {
  try {
    const url = new URL(currentUrl);
    const nextPage = pageNum + 1;
    const parts = url.pathname.split('/').filter(Boolean);
    const pnIdx = parts.findIndex(p => /^pn\d+$/i.test(p));
    if (pnIdx !== -1) {
      parts[pnIdx] = `pn${nextPage}`;
    } else {
      parts.push(`pn${nextPage}`);
    }
    url.pathname = '/' + parts.join('/') + '/';
    return url.href;
  } catch (e) {
    return null;
  }
}

function sendToBackground(tabId, type, payload = {}) {
  chrome.runtime.sendMessage({
    target: 'background',
    tabId,
    type,
    payload
  }).catch(() => { });
}

function extractMetadata(doc, siteType) {
  const meta = { area: '', industry: '' };
  if (siteType === 'tabelog') {
    meta.area = doc.querySelector('.list-condition__item--area')?.textContent?.trim()
      || doc.querySelector('.c-link-arrow--back')?.textContent?.trim() || '';
    meta.industry = doc.querySelector('.list-condition__item--genre')?.textContent?.trim() || '';
  } else if (siteType === 'hotpepper') {
    meta.area = doc.querySelector('.current-area')?.textContent?.trim() || '';
    meta.industry = doc.querySelector('.current-genre')?.textContent?.trim() || '';
  }
  return meta;
}

const DAY_MAP = {
  '月曜日':'月','火曜日':'火','水曜日':'水','木曜日':'木',
  '金曜日':'金','土曜日':'土','日曜日':'日',
  'Monday':'月','Tuesday':'火','Wednesday':'水','Thursday':'木',
  'Friday':'金','Saturday':'土','Sunday':'日',
  'Mon':'月','Tue':'火','Wed':'水','Thu':'木','Fri':'金','Sat':'土','Sun':'日'
};

const ALL_DAYS = ['月','火','水','木','金','土','日'];

const HOLIDAY_NOISE_PATTERNS = [
  /お問い?合わせ(ください|下さい)?/g, /詳細はお電話(にて)?/g,
  /コロナ.*?(\n|$)/g, /感染症.*?(\n|$)/g, /変更(に)?なる場合.*?(\n|$)/g,
  /変更の可能性.*?(\n|$)/g, /ご確認ください/g, /店舗にお問い?合わせ/g,
  /予告なく.*?(\n|$)/g, /※.*?(\n|$)/g, /\(※.*?\)/g, /（※.*?）/g,
  /毎週/g, /隔週/g, /第[一二三四五1-5]・?/g, /営業時間.*?(\n|$)/g,
  /ご来店前.*?(\n|$)/g, /店舗にご確認.*?(\n|$)/g, /変更となる場合.*?(\n|$)/g,
];

function normalizeDayText(text) {
  if (!text) return '';
  let result = text;
  for (const [long, short] of Object.entries(DAY_MAP)) {
    result = result.replaceAll(long, short);
  }
  return result;
}

function extractDaySet(text) {
  if (!text) return new Set();
  const normalized = normalizeDayText(text);
  const daySet = new Set();
  const rangePattern = /([月火水木金土日])[〜～~－\-ーー–—]([月火水木金土日])/g;
  let m;
  while ((m = rangePattern.exec(normalized)) !== null) {
    const start = ALL_DAYS.indexOf(m[1]);
    const end   = ALL_DAYS.indexOf(m[2]);
    if (start !== -1 && end !== -1) {
      for (let i = start; i <= end; i++) daySet.add(ALL_DAYS[i]);
    }
  }
  const withoutRange = normalized.replace(/[月火水木金土日][〜～~－\-ーー–—][月火水木金土日]/g, '  ');
  const listPattern = /[月火水木金土日]/g;
  let m2;
  while ((m2 = listPattern.exec(withoutRange)) !== null) {
    daySet.add(m2[0]);
  }
  return daySet;
}

function cleanHolidayText(text) {
  if (!text) return '';
  let result = text;
  for (const pattern of HOLIDAY_NOISE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.trim();
}

function resolveFinalHoliday(rawHolidayText, businessDaySet) {
  const cleaned = cleanHolidayText(rawHolidayText);
  if (/無休|年中無休/.test(cleaned)) return '無休';
  if (/^[\-－ー\s]+$/.test(cleaned)) return '-';
  const holidayDaySet = extractDaySet(cleaned);
  if (holidayDaySet.size > 0) return ALL_DAYS.filter(d => holidayDaySet.has(d)).join('・');
  if (businessDaySet && businessDaySet.size > 0) {
    const calculated = ALL_DAYS.filter(d => !businessDaySet.has(d));
    if (calculated.length === 0 || businessDaySet.size === 7) return '無休';
    if (calculated.length > 0 && calculated.length < 7) return calculated.join('・');
  }
  return '';
}

function normalizeBusinessHours(hoursText) {
  if (!hoursText) {
    return { holiday: '', businessDays: '', openTimeA: '', closeTimeA: '', openTimeB: '', closeTimeB: '' };
  }

  const textFlat = hoursText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

  let rawHolidayText = '';
  if (/年中無休|無休/.test(textFlat)) {
    rawHolidayText = '無休';
  } else {
    const holidayMatch = textFlat.match(/【定休日】([^【]+)/);
    if (holidayMatch) rawHolidayText = holidayMatch[1].trim();
    if (!rawHolidayText) {
      const squareMatch = textFlat.match(/■定休日\s*[\r\n]+([^\r\n■【]+)/);
      if (squareMatch) rawHolidayText = squareMatch[1].trim();
    }
    if (!rawHolidayText) {
      const colonMatch = textFlat.match(/定休日[：:]([^【■\r\n]+)/);
      if (colonMatch) rawHolidayText = colonMatch[1].trim();
    }
  }

  let hoursBlock = '';
  const hoursMatch = hoursText.match(/【営業時間】([\s\S]+?)(?:【定休日】|$)/);
  if (hoursMatch) {
    hoursBlock = hoursMatch[1];
  } else {
    hoursBlock = hoursText
      .replace(/【定休日】[\s\S]*/g, '')
      .replace(/■定休日[\s\S]*/g, '')
      .replace(/定休日[：:][\s\S]*/g, '');
  }

  const lines = hoursBlock.split('\n').map(l => l.trim()).filter(Boolean);
  const dayToTimes = Array.from({ length: 7 }, () => []);
  let currentDays = [...ALL_DAYS];

  const timeRangePattern = /(\d{1,2})[：:](\d{2})\s*[〜～\-–―]\s*(\d{1,2})[：:](\d{2})/g;

  for (const line of lines) {
    const hasDayChar = /[月火水木金土日]/.test(line);
    const timeMatches = [...line.matchAll(/(\d{1,2})[：:](\d{2})/g)];

    if (hasDayChar && timeMatches.length === 0) {
      const extractedDays = extractDaySet(line);
      if (extractedDays.size > 0) {
        currentDays = [...extractedDays];
      }
    } else if (timeMatches.length >= 2) {
      let match;
      timeRangePattern.lastIndex = 0;
      const pairs = [];
      while ((match = timeRangePattern.exec(line)) !== null) {
        pairs.push({
          open: `${match[1].padStart(2, '0')}:${match[2]}`,
          close: `${match[3].padStart(2, '0')}:${match[4]}`
        });
      }
      if (pairs.length === 0 && timeMatches.length >= 2) {
        for (let idx = 0; idx < timeMatches.length - 1; idx += 2) {
          pairs.push({
            open: `${timeMatches[idx][1].padStart(2, '0')}:${timeMatches[idx][2]}`,
            close: `${timeMatches[idx+1][1].padStart(2, '0')}:${timeMatches[idx+1][2]}`
          });
        }
      }
      if (pairs.length > 0) {
        currentDays.forEach(d => {
          const dayIdx = ALL_DAYS.indexOf(d);
          if (dayIdx !== -1) dayToTimes[dayIdx].push(...pairs);
        });
      }
    }
  }

  const filterUniqueTimes = (timesList) => {
    const seen = new Set();
    return timesList.filter(t => {
      const key = `${t.open}-${t.close}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const todayIdx = (new Date().getDay() + 6) % 7;
  let todayTimes = filterUniqueTimes(dayToTimes[todayIdx]);

  if (todayTimes.length <= 1) {
    let richerTimes = [];
    for (let i = 0; i < 7; i++) {
      const u = filterUniqueTimes(dayToTimes[i]);
      if (u.length > richerTimes.length) richerTimes = u;
    }
    if (richerTimes.length <= 1) {
      const allPairs = [];
      timeRangePattern.lastIndex = 0;
      let match;
      while ((match = timeRangePattern.exec(hoursBlock)) !== null) {
        allPairs.push({
          open: `${match[1].padStart(2, '0')}:${match[2]}`,
          close: `${match[3].padStart(2, '0')}:${match[4]}`
        });
      }
      const uAll = filterUniqueTimes(allPairs);
      if (uAll.length > richerTimes.length) richerTimes = uAll;
    }
    if (richerTimes.length >= 2) {
      todayTimes = richerTimes;
    }
  }

  todayTimes.sort((a, b) => a.open.localeCompare(b.open));

  let finalOpenTimeA = '', finalCloseTimeA = '', finalOpenTimeB = '', finalCloseTimeB = '';

  if (todayTimes.length > 0) {
    finalOpenTimeA = todayTimes[0].open;
    finalCloseTimeA = todayTimes[0].close;
    if (finalCloseTimeA === '24:00' || finalCloseTimeA === '00:00') finalCloseTimeA = '24:00';
  }
  if (todayTimes.length > 1) {
    finalOpenTimeB = todayTimes[1].open;
    finalCloseTimeB = todayTimes[1].close;
    if (finalCloseTimeB === '24:00' || finalCloseTimeB === '00:00') finalCloseTimeB = '24:00';
  }

  const activeDays = [];
  for (let i = 0; i < 7; i++) {
    if (dayToTimes[i].length > 0) activeDays.push(ALL_DAYS[i]);
  }

  const businessDaySet = new Set(activeDays);
  const finalHoliday = resolveFinalHoliday(rawHolidayText, businessDaySet);
  let finalBusinessDays = finalHoliday === '無休' ? '月・火・水・木・金・土・日' : activeDays.join('・');

  return { holiday: finalHoliday, businessDays: finalBusinessDays, openTimeA: finalOpenTimeA, closeTimeA: finalCloseTimeA, openTimeB: finalOpenTimeB, closeTimeB: finalCloseTimeB };
}

// おすすめ・関連店舗など、本来のリストとは別枠のウィジェットに使われがちな
// クラス/ID名。祖先要素にこれらが含まれるリンクは、たとえ通常のカード用
// セレクタに一致していても除外する（正規リストと同じ見た目のCSSクラスが
// 「周辺のおすすめ」枠にも使い回されているケースがあるため）。
const TABELOG_EXCLUDE_ANCESTOR_RE = /recommend|related|around|nearby|kanren|other-?area|other-?pref|ranking-?other/i;

function isInsideExcludedWidget(el) {
  let node = el;
  let depth = 0;
  while (node && depth < 8) {
    const cls = (node.className && typeof node.className === 'string') ? node.className : '';
    const id = node.id || '';
    if (TABELOG_EXCLUDE_ANCESTOR_RE.test(cls) || TABELOG_EXCLUDE_ANCESTOR_RE.test(id)) return true;
    node = node.parentElement;
    depth++;
  }
  return false;
}

function tabelogGetLinks(doc, baseUrl) {
  const links = [];
  const RST_URL_RE = /tabelog\.com\/[a-z]+\/A\d+\/A\d+\/\d+\//;
  const primary = doc.querySelectorAll([
    '.list-rst__rst-name-target',
    '.js-rst-cassette-wrap .list-rst__name a',
    'a.list-rst__name-main',
    '.list-rst__name a[href]',
    '.rstname a[href]',
    'a[href*="/rstLst/"][href*="/dtl"]'
  ].join(', '));
  primary.forEach(a => {
    if (isInsideExcludedWidget(a)) return;
    const rawHref = a.getAttribute('href') || '';
    const href = resolveUrl(rawHref, baseUrl).split('?')[0];
    if (RST_URL_RE.test(href)) addUniqueLink(links, href);
  });
  // 【重要】ページ全体を無条件に走査するフォールバックは廃止した。
  // 正規のカードセレクタに一致しないリンクをすべて拾ってしまうと、
  // 「周辺のおすすめ店舗」等、無関係エリアの店舗まで混入する事故が起きるため、
  // 0件ならそのまま0件として扱う（＝安全側に倒す）。
  return links;
}

function tabelogGetNextUrl(doc, baseUrl, pageNum = 1) {
  const nextBtn = doc.querySelector('a.c-pagination__arrow--next')
    || doc.querySelector('.c-pagination__arrow--next a')
    || doc.querySelector('a[rel="next"]')
    || Array.from(doc.querySelectorAll('a[href]')).find(isLikelyNextAnchor);
  if (nextBtn && !nextBtn.classList.contains('is-disabled')) {
    const rawHref = nextBtn.getAttribute('href') || '';
    return resolveUrl(rawHref, baseUrl);
  }
  return deriveTabelogNextUrl(baseUrl, pageNum);
}

function hotpepperGetLinks(doc, baseUrl) {
  const links = [];
  const anchors = doc.querySelectorAll([
    '.shopDetailTop a',
    '.shopName a',
    'h3.shopName a',
    'a.shopDetailLink',
    '.list-cassette__unit a',
    'a[href*="/strJ"]'
  ].join(', '));
  anchors.forEach(a => {
    const rawHref = a.getAttribute('href') || '';
    let href = resolveUrl(rawHref, baseUrl).split('?')[0].split('#')[0];
    if (/^https?:\/\/(www\.)?hotpepper\.jp\/(strJ[A-Z0-9]+|A[A-Z0-9]+)\/?$/.test(href)) {
      if (!href.endsWith('/')) href += '/';
      addUniqueLink(links, href);
    }
  });
  if (links.length === 0) {
    doc.querySelectorAll('a[href]').forEach(a => {
      const rawHref = a.getAttribute('href') || '';
      let href = resolveUrl(rawHref, baseUrl).split('?')[0].split('#')[0];
      if (/^https?:\/\/(www\.)?hotpepper\.jp\/(strJ[A-Z0-9]+|A[A-Z0-9]+)\/?$/.test(href)) {
        if (!href.endsWith('/')) href += '/';
        addUniqueLink(links, href);
      }
    });
  }
  return links;
}

function hotpepperGetNextUrl(doc, baseUrl, pageNum = 1) {
  const pagerContainers = doc.querySelectorAll('.pageLinkLinearBasic, .pagination, .pager, .page-list, .pageList, .page-link');
  let nextBtn = null;
  for (const container of pagerContainers) {
    const anchors = Array.from(container.querySelectorAll('a'));
    nextBtn = anchors.find(isLikelyNextAnchor);
    if (nextBtn) break;
  }
  if (!nextBtn) {
    const anchors = Array.from(doc.querySelectorAll('a[href]'));
    nextBtn = anchors.find(isLikelyNextAnchor);
  }
  if (nextBtn) {
    const rawHref = nextBtn.getAttribute('href') || '';
    return resolveUrl(rawHref, baseUrl);
  }
  return deriveHotpepperNextUrl(baseUrl, pageNum);
}

function validateWebsiteUrl(url) {
  if (!url) return '無';
  const urlLower = url.toLowerCase().trim();
  const portalDomains = [
    'tabelog.com', 'hotpepper.jp', 'gorp.jp', 'gnavi.co.jp', 'retty.me',
    'favy.jp', 'favy.me', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'ameblo.jp'
  ];
  const isPortal = portalDomains.some(domain => urlLower.includes(domain));
  return (isPortal || urlLower === '') ? '無' : '有';
}

async function fetchAndParseDetail(link, siteType, context = {}, timeoutMs = 10000, signal = null) {
  try {
    // タイムアウト用controllerと外部signalを両方機能させる
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let fetchSignal = controller.signal;
    if (signal) {
      try {
        fetchSignal = AbortSignal.any([controller.signal, signal]);
      } catch (e) {
        fetchSignal = controller.signal;
      }
    }

    const res = await fetch(link, { signal: fetchSignal });
    clearTimeout(timer);

    if (res.status === 403 || res.status === 429) {
      return { isBlocked: true, url: link };
    }

    const html = await res.text();

    if (/アクセスが拒否されました|一時的に制限|アクセスが集中|Cloudflare|Robot Check|Security Check/i.test(html)) {
      return { isBlocked: true, url: link };
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    let name = '', genre = '', address = '', phone = '', hasWebsite = '無', rawHours = '';

    if (siteType === 'tabelog') {
      // 食べログの<title>は「店名 (ジャンル) - エリア | 食べログ」という形式のため、
      // display-nameが取れずtitleにフォールバックした際に「店名（ジャンル）」が
      // そのまま店名として使われてしまう。ジャンル・エリア部分を切り落とす。
      name = doc.querySelector('.display-name')?.textContent?.trim() || cleanTabelogTitleName(doc.title);
      address = doc.querySelector('p.rstinfo-table__address')?.textContent?.trim() || '';

      let tHours = '';
      let tClosed = '';

      const businessItems = doc.querySelectorAll('.rstinfo-table__business-item');
      if (businessItems.length > 0) {
        const hoursArray = [];
        const closedArray = [];
        businessItems.forEach(item => {
          const txt = _extractCellLines(item);
          if (!txt) return;
          if (txt.includes('定休日')) {
            const closedDayMatch = txt.match(/^([月火水木金土日・\s]+)定休日/);
            if (closedDayMatch) closedArray.push(closedDayMatch[1].trim());
            else closedArray.push(txt);
          } else {
            hoursArray.push(txt);
          }
        });
        tHours = hoursArray.join('\n');
        if (closedArray.length > 0) tClosed = closedArray.join('\n');
      }

      if (!tClosed) {
        const allBusinessText = Array.from(doc.querySelectorAll('.rstinfo-table__business-item')).map(el => el.textContent).join(' ');
        if (/年中無休|無休/.test(allBusinessText)) tClosed = '無休';
      }

      let tclPhone = '';
      let rsvPhone = '';

      doc.querySelectorAll('.rstinfo-table__table th, table th').forEach(th => {
        const t = th.textContent.trim();
        const tdText = th.nextElementSibling?.textContent || '';
        if (t.includes('ジャンル')) genre = th.nextElementSibling?.textContent?.trim() || genre;
        if (t.includes('住所') && !address) address = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('お問い合せ専用番号') || t.includes('お問い合わせ専用') || t === '電話番号') {
          tclPhone = tdText;
        } else if (t.includes('予約') || t.includes('お問い合わせ')) {
          if (!rsvPhone) rsvPhone = tdText;
        }
      });

      if (tClosed && /年中無休/.test(tClosed)) tClosed = '無休';

      const defaultTelText = doc.querySelector('.rstinfo-table__tel-num')?.textContent || '';
      const combinedPhoneText = `${tclPhone}\n${defaultTelText}\n${rsvPhone}`;
      phone = selectBestPhoneNumber(combinedPhoneText);

      if (!phone) {
        const telAnchor = doc.querySelector('a[href^="tel:"]');
        if (telAnchor) phone = telAnchor.getAttribute('href').replace('tel:', '').trim().replace(/[^\d\-]/g, '');
      }

      const hpLink = doc.querySelector('.homepage a, a.c-link-arrow[href*="rst_site_url"], .rstinfo-table__link');
      if (hpLink) {
        hasWebsite = validateWebsiteUrl(hpLink.getAttribute('href'));
      } else {
        const hasHpText = doc.documentElement.textContent.includes('お店のホームページ');
        hasWebsite = hasHpText ? '有' : '無';
      }

      address = address.replace(/大きな地図を見る/g, '').replace(/周辺のお店を探す/g, '').replace(/\s+/g, ' ').trim();

      if (tHours) rawHours += `【営業時間】\n${tHours}\n`;
      if (tClosed) rawHours += `【定休日】\n${tClosed}`;
      rawHours = rawHours.trim();

    } else if (siteType === 'hotpepper') {
      const shopInner = doc.querySelector('.shopInner.meiryoFont') || doc.querySelector('.shopDetailInnerTop') || doc;
      name = shopInner.querySelector('.shopName')?.textContent?.trim()
        || doc.querySelector('h1')?.textContent?.trim()
        || doc.title.split('|')[0].trim();

      let businessHours = '';
      let regularHoliday = '';
      let hpPhoneText = '';

      doc.querySelectorAll('table tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 2) return;
        const label = cells[0].textContent.trim();
        const valFirstLine = cells[1].textContent.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
        const valFull = cells[1].textContent.replace(/\s+/g, ' ').trim();

        if (label === '店名' && (!name || name === doc.title.split('|')[0].trim())) name = valFirstLine || name;
        if (label === '住所' && !address) address = valFull;
        if (label === '電話' || label === 'TEL') hpPhoneText += `\n${cells[1].textContent}`;
        if ((label === 'ジャンル' || label === '料理') && !genre) genre = valFull;
        if (label === '営業時間' && !businessHours) businessHours = _extractCellLines(cells[1]);
        if (label === '定休日' && !regularHoliday) regularHoliday = _extractCellLines(cells[1]);
      });

      shopInner.querySelectorAll('th').forEach(th => {
        const t = th.textContent?.split('\n')[0].trim() || '';
        const td = th.nextElementSibling;
        if (!td) return;
        const tdText = td.textContent.trim().split('\n')[0].trim();
        const tdFull = td.textContent.replace(/\s+/g, ' ').trim();

        if (t.includes('店名') && (!name || name === doc.title.split('|')[0].trim())) name = tdText || name;
        if (t.includes('住所') && !address) address = tdFull || '';
        if (t.includes('電話') || t.includes('TEL') || t.includes('問い合わせ')) hpPhoneText += `\n${td.textContent}`;
        if ((t.includes('ジャンル') || t.includes('料理')) && !genre) genre = tdFull || '';
        if (t.includes('営業時間') && !businessHours) businessHours = _extractCellLines(td);
        if (t.includes('定休日') && !regularHoliday) regularHoliday = _extractCellLines(td);
      });

      if (!businessHours && !regularHoliday) {
        doc.querySelectorAll('dl').forEach(dl => {
          const dt = dl.querySelector('dt');
          const dd = dl.querySelector('dd');
          if (!dt || !dd) return;
          const t = dt.textContent.trim();
          if (t.includes('営業時間') && !businessHours) businessHours = _extractCellLines(dd);
          if (t.includes('定休日') && !regularHoliday) regularHoliday = _extractCellLines(dd);
          if (t.includes('住所') && !address) address = dd.textContent.replace(/\s+/g, ' ').trim();
          if ((t.includes('ジャンル') || t.includes('料理')) && !genre) genre = dd.textContent.replace(/\s+/g, ' ').trim();
        });
      }

      if (!address) address = shopInner.querySelector('.shopDetailInfoAddress')?.textContent?.trim() || shopInner.querySelector('.address')?.textContent?.trim() || '';

      phone = selectBestPhoneNumber(hpPhoneText);
      if (!phone) phone = shopInner.querySelector('.shopDetailInfoTel')?.textContent?.trim() || shopInner.querySelector('.tel')?.textContent?.trim() || shopInner.querySelector('a[href^="tel:"]')?.textContent?.trim() || '';

      const telLinkNode = doc.querySelector('.telLink');
      if (telLinkNode || !phone || phone.includes('電話番号を表示する') || phone.startsWith('050')) {
        try {
          let telUrl = telLinkNode ? telLinkNode.getAttribute('href') : '';
          if (telUrl && !telUrl.startsWith('http')) {
            if (telUrl.startsWith('/')) telUrl = new URL(link).origin + telUrl;
            else telUrl = (link.endsWith('/') ? link.slice(0, -1) : link) + '/' + telUrl;
          }
          if (!telUrl) telUrl = (link.endsWith('/') ? link : link + '/') + 'tel/';
          await sleep(500);
          const telController = new AbortController();
          const telTimer = setTimeout(() => telController.abort(), 8000);
          let telFetchSignal = telController.signal;
          if (signal) {
            try { telFetchSignal = AbortSignal.any([telController.signal, signal]); } catch (e) { }
          }
          const telRes = await fetch(telUrl, { signal: telFetchSignal });
          clearTimeout(telTimer);
          const telDoc = new DOMParser().parseFromString(await telRes.text(), 'text/html');
          const telNode = telDoc.querySelector('.telephoneNumber, .tel, .telephone, a[href^="tel:"]');
          if (telNode) {
            let rawTel = telNode.textContent;
            let extractedSub = selectBestPhoneNumber(rawTel);
            if (extractedSub) {
              phone = extractedSub;
            } else if (telNode.tagName === 'A' && telNode.getAttribute('href')?.startsWith('tel:')) {
              phone = telNode.getAttribute('href').replace('tel:', '').trim();
            } else {
              phone = rawTel.replace(/[^\d\-]/g, '');
            }
          }
        } catch (e) { }
      }

      const hpLink = doc.querySelector('a[href^="http"]:not([href*="hotpepper"])');
      if (hpLink) {
        hasWebsite = validateWebsiteUrl(hpLink.getAttribute('href'));
      } else {
        const hasHpText = doc.documentElement.textContent.includes('お店のホームページ');
        hasWebsite = hasHpText ? '有' : '無';
      }

      address = address.replace(/地図を見る/g, '').replace(/\s+/g, ' ').replace(/\n/g, '').trim();
      phone = phone.replace(/[^\d\-]/g, '');
      name = name.replace(/\n/g, '').trim();
      genre = genre.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

      if (businessHours) rawHours += `【営業時間】\n${businessHours}\n`;
      if (regularHoliday) rawHours += `【定休日】\n${regularHoliday}`;
      rawHours = rawHours.trim();
    }

    const parsedAddr = parseAddress(address);
    const searchArea = context.area || '';
    if (searchArea) {
      const cleanArea = searchArea.replace(/駅周辺|エリア|付近/g, '').trim();
      if (/[市区町村]$/.test(cleanArea) && parsedAddr.city && !parsedAddr.city.includes(cleanArea) && !cleanArea.includes(parsedAddr.city)) {
        return null;
      }
    }

    return { name, genre, address, phone, rawHours, hasWebsite, url: link, source: siteType };

  } catch (e) {
    return null;
  }
}

// =====================================================================
// 【新規】食べログ: 一覧ページからURLを全収集（ページネーション完走）
// =====================================================================
async function collectTabelogStoreUrls(task, tabId) {
  const allLinks = [];
  const seen = new Set();
  let currentUrl = task.listUrl;
  let pageNum = 1;
  const maxPages = task.maxPages || 20;

  // ページネーションで辿って良いURLを「開始URLと同じ都道府県＋エリアコード＋ジャンル」に
  // 固定する。次ページ判定（「次へ」リンクの誤検出）がどこで起きても、この範囲外の
  // URLには絶対に進めないようにする最終防御ライン。
  const paginationPrefixMatch = String(task.listUrl || '').match(/^(https:\/\/tabelog\.com\/[a-z]+\/[A-Za-z]\d+\/rstLst\/[^/]+\/)/);
  const paginationPrefix = paginationPrefixMatch ? paginationPrefixMatch[1] : null;

  sendToBackground(tabId, 'INFO', { message: '📋 一覧ページのURL収集を開始...' });

  while (pageNum <= maxPages && task.running) {
    await sleep(DELAY_LIST_FETCH);

    try {
      const res = await fetch(currentUrl);
      if (res.status === 403 || res.status === 429) {
        sendToBackground(tabId, 'INFO', { message: `⚠️ 一覧ページ取得でブロック(${res.status})` });
        break;
      }
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      if (pageNum === 1) {
        const meta = extractMetadata(doc, 'tabelog');
        if (meta.area || meta.industry) task.metadata = { ...task.metadata, ...meta };
        if (!task.metadata.area || !task.metadata.industry) {
          const parts = doc.title.split(' ').filter(Boolean);
          if (!task.metadata.area && parts[0]) task.metadata.area = parts[0];
          if (!task.metadata.industry && parts[1]) task.metadata.industry = parts[1];
        }
      }

      const links = tabelogGetLinks(doc, currentUrl);
      let newCount = 0;
      links.forEach(l => {
        const normalized = normalizeListUrl(l);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          allLinks.push(l);
          newCount++;
        }
      });

      sendToBackground(tabId, 'INFO', { message: `📋 一覧${pageNum}ページ: ${newCount}件 (累計${allLinks.length}件)` });

      if (links.length === 0) break;

      const nextUrl = tabelogGetNextUrl(doc, currentUrl, pageNum);
      if (!nextUrl) {
        sendToBackground(tabId, 'INFO', { message: '最終ページに達しました' });
        break;
      }
      if (paginationPrefix && !nextUrl.startsWith(paginationPrefix)) {
        sendToBackground(tabId, 'INFO', { message: `⚠️ 「次へ」の誤検出により対象エリア外へ脱線しそうだったため打ち切りました` });
        break;
      }

      currentUrl = nextUrl;
      pageNum++;
    } catch (e) {
      if (e.name === 'AbortError') break;
      console.warn(`[collectUrls] page=${pageNum}`, e);
      break;
    }
  }

  sendToBackground(tabId, 'INFO', { message: `🔍 ${pageNum}ページから${allLinks.length}件のURL収集完了` });
  return allLinks;
}

// =====================================================================
// 【新規】詳細ページを並列取得（食べログ・ホットペッパー共通ワーカー）
// =====================================================================
async function fetchDetailsBatch(task, tabId, storeUrls, siteType, listUrl, pageNum = 1) {
  let activeConcurrency = siteType === 'tabelog'
    ? (task.tabelogConcurrency || 3)
    : (task.hotpepperConcurrency || 6);
  let activeDelay = siteType === 'tabelog'
    ? (task.tabelogDelay || 1000)
    : (task.hotpepperDelay || 500);

  const maxConcurrency = activeConcurrency;
  const minDelay = activeDelay;

  task.stats.activeConcurrency = activeConcurrency;
  task.stats.activeDelay = activeDelay;

  const baseIndex = task.results.filter(Boolean).length;
  const tasksToRun = storeUrls.map((link, idx) => ({ link, originalIndex: baseIndex + idx }));

  // インデックス参照のため配列を事前拡張
  while (task.results.length < baseIndex + storeUrls.length) {
    task.results.push(undefined);
  }

  let currentIndex = 0;
  let activeCount = 0;
  let batchSuccess = 0;
  let batchLatestName = '';
  const recentWindow = [];

  const targetTabId = typeof tabId === 'string' && tabId.includes('_pg_')
    ? parseInt(tabId.split('_pg_')[0])
    : tabId;

  function checkFailureRate() {
    if (recentWindow.length < 10) return;
    const fails = recentWindow.filter(x => !x).length;
    const rate = fails / recentWindow.length;

    if (rate >= 0.2 && !task.stats.isThrottling) {
      activeConcurrency = Math.max(1, activeConcurrency - 1);
      activeDelay = Math.min(7000, activeDelay + 1000);
      task.stats.activeConcurrency = activeConcurrency;
      task.stats.activeDelay = activeDelay;
      sendToBackground(targetTabId, 'INFO', {
        message: `⚠️ 失敗率${Math.round(rate * 100)}% → 並列${activeConcurrency}/待機${activeDelay}ms`
      });
    } else if (rate <= 0.05 && recentWindow.length >= 20 && !task.stats.isThrottling) {
      if (activeConcurrency < maxConcurrency || activeDelay > minDelay) {
        activeConcurrency = Math.min(maxConcurrency, activeConcurrency + 1);
        activeDelay = Math.max(minDelay, activeDelay - 300);
        task.stats.activeConcurrency = activeConcurrency;
        task.stats.activeDelay = activeDelay;
      }
    }
  }

  function sendProgress(latestName = '') {
    const currentCollected = task.results.filter(Boolean).length;
    sendToBackground(targetTabId, 'PROGRESS', {
      collected: currentCollected,
      maxItems: task.maxItems,
      latest: latestName,
      page: pageNum,
      successCount: task.stats.successCount,
      failedCount: task.stats.failedCount,
      retryingCount: task.stats.retryingCount,
      blockCount: task.stats.blockCount,
      timeoutCount: task.stats.timeoutCount,
      noNameCount: task.stats.noNameCount,
      noAddressCount: task.stats.noAddressCount,
      noPhoneCount: task.stats.noPhoneCount,
      htmlMismatchCount: task.stats.htmlMismatchCount,
      otherFailCount: task.stats.otherFailCount,
      isThrottling: task.stats.isThrottling,
      activeConcurrency: task.stats.activeConcurrency,
      activeDelay: task.stats.activeDelay
    });
  }

  async function worker() {
    while (currentIndex < tasksToRun.length && task.running) {
      const currentCollected = task.results.filter(Boolean).length;
      if (currentCollected >= task.maxItems) break;

      const item = tasksToRun[currentIndex++];
      if (!item) break;

      activeCount++;
      task.stats.activeConcurrency = activeCount;

      const delay = task.stats.isThrottling ? 7000 : activeDelay;
      if (delay > 0) await sleep(delay);
      if (!task.running) { activeCount--; task.stats.activeConcurrency = activeCount; break; }

      try {
        let detail = null;
        let retries = 0;
        const maxRetriesVal = task.maxRetries ?? 1;

        while (retries <= maxRetriesVal && task.running) {
          if (retries > 0) {
            task.stats.retryingCount++;
            sendProgress();
            await sleep(retries * 1500);
            task.stats.retryingCount--;
            if (!task.running) break;
          }
          try {
            const timeoutMs = (task.fetchTimeout || 15) * 1000;
            detail = await fetchAndParseDetail(
              item.link, siteType,
              { area: task.metadata.area, listUrl: listUrl || task.listUrl },
              timeoutMs,
              task.abortController?.signal
            );
            if (detail && detail.isBlocked) throw new Error('BLOCKED');
            break;
          } catch (err) {
            if (err.name === 'AbortError') {
              console.warn(`[offscreen] タイムアウト: ${item.link}`);
            } else {
              console.warn(`[offscreen] フェッチエラー: ${item.link}`, err.message);
            }
            retries++;
            if (retries > maxRetriesVal) throw err;
          }
        }

        if (detail && detail.name && task.running) {
          const normalized = normalizeBusinessHours(detail.rawHours || '');
          const parsedAddr = parseAddress(detail.address);

          // エリア一致チェック：店舗自身の住所に対象エリア名が含まれていなければ、
          // 一覧ページのDOM構造がどうであれ「別エリアの混入」として破棄する。
          if (task.expectedAreaName && detail.address && !String(detail.address).includes(task.expectedAreaName)) {
            task.stats.areaMismatchCount = (task.stats.areaMismatchCount || 0) + 1;
            sendToBackground(targetTabId, 'INFO', {
              message: `🚫 対象エリア外のため除外: 「${detail.name}」(${detail.address})`
            });
            sendProgress();
            continue;
          }

          const finalDetail = {
            name: detail.name,
            genre: resolveFinalGenre(detail.genre, detail.name),
            sourceGenre: detail.genre,
            prefecture: parsedAddr.prefecture,
            city: parsedAddr.city,
            address: detail.address,
            phone: detail.phone || '',
            regularHoliday: normalized.holiday || '',
            businessDays: normalized.businessDays || '',
            openTimeA: normalized.openTimeA || '',
            closeTimeA: normalized.closeTimeA || '',
            openTimeB: normalized.openTimeB || '',
            closeTimeB: normalized.closeTimeB || '',
            rawHours: detail.rawHours || '',
            url: detail.url,
            hasWebsite: detail.hasWebsite,
            source: detail.source === 'tabelog' ? '食べログ' : 'ホットペッパー',
            sourceUrl: listUrl || task.listUrl,
            scrapedAt: new Date().toISOString()
          };

          task.results[item.originalIndex] = finalDetail;
          task.stats.successCount++;
          if (!finalDetail.address) task.stats.noAddressCount++;
          if (!finalDetail.phone) task.stats.noPhoneCount++;

          recentWindow.push(true);
          if (recentWindow.length > 20) recentWindow.shift();

          if (task.stats.isThrottling) {
            task.stats.isThrottling = false;
            activeConcurrency = Math.min(maxConcurrency, activeConcurrency + 1);
            activeDelay = Math.max(minDelay, activeDelay - 2000);
            task.stats.activeConcurrency = activeConcurrency;
            task.stats.activeDelay = activeDelay;
            sendToBackground(targetTabId, 'INFO', { message: '✅ 正常通信を検知。速度を復帰します' });
          }

          // バッチログ: 5件ごとに店名を表示
          batchSuccess++;
          batchLatestName = detail.name;
          if (batchSuccess % 5 === 0) {
            sendProgress(batchLatestName);
          } else {
            sendProgress('');
          }
        } else {
          task.stats.failedCount++;
          if (!detail) {
            task.stats.otherFailCount++;
          } else {
            task.stats.noNameCount++;
          }
          recentWindow.push(false);
          if (recentWindow.length > 20) recentWindow.shift();
          sendProgress();
        }

        checkFailureRate();

      } catch (err) {
        console.error(`[offscreen] ${item.link} 最終失敗:`, err.message);
        task.stats.failedCount++;

        if (err.message === 'BLOCKED' || err.message?.includes('403') || err.message?.includes('429')) {
          task.stats.blockCount++;
          if (!task.stats.isThrottling) {
            task.stats.isThrottling = true;
            activeConcurrency = 1;
            activeDelay = 7000;
            task.stats.activeConcurrency = activeConcurrency;
            task.stats.activeDelay = activeDelay;
            sendToBackground(targetTabId, 'INFO', {
              message: '⚠️ アクセス拒否検知。自動減速（並列1/待機7000ms）'
            });
          }
        } else if (err.name === 'AbortError') {
          task.stats.timeoutCount++;
        } else {
          task.stats.otherFailCount++;
        }

        recentWindow.push(false);
        if (recentWindow.length > 20) recentWindow.shift();
        sendProgress();
      } finally {
        activeCount--;
        task.stats.activeConcurrency = activeCount;
      }
    }
  }

  const workersCount = task.stats.isThrottling ? 1 : activeConcurrency;
  const workers = [];
  for (let w = 0; w < workersCount; w++) workers.push(worker());
  await Promise.all(workers);

  sendProgress(batchLatestName);
}

// =====================================================================
// ホットペッパー: ページ単位クロール（既存フロー維持）
// =====================================================================
async function runHotpepperCrawl(task, tabId) {
  let pageNum = 1;
  let currentListUrl = task.listUrl;

  while (task.running && task.results.filter(Boolean).length < task.maxItems) {
    const genreLabel = task.metadata?.industry ? `["${task.metadata.industry}"]` : '';
    sendToBackground(tabId, 'PAGE_START', {
      page: pageNum,
      collected: task.results.filter(Boolean).length,
      siteName: 'ホットペッパー',
      genreLabel
    });

    await sleep(DELAY_LIST_FETCH);
    const res = await fetch(currentListUrl);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    if (pageNum === 1) {
      const meta = extractMetadata(doc, 'hotpepper');
      if (meta.area || meta.industry) task.metadata = { ...task.metadata, ...meta };
      if (!task.metadata.area || !task.metadata.industry) {
        const parts = doc.title.split(' ').filter(Boolean);
        if (!task.metadata.area && parts[0]) task.metadata.area = parts[0];
        if (!task.metadata.industry && parts[1]) task.metadata.industry = parts[1];
      }
    }

    const existingUrls = new Set(task.results.filter(Boolean).map(r => normalizeListUrl(r.url)));
    let links = (hotpepperGetLinks(doc, currentListUrl) || []).filter(l => !existingUrls.has(normalizeListUrl(l)));
    const remaining = task.maxItems - task.results.filter(Boolean).length;
    links = links.slice(0, remaining);

    if (links.length === 0) {
      sendToBackground(tabId, 'INFO', { message: `${genreLabel} ${pageNum}ページ: 新規リンクなし → 終了` });
      break;
    }

    sendToBackground(tabId, 'INFO', { message: `📋 ${genreLabel} ${pageNum}ページ: ${links.length}件` });

    await fetchDetailsBatch(task, tabId, links, 'hotpepper', currentListUrl, pageNum);

    if (!task.running || task.results.filter(Boolean).length >= task.maxItems) break;

    const nextUrl = hotpepperGetNextUrl(doc, currentListUrl, pageNum);
    if (!nextUrl) {
      sendToBackground(tabId, 'INFO', { message: `${genreLabel} 最終ページ` });
      break;
    }

    currentListUrl = nextUrl;
    pageNum++;
  }
}

// =====================================================================
// メインクロールタスク（食べログ=2フェーズ / ホットペッパー=ページ単位）
// =====================================================================
async function runCrawlTask(tabId) {
  const task = activeTasks.get(tabId);
  if (!task) return;

  const siteType = getSiteType(task.listUrl);
  if (!siteType) {
    sendToBackground(tabId, 'ERROR', { message: '対応サイトではありません' });
    return;
  }

  try {
    if (siteType === 'tabelog') {
      // Phase 1: 一覧URLを全収集
      const storeUrls = await collectTabelogStoreUrls(task, tabId);
      if (!task.running) return;

      // globalSeenUrls によるジャンル間重複排除
      let filteredUrls = storeUrls;
      if (task.globalSeenUrls) {
        const before = filteredUrls.length;
        filteredUrls = filteredUrls.filter(url => {
          const n = normalizeListUrl(url);
          if (task.globalSeenUrls.has(n)) return false;
          task.globalSeenUrls.add(n);
          return true;
        });
        const skipped = before - filteredUrls.length;
        if (skipped > 0) {
          sendToBackground(tabId, 'INFO', { message: `🔁 重複URL ${skipped}件スキップ (残${filteredUrls.length}件)` });
        }
      }

      const remaining = task.maxItems - task.results.filter(Boolean).length;
      filteredUrls = filteredUrls.slice(0, remaining);

      if (filteredUrls.length === 0) {
        sendToBackground(tabId, 'INFO', { message: '新規URLなし' });
      } else {
        sendToBackground(tabId, 'INFO', { message: `📊 ${filteredUrls.length}件の詳細ページを並列取得開始` });
        // Phase 2: 詳細並列取得
        await fetchDetailsBatch(task, tabId, filteredUrls, 'tabelog', task.listUrl, 1);
      }
    } else {
      await runHotpepperCrawl(task, tabId);
    }
  } catch (err) {
    console.error('クロール処理エラー:', err);
    sendToBackground(tabId, 'ERROR', { message: err.message });
  } finally {
    task.running = false;
    task.results = task.results.filter(Boolean);

    // ★修正: 人気ジャンル一括取得のサブタスクでは、従来は詳細ページ側のジャンルに
    // 関わらず巡回中のカテゴリ名（forceGenre）を無条件採用していたが、これだと
    // 「和食」ページ経由で見つかった寿司屋・焼き鳥屋・ラーメン屋・カフェ・バー等が
    // 実態と無関係に全件「和食」になってしまう不具合があった（木更津市の和食巡回
    // 296件が全件「和食」になっていたケースで実証済み）。
    // r.genre は個別取得時点で既に resolveFinalGenre() を通っており
    // （店名の居酒屋最優先ルール・詳細ページ自身のジャンル・店名キーワードの順で
    // 判定済み）、それが有効な統一ジャンルであればそちらを優先し、判定できなかった
    // 場合のみ巡回中のカテゴリ（forceGenre）を最後の手段として使う。
    if (task.forceGenre) {
      task.results = task.results.map(r => ({
        ...r,
        genre: isValidFinalGenre(r.genre) ? r.genre : task.forceGenre,
        source_genre: task.forceGenre
      }));
    }

    const collected = task.results.length;

    sendToBackground(tabId, 'DONE', {
      collected,
      results: task.results,
      metadata: task.metadata,
      successCount: task.stats.successCount,
      failedCount: task.stats.failedCount,
      blockCount: task.stats.blockCount,
      timeoutCount: task.stats.timeoutCount,
      noNameCount: task.stats.noNameCount,
      noAddressCount: task.stats.noAddressCount,
      noPhoneCount: task.stats.noPhoneCount,
      htmlMismatchCount: task.stats.htmlMismatchCount,
      otherFailCount: task.stats.otherFailCount,
      retryingCount: 0,
      isThrottling: false,
      activeConcurrency: 0,
      activeDelay: 0
    });

    const mediaName = task.metadata.media === 'tabelog'
      ? '食べログ'
      : (task.metadata.media === 'hotpepper' ? 'ホットペッパー' : 'サイト');
    const area = task.metadata.area || '';
    const industry = task.metadata.industry || '';

    let title, message;
    if (task.stoppedManually) {
      title = '取得停止';
      message = `${area} ${industry} (${mediaName}) 停止。計 ${collected} 件取得済み`;
    } else if (collected >= task.maxItems) {
      title = '取得完了 (上限到達)';
      message = `${area} ${industry} (${mediaName}) 計 ${collected} 件`;
    } else {
      title = '取得完了';
      message = `${area} ${industry} (${mediaName}) 計 ${collected} 件`;
    }

    chrome.runtime.sendMessage({ target: 'background', type: 'SHOW_NOTIFICATION', title, message });

    if (task.results.length > 0) {
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'DOWNLOAD_CSV',
        results: task.results,
        metadata: task.metadata,
        tabId
      });
    }
  }
}

// =====================================================================
// メッセージリスナー
// =====================================================================
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  const tabId = message.tabId;

  if (message.type === 'GENRE_LINKS_FROM_CONTENT_RESULT') {
    const resolver = genreLinksResolvers.get(message.tabId);
    if (resolver) {
      resolver(message.links || []);
      genreLinksResolvers.delete(message.tabId);
    }
    sendResponse && sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'START_CRAWL') {
    if (activeTasks.get(tabId)?.running) {
      sendResponse({ ok: false, error: 'このタブで既に実行中です' });
      return;
    }
    const siteType = getSiteType(message.listUrl);
    const controller = new AbortController();
    activeTasks.set(tabId, {
      running: true,
      stoppedManually: false,
      tabId,
      listUrl: message.listUrl,
      results: [],
      maxItems: message.maxItems || Infinity,
      maxPages: message.maxPages || 20,
      metadata: { media: siteType, area: '', industry: '' },
      abortController: controller,
      tabelogConcurrency: message.tabelogConcurrency || 3,
      tabelogDelay: message.tabelogDelay || 1000,
      hotpepperConcurrency: message.hotpepperConcurrency || 6,
      hotpepperDelay: message.hotpepperDelay || 500,
      maxRetries: message.maxRetries ?? 1,
      fetchTimeout: message.fetchTimeout || 15,
      stats: {
        successCount: 0,
        failedCount: 0,
        retryingCount: 0,
        blockCount: 0,
        timeoutCount: 0,
        noNameCount: 0,
        noAddressCount: 0,
        noPhoneCount: 0,
        htmlMismatchCount: 0,
        otherFailCount: 0,
        isThrottling: false,
        activeConcurrency: 0,
        activeDelay: 0
      }
    });
    runCrawlTask(tabId);
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'STOP_CRAWL') {
    const task = activeTasks.get(tabId);
    if (task) {
      task.running = false;
      task.stoppedManually = true;
      task.abortController?.abort();
    }
    const popularTask = activeTasks.get(tabId + '_popular');
    if (popularTask) {
      popularTask.running = false;
      popularTask.stoppedManually = true;
      popularTask.abortController?.abort();
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'GET_RESULTS') {
    const popularTask = activeTasks.get(tabId + '_popular');
    const task = popularTask || activeTasks.get(tabId);
    if (task) {
      sendResponse({
        results: task.results || [],
        running: task.running || false,
        metadata: task.metadata || {}
      });
    } else {
      sendResponse({ results: [], running: false, metadata: {} });
    }
    return;
  }

  if (message.action === 'START_POPULAR_GENRE_CRAWL') {
    if (activeTasks.get(tabId)?.running || activeTasks.get(tabId + '_popular')?.running) {
      sendResponse({ ok: false, error: 'このタブで既に実行中です' });
      return;
    }
    const speedConfig = {
      tabelogConcurrency: message.tabelogConcurrency,
      tabelogDelay: message.tabelogDelay,
      hotpepperConcurrency: message.hotpepperConcurrency,
      hotpepperDelay: message.hotpepperDelay,
      maxRetries: message.maxRetries,
      fetchTimeout: message.fetchTimeout,
      maxPages: message.maxPages
    };
    runPopularGenreCrawl(tabId, message.listUrl, message.maxItems || Infinity, speedConfig, message.selectedGenres);
    sendResponse({ ok: true });
    return;
  }
});

// =====================================================================
// =====================================================================
// 食べログ「人気のジャンル」固定カテゴリ一覧（対象5カテゴリ・スラッグは食べログ側で固定）
// バルーンをホバーしてDOMから拾う方式は、対象要素の取り違えや別バルーンの
// 混入（＝他エリア混入バグの原因）が起きやすいため、エリアURLとスラッグから
// 対象カテゴリのURLを直接組み立てる。
// =====================================================================
const TABELOG_POPULAR_GENRE_SLUGS = [
  { name: 'カフェ', slug: 'cafe' },
  { name: 'スイーツ', slug: 'sweets' },
  { name: '居酒屋', slug: 'izakaya' },
  { name: 'バー・お酒', slug: 'bar' },
  { name: '焼き鳥', slug: 'yakitori' },
];

// 食べログカテゴリ → GAS側で最終的に使う統一ジャンルへの対応表。
// GAS側の HD_GENRE_MAP / HD_TARGET_GENRES と同じ対応関係にしておくこと。
// （例: うなぎ・天ぷら・とんかつ・沖縄料理・日本料理・海鮮＝すべて「和食」に集約、
// 　　  ホルモン＝「焼肉」に集約、餃子＝「中華」に集約 など）
// 「料理旅館」「ビュッフェ・バイキング」は対応する統一ジャンルが無いため、
// GAS側のHD_GENRE_MAPと同様に「和食」へ集約する（意図的な集約であり未マッピングではない）。
const TABELOG_GENRE_TO_FINAL_GENRE = {
  '和食': '和食',
  '日本料理': '和食',
  '寿司': '寿司',
  '海鮮・魚介': '和食',
  'そば（蕎麦）': '蕎麦・うどん',
  'うなぎ': '和食',
  '焼き鳥': '焼き鳥',
  '洋食': '洋食',
  'フレンチ': '洋食',
  'イタリアン': '洋食',
  'ステーキ': '洋食',
  '中華料理': '中華',
  'ラーメン': 'ラーメン',
  'カレー': '洋食',
  '居酒屋': '居酒屋',
  'パン': 'パン屋',
  'スイーツ': 'スイーツ',
  'バー・お酒': 'バー',
  '天ぷら': '和食',
  '焼肉': '焼肉',
  'ハンバーグ': '洋食',
  'とんかつ': '和食',
  'うどん': '蕎麦・うどん',
  '沖縄料理': '和食',
  'ハンバーガー': 'ハンバーガー',
  'パスタ': '洋食',
  'ピザ': '洋食',
  '餃子': '中華',
  'ホルモン': '焼肉',
  'カフェ': 'カフェ',
  '喫茶店': 'カフェ',
  'ケーキ': 'スイーツ',
  '食堂': '定食・食堂',
  '料理旅館': '和食',
  'ビュッフェ・バイキング': '和食',

  // ↓ここから: 詳細ページ側の自由記述ジャンルタグ（固定カテゴリの枠外）で
  // 実データ上よく出現する表記。人気ジャンル巡回でforceGenreに頼らず
  // 詳細ページ自身のジャンルから統一ジャンルを決められるようにするための追加
  // （例: 木更津市「和食」巡回結果296件が全件「和食」になり、実際は寿司・焼き鳥・
  // ラーメン・カフェ・バー等が多数混在していた不具合の対応）。
  '海鮮': '和食',
  '海鮮丼': '和食',
  'しゃぶしゃぶ': '和食',
  'すき焼き': '和食',
  '釜飯': '和食',
  'どじょう': '和食',
  'おでん': '和食',
  'かき': '和食',
  'シーフード': '和食',
  '韓国料理': '韓国',
  '韓国': '韓国',
  'お好み焼き': 'お好み焼き',
  'もんじゃ焼き': 'お好み焼き',
  '焼きそば': 'お好み焼き',
  'たこ焼き': 'お好み焼き',
  '鳥料理': '焼き鳥',
  '串焼き': '焼き鳥',
  'もつ焼き': '焼き鳥',
  '回転寿司': '寿司',
  '弁当': 'テイクアウト専門店',
  'からあげ': 'テイクアウト専門店',
  'おにぎり': 'テイクアウト専門店',
  '牛丼': '定食・食堂',
  '豚丼': '定食・食堂',
  'かつ丼': '定食・食堂',
  '親子丼': '定食・食堂',
  '丼': '定食・食堂',
  'ちゃんぽん': 'ラーメン',
  '牛タン': '焼肉',
  'ビュッフェ': '和食',
  'バー': 'バー',
  'ダイニングバー': 'バー',
  '飲茶・点心': '中華',
  '台湾料理': '中華',
  'ろばた焼き': '居酒屋',
  'ファミレス': '洋食'
};

function mapToFinalGenre(rawCategoryName) {
  const raw = String(rawCategoryName || '').trim();
  if (TABELOG_GENRE_TO_FINAL_GENRE[raw]) return TABELOG_GENRE_TO_FINAL_GENRE[raw];

  // 詳細ページ側のジャンルは「カフェ、カレー、ラーメン」のようにカンマ/読点区切りの
  // 複合タグで来ることが多い。食べログは代表的なタグを先頭に並べる傾向があるため、
  // 先頭から順に対応表に一致する要素を採用する。
  const parts = raw.split(/[、,]/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (TABELOG_GENRE_TO_FINAL_GENRE[part]) return TABELOG_GENRE_TO_FINAL_GENRE[part];
  }

  return raw;
}

// 本派生版の最終出力ジャンル。美容院はHot Pepper Beauty専用拡張が担当する。
const FINAL_GENRE_LIST = ['カフェ', 'スイーツ', '居酒屋', 'スナック', 'バー', '焼き鳥'];
function isValidFinalGenre(genre) {
  return FINAL_GENRE_LIST.indexOf(String(genre || '').trim()) !== -1;
}

// 生ジャンルから統一ジャンルが決まらなかった場合に店名から優先的に拾うジャンルキーワード。
// 具体的な複合語ほど誤爆しにくいので先に判定させる。実データで「カフェ」検索時に
// ラーメン屋・うどん屋等が検索語のままカフェに確定してしまう不具合を確認済みのための対応。
// GAS/google-maps-scraper-cookingと同じ内容にしておくこと。
const NAME_GENRE_PRIORITY_LIST = [
  ['中華そば', 'ラーメン'],
  ['油そば', 'ラーメン'],
  ['まぜそば', 'ラーメン'],
  ['つけ麺', 'ラーメン'],
  ['拉麺', 'ラーメン'],
  ['タンメン', 'ラーメン'],
  ['ラーメン', 'ラーメン'],
  ['麺屋', 'ラーメン'],
  ['麺や', 'ラーメン'],
  ['讃岐', '蕎麦・うどん'],
  ['うどん', '蕎麦・うどん'],
  ['そば', '蕎麦・うどん'],
  ['お好み焼き', 'お好み焼き'],
  ['もんじゃ', 'お好み焼き'],
  ['焼き鳥', '焼き鳥'],
  ['焼鳥', '焼き鳥'],
  ['焼き肉', '焼肉'],
  ['焼肉', '焼肉'],
  ['スナック', 'スナック'],
  ['寿司', '寿司'],
  ['鮨', '寿司'],
  ['うなぎ', '和食'],
  ['鰻', '和食'],
  ['天ぷら', '和食'],
  ['中華', '中華'],
  ['餃子', '中華'],
  ['韓国', '韓国'],
  ['ハンバーガー', 'ハンバーガー'],
  ['ベーカリー', 'パン屋'],
  ['パン屋', 'パン屋'],
  ['カフェ', 'カフェ'],
  ['喫茶', 'カフェ'],
  ['珈琲', 'カフェ'],
  ['スイーツ', 'スイーツ'],
  ['弁当', 'テイクアウト専門店']
];

function findGenreFromStoreName(storeName) {
  const nameText = String(storeName || '').normalize('NFKC');
  if (!nameText) return '';
  const hit = NAME_GENRE_PRIORITY_LIST.find(pair => nameText.includes(pair[0]));
  return hit ? hit[1] : '';
}


// 生ジャンル（食べログ/ホットペッパーの取得値）と店名から、最終的な統一ジャンルを
// 決定する。①店名に「居酒屋」があれば最優先で居酒屋、②生ジャンルを正規化マップで
// 変換、③それでも有効な統一ジャンルにならなければ店名から具体的なジャンルを拾う、
// という優先順位。通常検索モードでは従来どこにも正規化がかかっていなかったため、
// 生ジャンルがそのままCSVへ出力されていた点も合わせて修正。
function resolveFinalGenre(rawGenre, storeName) {
  const nameText = String(storeName || '').normalize('NFKC');
  if (nameText.includes('居酒屋')) return '居酒屋';

  // ★最優先ルール: 店名にカフェ関連キーワード（カフェ/coffee/珈琲/喫茶等）が
  // 含まれる場合も、食べログ/ホットペッパー側のジャンル抽出結果に関わらず必ず
  // 「カフェ」に確定させる。Google Mapsスクレイパー側で同種の抽出不良
  // （検索:カフェでヒットした店が無関係なジャンルに化ける不具合）を確認済みのため、
  // 食べログ/ホットペッパー側も店名優先で統一しておく。
  const cafeKeywords = ['カフェ', 'cafe', 'Cafe', 'CAFE', '喫茶', '珈琲', 'コーヒー', 'coffee', 'Coffee', 'COFFEE'];
  if (cafeKeywords.some(keyword => nameText.includes(keyword))) return 'カフェ';

  // ★最優先ルール: 店名にラーメン・蕎麦うどん・寿司・焼肉等の具体的なジャンル語が
  // 含まれる場合も、生ジャンルが既に「有効な別ジャンル」に見えていても店名を優先する。
  // 居酒屋・カフェと同様、店名の方が抽出結果より信頼できるため最優先で判定する
  // （Google Mapsスクレイパー側で確認した同種の不具合への対応と統一）。
  const nameGenrePriority = findGenreFromStoreName(nameText);
  if (nameGenrePriority) return nameGenrePriority;

  const mapped = mapToFinalGenre(String(rawGenre || '').normalize('NFKC').trim());
  return mapped;
}

// 現在の一覧URL（例: https://tabelog.com/chiba/C12234/rstLst/...）から
// 都道府県＋エリアコードだけを取り出し、対象カテゴリのURLを組み立てる。
function buildTabelogPopularGenreLinks(listUrl) {
  const m = String(listUrl || '').match(/^(https:\/\/tabelog\.com\/[a-z]+\/[A-Za-z]\d+)\//);
  if (!m) return [];
  const areaBase = m[1] + '/rstLst/';
  return TABELOG_POPULAR_GENRE_SLUGS.map(g => ({ name: g.name, url: `${areaBase}${g.slug}/` }));
}

// ジャンルリンク抽出（食べログ: 固定スラッグ生成 → DOM/fetchはフォールバックのみ）
// =====================================================================
async function extractGenreLinks(listUrl, siteType, tabId) {
  if (siteType === 'tabelog') {
    const staticLinks = buildTabelogPopularGenreLinks(listUrl);
    if (staticLinks.length > 0) return staticLinks;
  }

  if (tabId != null) {
    try {
      const liveLinks = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          genreLinksResolvers.delete(tabId);
          resolve([]);
        }, 5000);

        genreLinksResolvers.set(tabId, (links) => {
          clearTimeout(timer);
          resolve(links);
        });

        chrome.runtime.sendMessage({
          target: 'background',
          type: 'GET_GENRE_LINKS_FROM_CONTENT',
          tabId,
          siteType
        }).catch(() => {
          clearTimeout(timer);
          genreLinksResolvers.delete(tabId);
          resolve([]);
        });
      });

      if (liveLinks.length > 0) return liveLinks;
    } catch (e) {
      console.warn('[extractGenreLinks] ライブDOM問い合わせ失敗:', e);
    }
  }

  try {
    const res = await fetch(listUrl);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = [];

    if (siteType === 'tabelog') {
      // 一覧ページと同じエリア（都道府県＋エリアコード）配下のリンクのみ許可し、
      // 他地域のリンクが紛れ込むのを防ぐ
      const areaMatch = String(listUrl).match(/^(https:\/\/tabelog\.com\/[a-z]+\/[A-Za-z]\d+)\//);
      const areaPrefix = areaMatch ? areaMatch[1] + '/' : null;

      const genreContainer = doc.getElementById('js-leftnavi-genre-targets') || doc.getElementById('js-leftnavi-genre-scroll');
      if (genreContainer) {
        genreContainer.querySelectorAll('.list-balloon__btn-list a[href], .list-balloon__table a[href]').forEach(a => {
          const href = resolveUrl(a.getAttribute('href') || '', listUrl).split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (!href || !name) return;
          if (!/tabelog\.com/.test(href)) return;
          if (areaPrefix && !href.startsWith(areaPrefix)) return;
          if (links.some(l => l.url === href)) return;
          links.push({ name, url: href });
        });
      }
      if (links.length === 0) {
        doc.querySelectorAll('.list-balloon__btn-list a[href]').forEach(a => {
          const href = resolveUrl(a.getAttribute('href') || '', listUrl).split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (!href || !name) return;
          if (!/tabelog\.com/.test(href)) return;
          if (areaPrefix && !href.startsWith(areaPrefix)) return;
          if (links.some(l => l.url === href)) return;
          links.push({ name, url: href });
        });
      }
    } else if (siteType === 'hotpepper') {
      doc.querySelectorAll('.reselectionList li a[href]').forEach(a => {
        const href = resolveUrl(a.getAttribute('href') || '', listUrl).split('?')[0].split('#')[0];
        const name = a.textContent.trim().replace(/\s+/g, ' ');
        if (!href || !name) return;
        if (!/hotpepper\.jp/.test(href)) return;
        if (!/\/G\d+/.test(href)) return;
        if (links.some(l => l.url === href)) return;
        links.push({ name, url: href });
      });
    }

    return links;
  } catch (e) {
    console.error('[extractGenreLinks] fetchフォールバック失敗:', e);
    return [];
  }
}

// =====================================================================
// 人気ジャンル一括取得
// =====================================================================
// =====================================================================
// 対象エリア名の検出（DOM構造に依存しない最終防御ライン）
// 「◯◯市のお店」のような基本エリアページ（ジャンル無し）を取得し、
// そのエリア名（市区町村名など）をタイトル/見出しから検出する。
// 以降、各店舗の詳細ページから取得した「住所」に、この文字列が
// 実際に含まれているかどうかで正しいエリアの店舗かを判定する。
// これにより、食べログ側のおすすめウィジェット等がどんなDOM構造で
// 紛れ込んできても、住所そのもので機械的に弾けるようになる。
// =====================================================================
async function detectExpectedAreaName(listUrl) {
  try {
    const baseMatch = String(listUrl).match(/^(https:\/\/tabelog\.com\/[a-z]+\/[A-Za-z]\d+\/rstLst\/)/);
    const baseUrl = baseMatch ? baseMatch[1] : listUrl;
    const res = await fetch(baseUrl);
    if (!res.ok) return null;
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    let area = doc.querySelector('.list-condition__item--area')?.textContent?.trim() || '';

    if (!area) {
      const h1 = doc.querySelector('h1')?.textContent?.trim() || '';
      const m1 = h1.match(/(.+?(?:郡.+?[町村]|市.+?区|[市区町村]))/);
      if (m1) area = m1[1];
    }

    if (!area) {
      const titleText = doc.title || '';
      const m2 = titleText.match(/(.+?(?:郡.+?[町村]|市.+?区|[市区町村]))/);
      if (m2) area = m2[1];
    }

    // 都道府県名だけ、のような短すぎる/一般的すぎる値は使わない
    if (area && area.length >= 2 && !/^(北海道|東京都|大阪府|京都府|.{2,3}県)$/.test(area)) {
      return area;
    }
    return null;
  } catch (e) {
    console.warn('[detectExpectedAreaName] 失敗:', e);
    return null;
  }
}

async function runPopularGenreCrawl(tabId, listUrl, maxItemsPerGenre, speedConfig = {}, selectedGenres = null) {
  const siteType = getSiteType(listUrl);
  if (!siteType) {
    sendToBackground(tabId, 'ERROR', { message: '対応サイトではありません' });
    return;
  }

  let expectedAreaName = null;
  if (siteType === 'tabelog') {
    expectedAreaName = await detectExpectedAreaName(listUrl);
    if (expectedAreaName) {
      sendToBackground(tabId, 'INFO', { message: `📍 対象エリアを検出:「${expectedAreaName}」（住所にこの文字列を含まない店舗は自動的に除外します）` });
    } else {
      sendToBackground(tabId, 'INFO', { message: '⚠️ 対象エリア名を自動検出できませんでした（エリア一致チェックはスキップされます）' });
    }
  }

  const parentTaskKey = tabId + '_popular';
  activeTasks.set(parentTaskKey, {
    running: true,
    stoppedManually: false,
    results: [],
    metadata: { media: siteType, area: '', industry: '人気ジャンル一括' },
    stats: {
      successCount: 0,
      failedCount: 0,
      retryingCount: 0,
      blockCount: 0,
      timeoutCount: 0,
      noNameCount: 0,
      noAddressCount: 0,
      noPhoneCount: 0,
      htmlMismatchCount: 0,
      otherFailCount: 0,
      isThrottling: false,
      activeConcurrency: 0,
      activeDelay: 0
    }
  });

  // ジャンルをまたいだURL重複排除用
  const globalSeenUrls = new Set();

  try {
    sendToBackground(tabId, 'INFO', { message: 'ジャンルリンクを抽出中...' });
    let genreLinks = [];
    try {
      genreLinks = await extractGenreLinks(listUrl, siteType, tabId);
    } catch (e) {
      sendToBackground(tabId, 'ERROR', { message: `ジャンルリンク取得失敗: ${e.message}` });
      activeTasks.delete(parentTaskKey);
      return;
    }

    // 最終防御: 一覧ページと同じエリア（都道府県＋エリアコード）配下以外のジャンルリンクは除外する
    if (siteType === 'tabelog') {
      const areaMatch = String(listUrl).match(/^(https:\/\/tabelog\.com\/[a-z]+\/[A-Za-z]\d+)\//);
      const areaPrefix = areaMatch ? areaMatch[1] + '/' : null;
      if (areaPrefix) {
        const beforeCount = genreLinks.length;
        genreLinks = genreLinks.filter(g => g.url.startsWith(areaPrefix));
        const droppedCount = beforeCount - genreLinks.length;
        if (droppedCount > 0) {
          sendToBackground(tabId, 'INFO', { message: `⚠️ エリア外のジャンルリンクを${droppedCount}件除外しました` });
        }
      }
    }

    // 選択ジャンルでフィルタリング
    if (selectedGenres && selectedGenres.length > 0) {
      const selectedSet = new Set(selectedGenres);
      genreLinks = genreLinks.filter(g => selectedSet.has(g.name));
    }

    if (genreLinks.length === 0) {
      const reason = siteType === 'tabelog'
        ? 'ジャンルリンクが見つかりません。食べログの検索結果ページを開いた状態で実行してください。'
        : 'ジャンルリンクが見つかりません。ホットペッパーのエリアページを開いた状態で実行してください。';
      sendToBackground(tabId, 'ERROR', { message: reason });
      activeTasks.delete(parentTaskKey);
      return;
    }

    sendToBackground(tabId, 'INFO', {
      message: `${genreLinks.length}ジャンルを検出: ${genreLinks.map(g => g.name).join('、')}`
    });

    const allResults = [];

    for (let i = 0; i < genreLinks.length; i++) {
      const parentTask = activeTasks.get(parentTaskKey);
      if (!parentTask || !parentTask.running) {
        sendToBackground(tabId, 'INFO', { message: '停止リクエストにより中断しました' });
        break;
      }

      const { name, url } = genreLinks[i];
      sendToBackground(tabId, 'INFO', {
        message: `🏷️ [ジャンル ${i + 1}/${genreLinks.length}]「${name}」の取得を開始します`
      });

      const tempId = `${tabId}_pg_${i}`;
      const subController = new AbortController();
      activeTasks.set(tempId, {
        running: true,
        stoppedManually: false,
        tabId,
        listUrl: url,
        results: [],
        maxItems: maxItemsPerGenre,
        maxPages: speedConfig.maxPages || 20,
        metadata: { media: siteType, area: '', industry: name },
        forceGenre: mapToFinalGenre(name),
        expectedAreaName,
        abortController: subController,
        globalSeenUrls,
        tabelogConcurrency: speedConfig.tabelogConcurrency || 3,
        tabelogDelay: speedConfig.tabelogDelay || 1000,
        hotpepperConcurrency: speedConfig.hotpepperConcurrency || 6,
        hotpepperDelay: speedConfig.hotpepperDelay || 500,
        maxRetries: speedConfig.maxRetries ?? 1,
        fetchTimeout: speedConfig.fetchTimeout || 15,
        stats: {
          successCount: 0,
          failedCount: 0,
          retryingCount: 0,
          blockCount: 0,
          timeoutCount: 0,
          noNameCount: 0,
          noAddressCount: 0,
          noPhoneCount: 0,
          htmlMismatchCount: 0,
          otherFailCount: 0,
          isThrottling: false,
          activeConcurrency: 0,
          activeDelay: 0
        }
      });

      await runCrawlTask(tempId);

      const finishedTask = activeTasks.get(tempId);
      if (finishedTask?.results?.length) {
        // task.results はrunCrawlTask内ですでに最終統一ジャンルへ変換済みだが、念のため保険
        const taggedResults = finishedTask.results.map(r => ({
          ...r,
          // 「バー・お酒」配下でも、詳細ジャンルまたは店名から明示的に
          // スナックと判定できた店舗はスナックを維持する。それ以外を
          // 一括してスナック扱いせず、巡回カテゴリの「バー」を採用する。
          genre: isValidFinalGenre(r.genre) ? r.genre : mapToFinalGenre(name),
          source_genre: name
        }));
        allResults.push(...taggedResults);
      }
      if (finishedTask && parentTask) {
        parentTask.stats.successCount += finishedTask.stats.successCount || 0;
        parentTask.stats.failedCount += finishedTask.stats.failedCount || 0;
        parentTask.stats.blockCount += finishedTask.stats.blockCount || 0;
        parentTask.stats.timeoutCount += finishedTask.stats.timeoutCount || 0;
      }
      activeTasks.delete(tempId);

      sendToBackground(tabId, 'INFO', {
        message: `✅ [ジャンル ${i + 1}/${genreLinks.length}]「${name}」完了 → 累計 ${allResults.length} 件`
      });

      if (i < genreLinks.length - 1) {
        const pt = activeTasks.get(parentTaskKey);
        if (pt && pt.running) {
          // ブロック検知時は長く待機、通常は短縮
          const interGenreWait = pt.stats.isThrottling ? 5000 : 500;
          await sleep(interGenreWait);
        }
      }
    }

    const pt = activeTasks.get(parentTaskKey);
    const cleanResults = allResults.filter(Boolean);
    if (pt) {
      pt.results = cleanResults;
      pt.running = false;
    }

    const metaArea = cleanResults[0]?.address?.replace(/\s+/g, '').slice(0, 6) || '';
    const finalMetadata = { media: siteType, area: metaArea, industry: '人気ジャンル一括' };

    sendToBackground(tabId, 'DONE', {
      collected: cleanResults.length,
      results: cleanResults,
      metadata: finalMetadata,
      successCount: pt?.stats?.successCount || cleanResults.length,
      failedCount: pt?.stats?.failedCount || 0,
      blockCount: pt?.stats?.blockCount || 0,
      timeoutCount: pt?.stats?.timeoutCount || 0,
      noNameCount: 0,
      noAddressCount: 0,
      noPhoneCount: 0,
      htmlMismatchCount: 0,
      otherFailCount: 0,
      retryingCount: 0,
      isThrottling: false,
      activeConcurrency: 0,
      activeDelay: 0
    });

    // 各ジャンルは完了ごとに個別のCSVをすでにダウンロード済みのため、
    // ここで全ジャンル分をまとめて再ダウンロードすることはしない
    // （二重ダウンロード・大量ファイル分裂の原因だったため廃止）

    chrome.runtime.sendMessage({
      target: 'background',
      type: 'SHOW_NOTIFICATION',
      title: '人気ジャンル一括取得 完了',
      message: `計 ${allResults.length} 件取得しました`
    });

  } catch (err) {
    console.error('[runPopularGenreCrawl] エラー:', err);
    sendToBackground(tabId, 'ERROR', { message: `人気ジャンル一括取得エラー: ${err.message}` });
  } finally {
    // [FIX] 以前はここで activeTasks.delete(parentTaskKey) を呼んでおり、
    // 完了直後にタスク（＝取得済み445件などのresults配列）をメモリから
    // 即座に消していた。人気ジャンル一括取得は35ジャンルを順番に処理する
    // ため完了まで数分〜数十分かかることがあり、その間にポップアップが
    // 閉じられている（または一度閉じて開き直された）ケースでは、完了時に
    // 送信されるDONEメッセージをポップアップが受け取れない。その状態で
    // ポップアップがGET_RESULTSを送っても、この行でタスクごと削除されて
    // いたため results:[] が返り、CSVボタンがずっと無効のまま・押しても
    // ダウンロードできない不具合になっていた（通常の単一ジャンル取得の
    // runCrawlTask()では最初からタスクを削除しておらず、この不整合が原因）。
    // running=false にするだけに留め、resultsは保持しておくことで、後から
    // ポップアップを開き直してもGET_RESULTSで取得・ダウンロードできるようにする。
    const finishedParentTask = activeTasks.get(parentTaskKey);
    if (finishedParentTask) {
      finishedParentTask.running = false;
    }
  }
}

console.log('[offscreen.js] build: v3.0.0 (店舗の住所そのものでエリア一致を検証・不一致は破棄)');
chrome.runtime.sendMessage({ target: 'background', type: 'OFFSCREEN_READY' }).catch(() => { });
