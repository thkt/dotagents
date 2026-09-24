# Gitテスト補助処理と初期設定の重複を、既存helperへ整理する

## 目的と現在の根拠

テスト内に残る同じGit起動処理と、設定済みの値を再設定する準備を減らす。調査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。

[correction-capture.test.ts](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/correction-capture.test.ts#L106)の106行と152行には同期Gitラッパーがある。[既存support/target.ts](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/support/target.ts#L16)は終了確認・timeout・stderr診断付きの同期helperを提供する。また[correction.test.ts](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/correction.test.ts#L26)は、[trialの初期化](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/tests/support/correction.ts#L63)で設定済みのuser.email/nameを同じ値で再設定している。

## 範囲と受入条件

- [ ] correction-captureの同じ同期Git起動処理は既存helperを再利用し、呼出箇所のcwd・引数・操作順を明示する。
- [ ] trialが既に保証する同値のuser設定の再実行を除く。テストを単独実行しても初期化条件が満たされる。
- [ ] 正常終了の確認、必要な失敗診断、mode・symlink・tracked/untrackedの違い、commit前後の観測と媒体・元作業の保全を維持する。
- [ ] 同期helperと、プロセス制御や割込みを検証する非同期`command()`を同一視せず、共通化のためのオプションや新しい抽象層を追加しない。

runtime・Git公開処理・テストケースの削除・全Git呼出しの一括置換は対象外。小さい局所整理であり、速度改善や不具合修正を未測定のまま主張しない。

## 検証

correction-capture/correctionの影響ケースを既存の正常・異常入力で確認する。新しい失敗条件がなければテスト追加は不要。対象は`thkt/dotagents`。実装時は`bun install --frozen-lockfile --ignore-scripts`で準備し、影響する既存テストと提出前の`bun run check`、差分の独立評価を行う。PR公開時は同じheadの`checks`・`verify`を確認し、人がレビューとマージを判断する。画面変更はなく、媒体は不要（既存の`capture: null`を維持）。

## 関連と合意

完了済み[#115](https://github.com/thkt/dotagents/issues/115)・[#159](https://github.com/thkt/dotagents/issues/159)は保証に対して過剰な検証を整理した。本Issueは現行コードに残る同期Gitラッパー2箇所と同値の初期設定だけを対象にし、整理済みのケースや停止境界へ広げない。

根拠は本Issueと固定リンクに含め、今回の必須調査報告は追加しない。未commitのローカル下書きは実装開始の前提にせず、着手時に最新の採用版へ適用性を再確認する。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
