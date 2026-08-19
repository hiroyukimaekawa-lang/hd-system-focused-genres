// service-worker-v3.js
// ============================================================
// v3.0 Service Worker エントリポイント
//
// 既存 background.js のロジックは一切変更しない。importScripts で
// 取り込み、その後 orchestrator.js (v3 新機能) を追加でロードする。
// これにより:
//   - 既存の updateData / setState / handleAutomaticDownload は完全保持
//   - v3 で追加された action だけ orchestrator.js が処理
//
// 既存 background.js の `chrome.runtime.onInstalled` は v1 のキー
// (scrapingState, scrapedData, maxItems, targetGenres) を初期化する。
// v3 側は別キー名前空間 (v3_*) を使うため衝突しない。
// ============================================================

self.addEventListener('error', event => {
  console.error('[service-worker error]', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error && event.error.stack ? event.error.stack : event.error
  });
});

self.addEventListener('unhandledrejection', event => {
  console.error('[service-worker unhandledrejection]', {
    reason: event.reason && event.reason.stack ? event.reason.stack : event.reason
  });
});

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  const originalAddOnMessageListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
  chrome.runtime.onMessage.addListener = listener => {
    originalAddOnMessageListener((message, sender, sendResponse) => {
      try {
        return listener(message, sender, sendResponse);
      } catch (error) {
        console.error('[service-worker onMessage error]', {
          message,
          sender,
          error: error && error.stack ? error.stack : error
        });
        try {
          sendResponse({ ok: false, error: String(error?.message || error) });
        } catch (_) {}
        return true;
      }
    });
  };
}

try {
  // 既存の取得・解析・CSV出力ロジック（変更禁止）をそのままロード
  importScripts('background.js');
} catch (e) {
  console.error('[v3 SW] background.js の読み込みに失敗:', e);
}

try {
  // v3 で追加された orchestrator（エリア×ジャンル繰り返し制御）
  importScripts('orchestrator.js');
} catch (e) {
  console.error('[v3 SW] orchestrator.js の読み込みに失敗:', e);
}
