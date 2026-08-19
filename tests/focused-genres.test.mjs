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
  const config = JSON.parse(read('extensions/google-maps-scraper/config/genres.json'));
  assert.deepEqual(config.genres, focusedGenres);
  assert.equal(config.version, '5.0');
});

test('Google Maps popup uses focused genre selection UI', () => {
  const manifest = JSON.parse(read('extensions/google-maps-scraper/manifest.json'));
  const popupHtml = read('extensions/google-maps-scraper/popup-v3.html');
  const popupJs = read('extensions/google-maps-scraper/popup-v3.js');
  assert.equal(manifest.version, '5.1.0');
  assert.match(popupHtml, /id="v3-genres-container"/);
  assert.doesNotMatch(popupHtml, /id="v3-keyword-input"/);
  assert.match(popupJs, /targetAreas\.flatMap\(targetArea => selectedGenres\.map/);
});

test('Tabelog crawl is limited to five source categories producing six final genres', () => {
  const popup = read('extensions/restaurant-data-scraper_v3.0.0/src/popup.js');
  const offscreen = read('extensions/restaurant-data-scraper_v3.0.0/src/offscreen.js');
  assert.match(popup, /const HD_POPULAR_GENRES = \['カフェ', 'スイーツ', '居酒屋', 'バー・お酒', '焼き鳥'\]/);
  assert.match(offscreen, /const FINAL_GENRE_LIST = \['カフェ', 'スイーツ', '居酒屋', 'スナック', 'バー', '焼き鳥'\]/);
  assert.match(offscreen, /genre: isValidFinalGenre\(r\.genre\) \? r\.genre : mapToFinalGenre\(name\)/);
  assert.doesNotMatch(offscreen, /'バー・お酒': 'スナック'/);
});

test('all extension manifests are valid Manifest V3 JSON', () => {
  for (const path of [
    'extensions/google-maps-scraper/manifest.json',
    'extensions/restaurant-data-scraper_v3.0.0/manifest.json',
    'extensions/hotpepper-beauty-scraper/manifest.json'
  ]) {
    const manifest = JSON.parse(read(path));
    assert.equal(manifest.manifest_version, 3, path);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/, path);
  }
});

test('Tabelog extension does not claim Hot Pepper Gourmet', () => {
  const manifest = JSON.parse(read('extensions/restaurant-data-scraper_v3.0.0/manifest.json'));
  assert.deepEqual(manifest.host_permissions, ['https://tabelog.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://tabelog.com/*']);
});

test('CSV headers remain compatible across all three scrapers', () => {
  for (const path of [
    'extensions/google-maps-scraper/background.js',
    'extensions/restaurant-data-scraper_v3.0.0/src/background.js',
    'extensions/hotpepper-beauty-scraper/src/background.js'
  ]) {
    const source = read(path);
    for (const header of csvHeaders) assert.ok(source.includes(`'${header}'`), `${path}: ${header}`);
  }
});

test('Hot Pepper Beauty emits only the beauty-salon genre', () => {
  const source = read('extensions/hotpepper-beauty-scraper/src/offscreen.js');
  assert.match(source, /genre: '美容院'/);
  assert.doesNotMatch(source, /genre: 'ヘアサロン'/);
});
