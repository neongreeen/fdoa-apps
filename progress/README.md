# Progress Portfolio

投資の「選定 → 観察 → 判断 → 実行」を低い操作コストで回すための個人用判断ログ。

- 約定・保有・損益の正本：SBI証券
- 判断・実行日時・マスターの正本：非公開 `fdoa-app-data/progress.json`
- 銘柄検索：アプリに同梱した静的JSON（実行時APIなし）
- 参考株価：非公開 `fdoa-app-data/prices.json` を表示時だけ読み込む（`progress.json`・localStorageには保存しない）

## 参考株価

`fdoa-app-data`のGitHub Actionsが、銘柄マスターの有効な銘柄を基に`prices.json`を更新する。アプリは既存の`store.fetchFile`で読み込み、観察ボードと銘柄マスターに現在値・前日比を表示する。市場時刻は観察ボード右上へ日本株・米国株別に集約する。

- Yahoo Finance由来。日本株は約20分遅延。実際の市場時刻は日本株・米国株別に表示する
- 市場時間中は毎時10分・40分に取得し、日本株の引け値は15:55にも取得する
- 騰落率は取得単価比ではなく前営業日終値比
- 取得失敗時は価格表示だけを隠し、判断ログ等の操作は止めない
- 価格は参考情報であり、約定・保有・損益は引き続きSBI証券を正本とする
- アプリ内で価格を入力・編集・保存しない

## SBI画面からの一時反映

Safariの「SBI→PP」ブックマークをSBIポートフォリオ画面で実行すると、表示中の株式について銘柄コード・現在値・前日比・前日比率だけをProgress Portfolioへ送る。

- 受信元はHTTPSのSBI証券ドメインだけを許可する
- SBIのログイン情報、口座番号、数量、取得単価、損益は取得しない
- 受信値はメモリー上だけでYahoo参考株価より優先し、GitHub・localStorageへ保存しない
- 再読み込みするとSBI値は消え、Yahoo参考株価へ戻る
- SBI画面が変わって読み取れない場合は、保存や推測をせずエラーを表示する

## 銘柄リスト

- 日本株：[JPX 東証上場銘柄一覧](https://www.jpx.co.jp/markets/statistics-equities/misc/01.html)
- 米国株：[SEC Company Tickers and Exchanges](https://www.sec.gov/file/company-tickers-exchange)
- 新規上場等の補完：`data/instruments-curated.json`

`.github/workflows/update-progress-instruments.yml`が月1回リストを更新する。GitHub Actions画面から手動実行もできる。取得・検証に失敗したデータ源は既存JSONを維持し、正常に取得できたデータ源だけを更新する。

ローカルで更新する場合：

```bash
python -m pip install xlrd==2.0.2
python progress/scripts/update_instruments.py
```

検索にない銘柄は手動登録できる。JPXは東証上場銘柄が対象であり、SECも一覧の完全性を保証していないため、手動登録は恒久的な逃げ道として残す。

SEC一覧への反映待ちや取得制限で検索できない新規上場銘柄は、公式IRまたは取引所情報を確認して`instruments-curated.json`へ追加する。自動更新はこのファイルを上書きしない。

## スキーマ

v0.1.xは`schemaVersion: 2`。v0.1.0のexecutionに含まれていた価格・数量は読み込み時に除外し、実行有無と実行日時だけを保持する。
