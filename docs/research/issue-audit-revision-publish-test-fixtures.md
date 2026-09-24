# revision・publishテストのシナリオ分岐を整理し、入力と期待結果を近づける

## 目的と現在の根拠

既存PR修正と公開のテストで、1ケースを理解・変更するために追う分岐を減らす。調査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。

[revisionのfixture](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/revision.test.ts#L98)は`mode: string`で障害を注入し、[停止時の期待値](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/revision.test.ts#L660)と[ケースの準備](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/revision.test.ts#L744)でも同じ名前の集合を管理する。[publishの応答fixture](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/publish.test.ts#L55)も実行ケース・エラー理由・公開回数の分岐へ同じmodeを繰り返す。ケース数の多さではなく、変更条件の分散が対象である。

## 範囲と受入条件

- [ ] 正常なrepo準備・外部応答・後片付けだけを必要な範囲で共有し、各ケースの変更注入、停止理由、期待する副作用を近くで読めるようにする。既存の[developmentの局所IO差し替え](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/development.test.ts#L248)を参考にする。
- [ ] 同じシナリオ名の集合を複数の分岐で管理する部分を減らす。別ファイルへの移動や新しい汎用DSLへの置換だけで完了としない。
- [ ] 対象・主体・権限・draft・本文・headの変化、公開結果不明、割込み、push/edit抑止、旧state・result・作業の保全を、現在と同じ観測時点で検証する。
- [ ] ケースを統合する場合は、失う検出条件と残る確認をPRで説明する。件数の削減を目的にせず、対象外の条件は正常に保つ。

runtime、CLI、公開手順、検査の観測時点、他のテスト全体の整理は対象外。新しいシナリオ言語・台帳・必須ゲートは作らない。

## 検証

変更前後で対象2ファイルを同条件で確認し、必要な停止理由・記録・副作用抑止が維持されることを確認する。検出力が不明な箇所だけ限定的な不具合注入を使う。対象は`thkt/dotagents`。実装時は`bun install --frozen-lockfile --ignore-scripts`で準備し、影響する既存テストと提出前の`bun run check`、差分の独立評価を行う。PR公開時は同じheadの`checks`・`verify`を確認し、人がレビューとマージを判断する。画面変更はなく、媒体は不要（既存の`capture: null`を維持）。

## 関連と合意

完了済み[#129](https://github.com/thkt/dotagents/issues/129)はdevelopmentのmode分岐整理、[#159](https://github.com/thkt/dotagents/issues/159)は廃止出力・プロンプト依存・不正設定等のテスト整理を扱った。本Issueは現行revision/publishに残る分散したfixture条件に限定し、その完了範囲を繰り返さない。[#115](https://github.com/thkt/dotagents/issues/115)の価値判断方針を維持する。

根拠は本Issueと固定リンクに含め、今回の必須調査報告は追加しない。未commitのローカル下書きは実装開始の前提にせず、着手時に最新の採用版へ適用性を再確認する。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
