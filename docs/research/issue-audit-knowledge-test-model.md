# knowledge単体テストを小さな合成モデルにし、実文書の更新から切り離す

## 目的と現在の根拠

共有知識の説明文や出典版を更新しただけで、汎用的な形式検査・選択・描画のテストも修正する結合を減らす。調査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。

[knowledge.test.ts](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/knowledge.test.ts#L22)は実際の`implementation-start.json`を単体テストにも使い、58–63行でモデル本文の文字列`config_index・report_index`、日本語の提案文、出典の過去commitを期待する。必要な選択・状態・関係の検証と、現在の文書内容への依存を分けられる。

## 範囲と受入条件

- [ ] parser・選択・renderの単体テストは、必要なrule・hypothesis・proposal、出典と関係を含む小さい合成モデルで、入力と期待値を読めるようにする。
- [ ] 重複・未知ID、欠落参照、不正状態、未検証効果の昇格拒否、選択順、未選択の定義を暗黙に追加しない条件を維持する。
- [ ] 実際のJSONからMarkdownを生成・照合する`knowledge:check`と、実装・修正・独立評価へ同じGit blobの選択内容を渡す結合確認を残す。文書の綴りだけへのassertは、必要な内容・版の受渡しを確認する期待値へ整理する。
- [ ] 実文書の意味を保った説明や出典版の更新が、汎用単体テストの期待値更新を要求しない。テスト専用fixtureの内容を実装の比較・変換関数から作らない。

共有知識schema・選択規則・ホストの開始条件・JSONと生成Markdownの役割は変更しない。汎用fixture DSLや別の知識台帳は作らない。結合確認をすべて合成データへ置き換えることは対象外。

## 検証

既存knowledgeテストと`knowledge:check`を使う。文書だけの変更と、選択・状態・版の誤りを識別できることを差分で確認し、必要な箇所だけ限定的に不具合を注入する。対象は`thkt/dotagents`。実装時は`bun install --frozen-lockfile --ignore-scripts`で準備し、影響する既存テストと提出前の`bun run check`、差分の独立評価を行う。PR公開時は同じheadの`checks`・`verify`を確認し、人がレビューとマージを判断する。画面変更はなく、媒体は不要（既存の`capture: null`を維持）。

## 関連と合意

完了済み[#115](https://github.com/thkt/dotagents/issues/115)・[#159](https://github.com/thkt/dotagents/issues/159)はプロンプトの綴り依存や過剰な結合テスト等を整理した。本Issueは現行knowledgeの実資料依存に限定する。共有モデルの機能や実資料の生成物照合を廃止するものではない。

根拠は本Issueと固定リンクに含め、今回の必須調査報告は追加しない。未commitのローカル下書きは実装開始の前提にせず、着手時に最新の採用版へ適用性を再確認する。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
