# 同梱CSS

フロー図とガイドはBasecoat 1.0.2の標準スタイル（Vega）を共有します。静的HTMLをローカルでも読めるよう、配布済みCSSを改変せず同梱しています。ページを開く際の外部通信と追加のビルドは不要です。共通テーマは `../workflow-theme.css`、図のカードに固有の調整は `../workflow-cards.css`、ガイドの本文とレイアウトは `../workflow-guide.css`、図の配置は `../../workflow-map.html` で定義します。

- 配布元：[Basecoatの導入手順](https://basecoatui.com/installation/)
- CSS：[basecoat-css@1.0.2](https://cdn.jsdelivr.net/npm/basecoat-css@1.0.2/dist/basecoat.cdn.min.css)
- CSSのSHA-256：`8123677adb9bba43be3298e1543bcc5fc763e8cda3d32dc74c806046a3537ca0`
- Basecoat：MIT。著作権表示は `basecoat-LICENSE.txt` に保全しています。
- 配布CSSに含まれるTailwind CSS 4.3.1：MIT。著作権表示は `tailwindcss-LICENSE.txt` に保全しています。

更新時はバージョンを固定した配布物とライセンスを確認して置き換え、両HTMLの参照を揃えます。標準部品の見た目はBasecoatへ任せ、共有する変更はテーマ変数、図や記事に固有の変更は必要なCSSに限定します。JavaScriptの部品は追加していません。
