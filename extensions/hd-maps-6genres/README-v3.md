# Google Maps Scraper v3.0 アップグレード概要

## 追加機能（既存ロジックは一切変更していません）

| # | 機能 | 実装ファイル |
|---|------|---|
| ① | エリア選択モード（市区町村→区チェックボックス） | `popup-v3.html`, `popup-v3.js`, `config/areas.json`, `orchestrator.js` |
| ② | 全ジャンル自動取得（設定ファイル管理） | `config/genres.json`, `orchestrator.js` |
| ③ | リアルタイム進捗管理（区/ジャンル/件数/時間/ETA/URL） | `popup-v3.html`, `popup-v3.js`, `orchestrator.js` |
| ④ | バックグラウンド完全実行（Offscreen Document + Alarms） | `service-worker-v3.js`, `orchestrator.js`, `offscreen.html`, `offscreen.js` |
| ⑤ | 実行状態復元（chrome.storage 永続化） | `orchestrator.js`, `popup-v3.js` |
| ⑥ | リアルタイム蓄積プレビュー（最新20件） | `popup-v3.js` |

## ファイル構成

```
legacy-extension/
├── manifest.json           ← popup と service_worker の差し替え、permission追加のみ
├── background.js           ← ★ 既存・無変更
├── content.js              ← ★ 既存・無変更
├── popup.html / popup.js / popup.css ← ★ 既存・無変更（参考用に残置）
├── service-worker-v3.js    ← 新規（既存 background.js を importScripts で取り込み）
├── orchestrator.js         ← 新規（エリア×ジャンル繰り返し、進捗管理、状態復元）
├── popup-v3.html / .js / .css ← 新規（新UI、進捗・ログ・プレビュー）
├── offscreen.html / .js    ← 新規（Service Worker キープアライブ）
└── config/
    ├── areas.json          ← 新規（市区町村→区マッピング、22都市）
    └── genres.json         ← 新規（23ジャンル初期値）
```

## 既存ロジック保持の根拠

- `content.js` のスクレイピング処理（`startScraping`, `scrapeDetailPanel`, `parseOpeningHours` 等）はそのまま使用。
- `background.js` の `updateData` ハンドラ、`buildCsvContent`, `handleAutomaticDownload` 等もそのまま動作。
- v3 は `chrome.storage` の `v3_*` 名前空間と新 message action (`v3_start`, `v3_stop`, `v3_getAreas`, …) のみ使用。
- 取得開始時に既存の `scrapedData` を空にし、既存 content.js を起動 → 完了後に `sourceGenre` と `area` を付与して `v3_collectedData` に蓄積。
- 出力（CSV/XLSX）は v3 専用ロジックで実装（取得元ジャンル列を追加するため）。既存 `buildCsvContent` には触れていない。

## 出力項目（要件通り）

| 店名 | ジャンル | 取得元ジャンル | 住所 | 電話番号 | 定休日 | 営業日 | 営業開始 | 営業終了 | URL | 媒体 |
|---|---|---|---|---|---|---|---|---|---|---|

媒体 = `GoogleMap` 固定。重複排除は要件通り実装していません。

## バックグラウンド継続の仕組み

1. `chrome.alarms.create('v3_tick', { periodInMinutes: 0.5 })` で 30秒毎にSWを起動。
2. `chrome.offscreen.createDocument({ reasons:['BLOBS'] })` で Offscreen Document を生成し、20秒間隔で SW に `v3_ping` を送り続けることで SW のアイドルタイマーをリセット。
3. 作業タブは `chrome.tabs.create({ active: false })` で非アクティブのまま開く。ユーザーが別タブを見ていてもページの DOM 更新は継続するため content.js のスクロール処理が止まらない。
4. SW がそれでも再起動された場合: `chrome.runtime.onStartup` および storage の `v3_state === 'running'` を見て `v3Drive()` を自動再開。

## 動作シナリオ（要件の成功条件）

1. ユーザーが「さいたま市」と入力 → 「区を取得」クリック
2. 10区（西区〜岩槻区）がチェックボックス表示
3. 例: 「大宮区」「浦和区」のみチェック → ▶ 自動取得開始
4. 大宮区 × 23ジャンル を順次取得 → 浦和区 × 23ジャンル
5. 別タブに移動・Chrome 最小化 でも継続
6. ⬇ CSV/XLSX ダウンロードで `取得元ジャンル` 列付きで保存
