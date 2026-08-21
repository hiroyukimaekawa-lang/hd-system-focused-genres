import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const mapRoot = 'extensions/hd-maps-6genres';
const focusedGenres = ['カフェ', 'スイーツ', '居酒屋', 'スナック', 'バー', '焼き鳥'];

function createOrchestratorHooks() {
  const source = read(`${mapRoot}/orchestrator.js`);
  const helperEnd = source.indexOf('// ---- タブ管理');
  assert.ok(helperEnd > 0, 'orchestrator helper boundary');
  const files = {
    'config/areas.json': JSON.parse(read(`${mapRoot}/config/areas.json`)),
    'config/genres.json': JSON.parse(read(`${mapRoot}/config/genres.json`))
  };
  const context = {
    URL,
    fetch: async path => ({ json: async () => files[path] }),
    chrome: { runtime: { getURL: path => path } }
  };
  vm.runInNewContext(`${source.slice(0, helperEnd)}
    this.hooks = { parseAreaInput, getAreasForCity, getGenres, buildTargetAreasForRun, buildGoogleMapsSearchQuery };
  `, context);
  return context.hooks;
}

function createChromeMock() {
  const event = () => ({ addListener() {}, removeListener() {} });
  return {
    runtime: {
      lastError: null,
      getURL: path => path,
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      getContexts: async () => []
    },
    storage: { local: { get() {}, set() {} }, onChanged: event() },
    tabs: { onUpdated: event(), onRemoved: event() },
    alarms: { onAlarm: event() },
    action: { onClicked: event() },
    downloads: { onChanged: event() }
  };
}

test('Test 1: config/genres.json contains exactly six target genres', () => {
  const config = JSON.parse(read(`${mapRoot}/config/genres.json`));
  assert.deepEqual(config.genres, focusedGenres);
  assert.equal(config.version, '5.0');
});

test('Test 2: beauty salons are absent from the Google Maps genre master', () => {
  const configText = read(`${mapRoot}/config/genres.json`);
  assert.doesNotMatch(configText, /美容院|美容室|ヘアサロン/);
});

test('Test 3: popup renders 6 / 6 genres returned from config without a duplicate genre array', async () => {
  const popup = read(`${mapRoot}/popup-v3.js`);
  const html = read(`${mapRoot}/popup-v3.html`);
  assert.match(html, /id="v3-genres-container"/);
  assert.match(popup, /v3_getGenres/);
  assert.match(popup, /renderGenres\(gRes\.genres\)/);
  assert.match(popup, /`\$\{sel\} \/ \$\{tot\} ジャンル 選択中`/);
  assert.doesNotMatch(popup, /MAP_TARGET_GENRES|focusedGenres/);

  const elements = new Map();
  const makeElement = () => {
    const element = {
      children: [], classList: { toggle() {} }, style: {}, dataset: {}, value: '', checked: false,
      disabled: false, textContent: '', addEventListener() {}, appendChild(child) { this.children.push(child); },
      querySelectorAll(selector) {
        const found = [];
        const visit = node => {
          if (selector === 'input[type="checkbox"]' && node.type === 'checkbox') found.push(node);
          (node.children || []).forEach(visit);
        };
        this.children.forEach(visit);
        return found;
      }
    };
    Object.defineProperty(element, 'innerHTML', {
      get() { return ''; },
      set() { element.children = []; }
    });
    return element;
  };
  let ready;
  const document = {
    body: { dataset: {} },
    addEventListener(name, callback) { if (name === 'DOMContentLoaded') ready = callback; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    querySelector() { return null; },
    createElement: makeElement
  };
  const config = JSON.parse(read(`${mapRoot}/config/genres.json`));
  const context = {
    document,
    console,
    Event: class Event { constructor(type) { this.type = type; } },
    Blob,
    URL,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          if (message.action === 'v3_getGenres') callback({ ok: true, genres: config.genres });
          else if (message.action === 'v3_getStatus') callback({ ok: true, status: {} });
          else callback({ ok: true });
        },
        onMessage: { addListener() {} }
      },
      storage: { local: { get(_keys, callback) { callback({}); }, set(_obj, callback) { callback?.(); } } }
    }
  };
  vm.runInNewContext(popup, context);
  ready();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(elements.get('v3-genres-container').querySelectorAll('input[type="checkbox"]').length, 6);
  assert.equal(elements.get('v3-genres-summary').textContent, '6 / 6 ジャンル 選択中');
});

test('Test 4: 長野県茅野市 resolves successfully', async () => {
  const hooks = createOrchestratorHooks();
  assert.deepEqual(Array.from(await hooks.getAreasForCity('長野県茅野市')), ['茅野市']);
});

test('Test 5: non-designated cities remain valid whole-city targets', async () => {
  const hooks = createOrchestratorHooks();
  for (const input of ['長野県茅野市', '千葉県東金市', '千葉県茂原市', '茨城県取手市']) {
    const areas = Array.from(await hooks.getAreasForCity(input));
    assert.equal(areas.length, 1, input);
    assert.match(areas[0], /市$/, input);
  }
});

test('Test 6: さいたま市 returns its ward list', async () => {
  const hooks = createOrchestratorHooks();
  const areas = Array.from(await hooks.getAreasForCity('さいたま市'));
  assert.ok(areas.length >= 10);
  assert.ok(areas.includes('大宮区'));
  assert.ok(areas.includes('浦和区'));
});

test('Test 7: v3_getGenres source returns the six config genres', async () => {
  const hooks = createOrchestratorHooks();
  assert.deepEqual(Array.from(await hooks.getGenres()), focusedGenres);
  const orchestrator = read(`${mapRoot}/orchestrator.js`);
  assert.match(orchestrator, /req\.action === 'v3_getGenres'/);
  assert.match(orchestrator, /sendResponse\(\{ ok: true, genres \}\)/);
});

test('Test 8: v3_getAreas cannot return an empty list for 茅野市', async () => {
  const hooks = createOrchestratorHooks();
  const areas = Array.from(await hooks.getAreasForCity('長野県茅野市'));
  assert.notEqual(areas.length, 0);
  assert.match(read(`${mapRoot}/orchestrator.js`), /req\.action === 'v3_getAreas'/);
});

test('Test 9/10: service worker loads background and orchestrator without global redeclaration', () => {
  const errors = [];
  const context = vm.createContext({
    chrome: createChromeMock(),
    self: { addEventListener() {} },
    console: { log() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Blob,
    TextEncoder,
    fetch: async () => ({ json: async () => ({}) })
  });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(read(`${mapRoot}/${file}`), context, { filename: file });
  };
  vm.runInContext(read(`${mapRoot}/service-worker-v3.js`), context, { filename: 'service-worker-v3.js' });
  assert.deepEqual(errors, []);
});

test('Test 11: start request and ordinary-city target construction remain available', async () => {
  const hooks = createOrchestratorHooks();
  const targets = Array.from(await hooks.buildTargetAreasForRun('長野県茅野市', ['茅野市'], 'split'));
  assert.equal(targets.length, 1);
  assert.equal(targets[0].city, '茅野市');
  assert.match(read(`${mapRoot}/orchestrator.js`), /req\.action === 'v3_start'/);
});

test('Test 12: cafe search URL query can be generated', () => {
  const hooks = createOrchestratorHooks();
  const area = hooks.parseAreaInput('長野県茅野市');
  assert.equal(hooks.buildGoogleMapsSearchQuery(area, 'カフェ'), '長野県 茅野市 カフェ');
});

test('Test 13: task generation source is config-driven and cannot add other genres', () => {
  const orchestrator = read(`${mapRoot}/orchestrator.js`);
  const popup = read(`${mapRoot}/popup-v3.js`);
  assert.match(orchestrator, /const useGenres = genres && genres\.length \? genres : await getGenres\(\)/);
  assert.match(popup, /let genres = getSelectedGenres\(\)/);
  assert.doesNotMatch(orchestrator, /MAP_TARGET_GENRES|MAP_TARGET_GENRE_SET/);
  assert.doesNotMatch(popup, /MAP_TARGET_GENRES|MAP_TARGET_GENRE_SET/);
});

test('Test 14: CSV output logic remains available', () => {
  const background = read(`${mapRoot}/background.js`);
  assert.match(background, /function buildCsvContent\(data\)/);
  assert.match(background, /async function downloadGroupedCsvFiles\(data, fallback = \{\}\)/);
  assert.match(background, /chrome\.downloads\.download/);
  for (const header of ['店名', 'ジャンル', '住所', '電話番号', 'URL', '媒体']) {
    assert.ok(background.includes(`'${header}'`), header);
  }
});

test('focused manifest uses only the original content script', () => {
  const manifest = JSON.parse(read(`${mapRoot}/manifest.json`));
  assert.equal(manifest.name, '【限定版】HD Maps 6ジャンル');
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
  assert.equal(manifest.background.service_worker, 'service-worker-v3.js');
});

test('Tabelog focused extension remains unchanged and valid', () => {
  const manifest = JSON.parse(read('extensions/hd-tabelog-6genres/manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['https://tabelog.com/*']);
});
