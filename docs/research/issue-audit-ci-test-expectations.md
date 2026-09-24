# CIテスト名に依存する検証分岐を、ケースの期待値へ置き換える

## 目的と現在の根拠

テスト名の表現変更で、必要な検証が無言でなくなる構造を解消する。調査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。

[ci.test.tsのcheckObservation](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/ci.test.ts#L252)は`scenario.name.startsWith('running at deadline')`で重複pending・未登録check等の照合を選び、269行ではテスト名の完全一致で観測回数1を照合する。ケース名と検証条件が離れて二重管理されている。

## 範囲と受入条件

- [ ] 該当ケースに期待する観測内容や回数を持たせるなど、表示名を解釈しない形で現在の追加assertを実行する。期待値を実装の結果から生成しない。
- [ ] ケース名だけを変更しても、重複pending、missing・running・unmetの保持、同名checkの失敗時に後続成功まで待たないことの検証が変わらない。
- [ ] 初回・待機中・終了時の対象確認、待機予算、失敗・取得不能・保存失敗・割込みの現在の検出条件を維持する。
- [ ] 名称による分岐とその分散した期待値を除き、新しい汎用シナリオエンジンや台帳を追加しない。

CIの実行コード、checks/verifyの構成、待機時間、成功条件、既存ケースの一括削除は対象外。

## 検証

既存のCIテストを使い、対象2ケースの表示名だけを変えた場合も同じ結果を確認する。追加assertの検出力が不明なら、該当観測を失う誤動作だけを一時コピーで確認する。名前変更専用の恒久テストは必須としない。対象は`thkt/dotagents`。実装時は`bun install --frozen-lockfile --ignore-scripts`で準備し、影響する既存テストと提出前の`bun run check`、差分の独立評価を行う。PR公開時は同じheadの`checks`・`verify`を確認し、人がレビューとマージを判断する。画面変更はなく、媒体は不要（既存の`capture: null`を維持）。

## 関連と合意

完了済み[#159](https://github.com/thkt/dotagents/issues/159)はdevelopmentとciの同一時点の入力照合を整理した。本Issueは現行ci.test.ts内の表示名と期待値の結合を扱い、観測時点の統合やCI仕様変更を追加しない。[#115](https://github.com/thkt/dotagents/issues/115)の実装依存を避ける方針を適用する。

根拠は本Issueと固定リンクに含め、今回の必須調査報告は追加しない。未commitのローカル下書きは実装開始の前提にせず、着手時に最新の採用版へ適用性を再確認する。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
