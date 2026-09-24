# lint・formatのテスト環境を必要な入力へ絞り、依存グラフ検査を維持する

## 目的と現在の根拠

検査設定のテストが必要としない全ソースのコピー・再検査を減らす。調査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。

[codebase-checks.test.tsのfixture](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/codebase-checks.test.ts#L9)は全`scripts`と設定をコピーする。[lint試験](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/codebase-checks.test.ts#L37)でも既存全ソースのlint、probe追加後の全typecheckとlintを行い、[format試験](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/codebase-checks.test.ts#L283)も同じfixtureを使う。一方、未使用・循環検査は実際の参照グラフが検証対象である。

## 範囲と受入条件

- [ ] lint・formatの試験環境を、実際のpackage script・設定、必要なプラグイン・依存、直下と入れ子の試験入力へ絞る。検査設定の複製版や別の模擬実行に置き換えない。
- [ ] lintは許容例を通し、違反例自体の型検査成功、指定ルール・対象ファイル・error件数・非ゼロ終了を維持する。無関係な型エラーや設定未適用を成功と扱わない。
- [ ] formatは直下・入れ子の未整形TSを拒否し、writeで修正し、対象外のMD/JSを変更しない。
- [ ] 未使用ファイル・export・型・依存、実行時循環、解析不完全・設定不正の検査は、実コードの参照グラフと実際の入口を含む現在の環境を維持する。

製品側のlint/format/未使用検査の範囲・規則・閾値、CIの条件は変更しない。汎用テスト基盤や新しい台帳は作らず、全テストの環境最小化へ広げない。

## 検証

変更前後で同じprobeが同じ理由で通過・失敗することを確認する。全グラフが必要な試験と局所設定の試験を区別し、失う検出条件がないことを独立評価する。時間を比較する場合は同条件の測定として記録し、未測定の改善値を主張しない。対象は`thkt/dotagents`。実装時は`bun install --frozen-lockfile --ignore-scripts`で準備し、影響する既存テストと提出前の`bun run check`、差分の独立評価を行う。PR公開時は同じheadの`checks`・`verify`を確認し、人がレビューとマージを判断する。画面変更はなく、媒体は不要（既存の`capture: null`を維持）。

## 関連と合意

完了済み[#174](https://github.com/thkt/dotagents/issues/174)はfallow導入と検出境界、[#178](https://github.com/thkt/dotagents/issues/178)は型変換・累積コピーlintを導入した。本Issueはそれらの試験環境の負担を減らし、採用済みの検出範囲を維持する。完了済み[#187](https://github.com/thkt/dotagents/issues/187)の日本語lintの規則・対象選択・テストは今回変更しない。

根拠は本Issueと固定リンクに含め、今回の必須調査報告は追加しない。未commitのローカル下書きは実装開始の前提にせず、着手時に最新の採用版へ適用性を再確認する。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
