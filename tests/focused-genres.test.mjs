import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const focusedGenres = ['カフェ', 'スイーツ', '居酒屋', 'スナック', 'バー', '焼き鳥'];
const csvHeaders = [
  '店名', 'ジャンル', '取得元ジャンル', '都道府県', '市区町村', '住所', '電話番号',
  '定休日', '営業日', '営業開始A', '営業終了A', '営業開始B', '営業終了B',
  '営業時間原文', 'URL', 'HP有無', '媒体', '取得元URL', '取得日時'
];

test('Google Maps genre master contains exactly the focused six genres', () => {
  const config = JSON.parse(read('extensions/hd-maps-6genres/config/genres.json'));
  assert.deepEqual(config.genres, focusedGenres);
  assert.equal(config.version, '5.0');
});

test('Google Maps popup uses focused genre selection UI', () => {
  const manifest = JSON.parse(read('extensions/hd-maps-6genres/manifest.json'));
  const popupHtml = read('extensions/hd-maps-6genres/popup-v3.html');
  const popupJs = read('extensions/hd-maps-6genres/popup-v3.js');
  assert.equal(manifest.version, '5.3.1');
  assert.equal(manifest.name, '【限定版】HD Maps 6ジャンル');
  assert.equal(manifest.action.default_title, '【限定版】HD Maps 6ジャンル');
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js', 'integrity-guard.js']);
  assert.match(popupHtml, /id="v3-genres-container"/);
  assert.match(popupHtml, /id="v3-fetch-areas"/);
  assert.match(popupHtml, />区を取得</);
  assert.doesNotMatch(popupHtml, /id="v3-area-group-select"/);
  assert.doesNotMatch(popupHtml, /id="v3-keyword-input"/);
  assert.match(popupJs, /targetAreas\.flatMap\(targetArea => selectedGenres\.map/);
});

test('Google Maps integrity guard blocks stale detail fields', () => {
  const guard = read('extensions/hd-maps-6genres/integrity-guard.js');
  assert.match(guard, /waitForPanelFieldsReady = strictWaitForPanelFieldsReady/);
  assert.match(guard, /phone_reused_by_different_place/);
  assert.match(guard, /phone_mismatch/);
  assert.match(guard, /address_mismatch/);
  assert.match(guard, /extractGooglePlaceIdentity/);
  assert.match(guard, /return expectedUrlNormalized \? urlMatches : nameMatches/);
  assert.match(guard, /NON_PLACE_TITLES/);
});

test('Tabelog crawl is limited to five source categories producing six final genres', () => {
  const manifest = JSON.parse(read('extensions/hd-tabelog-6genres/manifest.json'));
  const popup = read('extensions/hd-tabelog-6genres/src/popup.js');
  const offscreen = read('extensions/hd-tabelog-6genres/src/offscreen.js');
  assert.equal(manifest.version, '4.2.0');
  assert.match(popup, /const HD_POPULAR_GENRES = \['カフェ', 'スイーツ', '居酒屋', 'バー・お酒', '焼き鳥'\]/);
  assert.match(offscreen, /const FINAL_GENRE_LIST = \['カフェ', 'スイーツ', '居酒屋', 'スナック', 'バー', '焼き鳥'\]/);
  assert.match(offscreen, /genre: isValidFinalGenre\(r\.genre\) \? r\.genre : mapToFinalGenre\(name\)/);
  assert.doesNotMatch(offscreen, /'バー・お酒': 'スナック'/);
});

test('all extension manifests are valid Manifest V3 JSON', () => {
  for (const path of [
    'extensions/hd-maps-6genres/manifest.json',
    'extensions/hd-tabelog-6genres/manifest.json'
  ]) {
    const manifest = JSON.parse(read(path));
    assert.equal(manifest.manifest_version, 3, path);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/, path);
  }
});

test('Tabelog extension does not claim Hot Pepper Gourmet', () => {
  const manifest = JSON.parse(read('extensions/hd-tabelog-6genres/manifest.json'));
  assert.deepEqual(manifest.host_permissions, ['https://tabelog.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://tabelog.com/*']);
});

test('CSV headers remain compatible across both focused scrapers', () => {
  for (const path of [
    'extensions/hd-maps-6genres/background.js',
    'extensions/hd-tabelog-6genres/src/background.js'
  ]) {
    const source = read(path);
    for (const header of csvHeaders) assert.ok(source.includes(`'${header}'`), `${path}: ${header}`);
  }
});

test('Test A: completion watcher double-checks an already completed combo', () => {
  const source = read('extensions/hd-maps-6genres/orchestrator.js');
  assert.match(source, /chrome\.storage\.onChanged\.addListener\(handler\);\s*v3Get\(\['scrapingState', 'scrapedData', 'scrapingComboId', 'lastActivityAt'\]\)/);
  assert.match(source, /\['done', 'stopped_by_user', 'error'\]\.includes\(current\.scrapingState\)/);
});

test('Test B: completion watcher handles active to done storage events', () => {
  const source = read('extensions/hd-maps-6genres/orchestrator.js');
  assert.match(source, /changes\.scrapingState\.newValue === 'active'/);
  assert.match(source, /\['done', 'stopped_by_user', 'error'\]\.includes\(changes\.scrapingState\.newValue\)/);
});

test('Test C: startScraping handshake rejects already-running responses', () => {
  const source = read('extensions/hd-maps-6genres/orchestrator.js');
  assert.match(source, /response\?\.success !== true/);
  assert.match(source, /reason === 'already running'/);
  assert.match(source, /action: 'stopScraping'/);
});

test('Test D/E: popup notification connection errors are safely consumed', () => {
  for (const path of [
    'extensions/hd-maps-6genres/orchestrator.js',
    'extensions/hd-maps-6genres/background.js'
  ]) {
    const source = read(path);
    assert.match(source, /async function safeRuntimeSendMessage/);
    assert.match(source, /Receiving end does not exist/);
    assert.match(source, /Could not establish connection/);
  }
  const orchestrator = read('extensions/hd-maps-6genres/orchestrator.js');
  assert.match(orchestrator, /await safeRuntimeSendMessage\(\{ action: 'v3_progress' \}\)/);
  assert.match(orchestrator, /await safeRuntimeSendMessage\(\{ action: 'v3_done' \}\)/);
});

test('Test F: content scraping always leaves active state through finally', () => {
  const source = read('extensions/hd-maps-6genres/content.js');
  assert.match(source, /async function startScraping[\s\S]*?try \{[\s\S]*?finally \{\s*isScrapingActive = false;\s*await reportState\(finalState, fatalError\)/);
  assert.match(source, /finalState = stopRequested \? 'stopped_by_user' : 'error'/);
});

test('Test G: combo completion advances the next area and genre', () => {
  const source = read('extensions/hd-maps-6genres/orchestrator.js');
  assert.match(source, /comboResult = await runCombo/);
  assert.match(source, /areaIdx\+\+;\s*await v3Set\(\{ \[V3K\.areaIdx\]: areaIdx \}\)/);
  assert.match(source, /genreIdx\+\+;\s*areaIdx = 0/);
});

test('Test H: all combos finish in v3 done state', () => {
  const source = read('extensions/hd-maps-6genres/orchestrator.js');
  assert.match(source, /await v3Set\(\{ \[V3K\.state\]: 'done' \}\);\s*await v3Log\(`🎉 全エリア × 全ジャンル 取得完了`\)/);
});

test('completion watcher is registered before startScraping and uses comboId heartbeat', () => {
  const source = read('extensions/hd-maps-6genres/orchestrator.js');
  const watcher = source.indexOf('const comboDonePromise = waitForComboDone');
  const start = source.indexOf("action: 'startScraping'", watcher);
  assert.ok(watcher > 0 && start > watcher);
  assert.match(source, /scrapingComboId: comboId/);
  assert.match(source, /lastActivityAt: Date\.now\(\)/);
});

test('Google Maps detail title is read from the address-containing panel, not the Results h1', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = read('extensions/hd-maps-6genres/content.js');
  const helperEnd = source.indexOf('// DOM要素が現れるまで待つ');
  assert.ok(helperEnd > 0);

  const placeTitle = { textContent: 'テスト喫茶店' };
  const detailContainer = {
    parentElement: null,
    querySelectorAll(selector) {
      return selector === 'h1' || selector === 'h1.DUwDvf' ? [placeTitle] : [];
    }
  };
  const addressButton = { parentElement: detailContainer };
  const document = {
    querySelector(selector) {
      if (selector === '[role="main"] h1') return { textContent: '結果' };
      if (selector === 'button[data-item-id="address"]') return addressButton;
      return null;
    }
  };
  const context = { document, setTimeout, clearTimeout, Promise, Date, Error };
  runInNewContext(`${source.slice(0, helperEnd)}\nthis.hooks = { getDetailPanelTitle, isUsablePlaceTitle, extractGooglePlaceIdentity };`, context);

  assert.equal(context.hooks.getDetailPanelTitle(), 'テスト喫茶店');
  assert.equal(context.hooks.isUsablePlaceTitle('結果'), false);
  assert.equal(context.hooks.isUsablePlaceTitle('検索結果'), false);
  assert.equal(context.hooks.isUsablePlaceTitle('Results'), false);
  assert.equal(
    context.hooks.extractGooglePlaceIdentity('https://www.google.com/maps/place/x/data=!4m2!3m1!1s0x60188abc:0xDEADBEEF'),
    '0x60188abc:0xdeadbeef'
  );
  assert.equal(
    context.hooks.extractGooglePlaceIdentity('https://www.google.com/maps/place/x/data=!3m1!5s0x111:0x222!4m3!1s0x60188abc:0xDEADBEEF!8m2'),
    '0x60188abc:0xdeadbeef'
  );
});

test('detail queue has a hard timeout and advances in finally on every outcome', () => {
  const source = read('extensions/hd-maps-6genres/content.js');
  assert.match(source, /const DETAIL_ITEM_HARD_TIMEOUT_MS = 8000/);
  assert.match(source, /await runItemWithHardTimeout\(itemRun, async \(\) =>/);
  assert.match(source, /finally \{\s*itemRun\.cancelled = true;\s*processedUrls\.add\(url\);\s*queuedOrProcessingUrls\.delete\(url\);\s*completeQueueItem\(url, '処理完了'\)/);
  assert.match(source, /`\[\$\{queueProcessed\}\/\$\{queueTotal\}\]/);
  assert.match(source, /queueProcessed=\$\{queueProcessed\} \/ queueTotal=\$\{queueTotal\}/);
  assert.match(source, /while \(!stopRequested && queueProcessed < queueTotal\)/);
  assert.match(source, /if \(precollectedIndex < precollectedItems\.length\) continue/);
  assert.doesNotMatch(source, /while \(cardQueue\.length && !stopRequested && totalProcessed < effectiveMaxItems\)/);
});
