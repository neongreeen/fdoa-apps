# Progress Portfolio

投資の「選定 → 観察 → 判断 → 実行」を低い操作コストで回すための個人用判断ログ。

- 価格・保有・損益の正本：SBI証券
- 判断・実行日時・マスターの正本：非公開 `fdoa-app-data/progress.json`
- 銘柄検索：アプリに同梱した静的JSON（実行時APIなし）

## 銘柄リスト

- 日本株：[JPX 東証上場銘柄一覧](https://www.jpx.co.jp/markets/statistics-equities/misc/01.html)
- 米国株：[SEC Company Tickers and Exchanges](https://www.sec.gov/file/company-tickers-exchange)

`.github/workflows/update-progress-instruments.yml`が月1回リストを更新する。GitHub Actions画面から手動実行もできる。取得・検証に失敗したデータ源は既存JSONを維持し、正常に取得できたデータ源だけを更新する。

ローカルで更新する場合：

```bash
python -m pip install xlrd==2.0.2
python progress/scripts/update_instruments.py
```

検索にない銘柄は手動登録できる。JPXは東証上場銘柄が対象であり、SECも一覧の完全性を保証していないため、手動登録は恒久的な逃げ道として残す。

## スキーマ

v0.1.xは`schemaVersion: 2`。v0.1.0のexecutionに含まれていた価格・数量は読み込み時に除外し、実行有無と実行日時だけを保持する。
