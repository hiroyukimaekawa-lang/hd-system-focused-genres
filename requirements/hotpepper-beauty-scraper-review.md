# ホットペッパービューティー拡張機能 レビュー結果・修正要件

## 結論

現在のホットペッパービューティー拡張機能は、HDシステムへ格納して問題ありません。

ただし、本番運用前に以下の修正を行ってください。

---

## 1. CSV 19列互換は維持する

以下の19列は変更しないでください。

```text
店名 / ジャンル / 取得元ジャンル / 都道府県 / 市区町村 / 住所 / 電話番号
定休日 / 営業日 / 営業開始A / 営業終了A / 営業開始B / 営業終了B
営業時間原文 / URL / HP有無 / 媒体 / 取得元URL / 取得日時
```

列名・列順・BOM付きCSV出力は維持してください。

**ステータス**: ✅ 対応済み

---

## 2. ジャンルを「ヘアサロン」に統一する

```javascript
genre: 'ヘアサロン',
sourceGenre: detail.sourceGenre,  // パンくずから取得した媒体上のカテゴリ名
```

**ステータス**: ✅ 対応済み（`offscreen.js` の `fetchAndParseDetail` で実装）

---

## 3. 営業日を定休日から生成する

`getBusinessDaysFromHoliday(holiday)` を実装。

| 定休日       | 営業日                 |
|:-----------|:---------------------|
| なし / '-' / 無休 | 月・火・水・木・金・土・日  |
| 不定休       | （空欄）               |
| 月・火       | 水・木・金・土・日        |
| その他（不明） | 月・火・水・木・金・土・日  |

**ステータス**: ✅ 対応済み（`offscreen.js` の `processDetailLinks` で統合）

---

## 4. 営業時間パースを改善する

`parseBusinessHours(hoursText)` を強化。

対応形式:
- `10:00~20:00` / `9:00-19:00`
- `10時～20時` / `10時30分～19時`
- `平日10:00～20:00` / `土日祝9:00～19:00`
- `月～金 10:00～20:00`
- `最終受付19:00`（単独時刻: openTimeAのみ、closeTimeAは空）

変換失敗時はコンソールに警告ログを出力。

**ステータス**: ✅ 対応済み

---

## 5. HP有無判定を改善する

3状態管理 (`有` / `無` / `未判定`):

- テーブルにHP/公式サイト行が見つかればそのURLで判定
- ページ内の外部リンクから除外ドメインをフィルタリング後に判定
- いずれも見つからない場合は `無`
- CSV出力時: `未判定` → `''`（空欄）に変換

除外ドメイン一覧:
```
beauty.hotpepper.jp, hotpepper.jp, instagram.com, twitter.com, x.com,
facebook.com, line.me, lin.ee, ameblo.jp, youtube.com, tiktok.com,
tabelog.com, gnavi.co.jp, retty.me, gorp.jp, yelp.com, tripadvisor.com
```

**ステータス**: ✅ 対応済み

---

## 6. STOP時の保存・ダウンロードを改善する

```text
STOP押下
↓
state.stopRequested = true / state.running = false
↓
offscreenにSTOP_CRAWLメッセージ送信（現在チャンクを完了させる）
↓
chrome.storage.localにバックアップ保存
↓
最大15秒のタイムアウトタイマー起動
↓
offscreenからCHUNK_PARSED_DONE受信 → finalizeCrawl()
↓
CSVを1回だけ自動ダウンロード（state.downloaded フラグで二重防止）
```

**ステータス**: ✅ 対応済み

---

## 7. chrome.storage.local への定期保存を追加する

- 10件ごとに保存（`DETAIL_PARSED_PROGRESS` ハンドラ内）
- ページ完了ごとに保存（`CHUNK_PARSED_DONE` ハンドラ内）
- STOP時に保存
- DONE時に保存

**ステータス**: ✅ 対応済み

---

## 8. HDシステムへ格納する際の整理

配置先: `hd-system-focused-genres/extensions/hd-hpb-beauty/`

格納ファイル:
```text
manifest.json
src/background.js
src/offscreen.js
src/offscreen.html
src/content.js
src/popup.html
src/popup.js
icons/
```

除外ファイル:
```text
.git/ / __MACOSX/ / .DS_Store / node_modules/ / .env
CSV/XLSX実データ / APIキー
```

元のフォルダ `extensions/hairsalon-scrapesystem/` は削除済み。

**ステータス**: ✅ 対応済み

---

## 9. HDツールポータルへ登録する

`docs/data/features.json` に `hotpepper-beauty-scraper` エントリを追加済み。

**ステータス**: ✅ 対応済み

---

## 完了条件チェックリスト

| # | 条件 | ステータス |
|---|------|----------|
| 1 | CSV 19列が維持されている | ✅ |
| 2 | ジャンルが `ヘアサロン` に統一されている | ✅ |
| 3 | 取得元ジャンルに媒体上のカテゴリが残っている | ✅ |
| 4 | 営業日が定休日から生成されている | ✅ |
| 5 | 定休日が正しく出力されている | ✅ |
| 6 | 営業時間原文が残っている | ✅ |
| 7 | 営業開始A/営業終了Aが可能な範囲で変換されている | ✅ |
| 8 | HP有無でSNSや媒体リンクを公式HPとして誤判定しない | ✅ |
| 9 | 電話番号が取得できている | ✅ |
| 10 | 媒体が `ホットペッパービューティー` になっている | ✅ |
| 11 | STOP時にCSVが1回だけダウンロードされる | ✅ |
| 12 | 長時間取得でもデータが消えにくい | ✅ |
| 13 | `.git` と `__MACOSX` を除外してhd-systemに格納されている | ✅ |
