# 翻訳ビューア

PO / POT の原文・取り込んだ訳文・変更後の訳文を比較して編集するローカルツールです。ファイルはブラウザー内で処理します。

公開サイト: https://hiroshisatoy.github.io/japanese-translation-editor/

## GitHub Pages

`main` へのプッシュで GitHub Actions が `npm ci` と `npm run build:pages` を実行し、`_site/` を GitHub Pages に公開します。リポジトリの **Settings → Pages → Source** は **GitHub Actions** を選択します。

`_site/` には画面、ビルド済みコンポーネント、見本の PO ファイルを配置します。相対パスを使用しているため、GitHub Pages のプロジェクト配下でも動作します。利用者が開いた PO ファイルや編集中の訳文をサーバーへ送信する処理はありません。

## 起動

`index.html` をブラウザーで開くか、`npm start` でローカルサーバーを起動します。見本は `test/sample.po` を読み込み、直接開いた場合は内蔵の見本を使います。

## UI の変更

`npm ci` のあと `npm run build` を実行します。`ui.jsx` は WordPress 公式の `@wordpress/components` 44.0.0 を使用しています。ビルド済みの `dist/wp-ui.js` と `dist/wp-ui.css` を配布物に含めてください。実行時に CDN 接続は不要です。

検索・状態選択・ボタン・ヘルプダイアログを React が管理し、PO の解析、編集、書き出し、仮想一覧は既存の `app.js` と `po-parser.js` が処理します。

## 動作確認

`npm start` で起動して `npm test` を実行します。初回は `npx playwright install chromium` が必要です。ブラウザーの実行ファイルを指定する場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` を設定してください。
