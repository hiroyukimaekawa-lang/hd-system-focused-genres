// integrity-guard.js
// Google Maps の詳細パネルは店名/URLが先に切り替わり、住所・電話番号・営業時間が
// 前店舗のまま数百ms〜数秒残ることがある。
// content.js の取得処理を後段からガードし、異なる店舗の詳細情報が混ざることを防ぐ。

(() => {
  if (
    typeof waitForPanelFieldsReady !== 'function' ||
    typeof scrapeDetailPanel !== 'function'
  ) {
    console.warn('[HD Maps] integrity guard: base functions not found');
    return;
  }

  const baseScrapeDetailPanel = scrapeDetailPanel;
  const phoneOwnerByNumber = new Map();
  const NON_PLACE_TITLES = new Set(['結果', '検索結果', 'results', 'search results']);

  function guardNormalizeText(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[（）()[\]【】「」『』"'`´｀・･\s\-‐‑–—_/\\]/g, '')
      .trim();
  }

  function guardNormalizeAddress(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/^日本、?/, '')
      .replace(/〒?\d{3}-?\d{4}/g, '')
      .replace(/\s+/g, '')
      .trim();
  }

  function guardNormalizePhone(value) {
    return String(value || '').normalize('NFKC').replace(/\D/g, '');
  }

  function guardSameName(a, b) {
    const aa = guardNormalizeText(a);
    const bb = guardNormalizeText(b);
    if (!aa || !bb) return false;
    return aa === bb || aa.includes(bb) || bb.includes(aa);
  }

  function guardPlaceNameFromUrl(url) {
    try {
      const match = String(url || '').match(/\/maps\/place\/([^/]+)/);
      return match ? decodeURIComponent(match[1]).replace(/\+/g, ' ').trim() : '';
    } catch (_) {
      return '';
    }
  }

  function extractGooglePlaceIdentity(url) {
    const text = String(url || '');
    const placeMatch = text.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    if (placeMatch) return placeMatch[1].toLowerCase();
    const matches = text.match(/0x[0-9a-f]+:0x[0-9a-f]+/ig);
    return matches?.length ? matches[matches.length - 1].toLowerCase() : '';
  }

  function guardNormalizePlaceUrl(url) {
    return extractGooglePlaceIdentity(url);
  }

  function isUsablePlaceTitle(value) {
    const title = String(value || '').normalize('NFKC').trim();
    return !!title && !NON_PLACE_TITLES.has(title.toLowerCase());
  }

  function findDetailContainer() {
    const anchors = [
      document.querySelector('button[data-item-id="address"]'),
      document.querySelector('button[data-item-id^="phone:tel:"]'),
      document.querySelector('button[data-item-id="oh"]')
    ].filter(Boolean);
    for (const anchor of anchors) {
      let node = anchor.parentElement;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        const title = Array.from(node.querySelectorAll('h1'))
          .map(el => el.textContent?.trim() || '')
          .find(isUsablePlaceTitle);
        if (title) return node;
      }
    }
    return null;
  }

  function readDetailTitle(container) {
    if (!container) return '';
    const selectors = ['h1.DUwDvf', 'h1', '[role="heading"][aria-level="1"]'];
    for (const selector of selectors) {
      const title = Array.from(container.querySelectorAll(selector))
        .map(el => el.textContent?.trim() || '')
        .find(isUsablePlaceTitle);
      if (title) return title;
    }
    return '';
  }

  function guardReadPanelSnapshot() {
    const detailContainer = findDetailContainer();
    const name = readDetailTitle(detailContainer);

    const addrBtn = detailContainer?.querySelector('button[data-item-id="address"]')
      || document.querySelector('button[data-item-id="address"]');
    const addressRaw = addrBtn
      ? (addrBtn.getAttribute('aria-label') || addrBtn.textContent || '')
      : '';
    const address = addressRaw.replace(/^住所[：:]\s*/, '').trim();

    const phoneBtn = detailContainer?.querySelector('button[data-item-id^="phone:tel:"]')
      || document.querySelector('button[data-item-id^="phone:tel:"]');
    const phoneRaw = phoneBtn
      ? ((phoneBtn.getAttribute('data-item-id') || '').replace(/^phone:tel:/, '') || phoneBtn.textContent || '')
      : '';
    const phone = guardNormalizePhone(phoneRaw);

    return {
      name,
      address,
      phone,
      url: window.location.href,
      placeIdentity: extractGooglePlaceIdentity(window.location.href),
      normalizedUrl: extractGooglePlaceIdentity(window.location.href)
    };
  }

  function guardIdentityMatches(snapshot, expectedName, expectedUrl) {
    const expectedUrlNormalized = extractGooglePlaceIdentity(expectedUrl);
    const expectedUrlName = guardPlaceNameFromUrl(expectedUrl);

    const urlMatches = !!(
      expectedUrlNormalized &&
      snapshot.normalizedUrl &&
      snapshot.normalizedUrl === expectedUrlNormalized
    );

    const expectedNames = [expectedName, expectedUrlName].filter(Boolean);
    const nameMatches = expectedNames.length === 0
      ? true
      : expectedNames.some(name => guardSameName(snapshot.name, name));

    // 固有identityが一致すれば、document側の「結果」見出しを理由に待機しない。
    return expectedUrlNormalized ? urlMatches : nameMatches;
  }

  function guardSnapshotSignature(snapshot) {
    return [
      guardNormalizeText(snapshot.name),
      guardNormalizeAddress(snapshot.address),
      snapshot.phone,
      snapshot.normalizedUrl
    ].join('|');
  }

  async function strictWaitForPanelFieldsReady(options = {}, timeoutMs = 5500) {
    const expectedName = options.expectedName || '';
    const expectedUrl = options.expectedUrl || '';
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 2000);

    let lastSignature = '';
    let stableSince = 0;
    let identitySince = 0;
    let lastSnapshot = null;

    while (Date.now() < deadline) {
      const snapshot = guardReadPanelSnapshot();
      lastSnapshot = snapshot;

      if (!guardIdentityMatches(snapshot, expectedName, expectedUrl)) {
        lastSignature = '';
        stableSince = 0;
        identitySince = 0;
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      if (!identitySince) identitySince = Date.now();

      const signature = guardSnapshotSignature(snapshot);
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      }

      const addressReady = !!guardNormalizeAddress(snapshot.address);
      const stableFor = Date.now() - stableSince;
      const identityFor = Date.now() - identitySince;
      const phoneReady = !!snapshot.phone;

      // 電話番号あり: 店名/URL/住所/電話が同一スナップショットで最低450ms安定してから取得。
      // 電話番号なし: 掲載なし判定を急がず、同一店舗の状態を最低1100ms確認する。
      if (
        addressReady &&
        ((phoneReady && stableFor >= 450 && identityFor >= 450) ||
         (!phoneReady && stableFor >= 900 && identityFor >= 1100))
      ) {
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const current = lastSnapshot || guardReadPanelSnapshot();
    const message = [
      'panel_identity_or_fields_timeout',
      `expectedName=${expectedName || '-'}`,
      `expectedUrl=${guardNormalizePlaceUrl(expectedUrl) || '-'}`,
      `currentName=${current.name || '-'}`,
      `currentUrl=${current.normalizedUrl || '-'}`,
      `currentPhone=${current.phone || '-'}`
    ].join(' | ');

    if (typeof reportV3Log === 'function') reportV3Log(`整合性ガード: ${message}`);
    throw new Error(message);
  }

  // content.js 側の待機関数を厳格版へ差し替える。
  // false を返して取得継続すると前店舗の電話番号が保存されるため、タイムアウト時は例外で中断する。
  waitForPanelFieldsReady = strictWaitForPanelFieldsReady;

  scrapeDetailPanel = async function guardedScrapeDetailPanel(placeUrl, cardName = '', searchGenre = '') {
    await strictWaitForPanelFieldsReady({ expectedName: cardName, expectedUrl: placeUrl }, 1800);

    const detail = await baseScrapeDetailPanel(placeUrl, cardName, searchGenre);
    const snapshot = guardReadPanelSnapshot();

    if (!guardIdentityMatches(snapshot, cardName || detail?.name || '', placeUrl)) {
      throw new Error(`panel_identity_changed_during_scrape: ${cardName || placeUrl}`);
    }

    if (detail?.name && !isUsablePlaceTitle(detail.name)) {
      throw new Error(`invalid_place_title: ${detail.name}`);
    }

    if (detail?.name && cardName && !guardSameName(detail.name, cardName)) {
      throw new Error(`name_mismatch: expected=${cardName} actual=${detail.name}`);
    }

    const detailAddress = guardNormalizeAddress(detail?.address);
    const liveAddress = guardNormalizeAddress(snapshot.address);
    if (detailAddress && liveAddress && detailAddress !== liveAddress) {
      throw new Error(`address_mismatch: ${detail?.name || cardName || placeUrl}`);
    }

    const detailPhone = guardNormalizePhone(detail?.phone);
    const livePhone = snapshot.phone;
    if (detailPhone && livePhone && detailPhone !== livePhone) {
      throw new Error(`phone_mismatch: ${detail?.name || cardName || placeUrl}`);
    }

    // 電話番号を最優先の識別子として、同じ電話番号が別URLへ再利用された場合は保存しない。
    // さらに住所まで同じなら、前店舗の詳細欄が残留している可能性が極めて高い。
    if (detailPhone) {
      const normalizedUrl = guardNormalizePlaceUrl(placeUrl);
      const owner = phoneOwnerByNumber.get(detailPhone);
      if (owner && owner.url !== normalizedUrl) {
        const sameAddress = !!(
          owner.address && detailAddress && owner.address === detailAddress
        );
        const differentName = !guardSameName(owner.name, detail?.name || cardName);

        if (sameAddress || differentName) {
          const message = `phone_reused_by_different_place: ${detailPhone} / ${owner.name} -> ${detail?.name || cardName}`;
          if (typeof reportV3Log === 'function') reportV3Log(`整合性ガード: ${message}`);
          throw new Error(message);
        }
      }

      phoneOwnerByNumber.set(detailPhone, {
        url: normalizedUrl,
        name: detail?.name || cardName || '',
        address: detailAddress
      });
    }

    return detail;
  };

  if (typeof reportV3Log === 'function') {
    reportV3Log('整合性ガード有効: 店名・URL・住所・電話番号の同期確認を強制します');
  }
})();
