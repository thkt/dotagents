## 目的

実装・修正担当の指示にある重複表現とPR本文の重複読込みを減らし、時間制限コメントを現在の実装に合わせる。対象は `scripts/development.ts` と `scripts/correction.ts` の4件に絞る。

## 変更範囲と完了条件

- [ ] 初回実装プロンプトの検証責任・公開禁止に関する指示を簡潔にする。必要な実装・テスト・文書、既存検証の再利用、ホスト検証に備えるために必要な対象を絞ったチェック、合意範囲内の通常判断での作業継続を保つ。full checkはホストが実行し、担当側は実行しない。commit・push・公開・Issue変更・受入条件緩和と、担当sandboxでのブラウザ・サーバー起動の禁止を保つ。
- [ ] 修正担当では、同じ入力に含まれる `testInstructions` が既に許可する不要テストの削除・統合を重複して書かない。受入条件と必要な検証の保持、現実的な回帰を隠してcheckを通すことの禁止、commit・push・公開の禁止は明示する。共通テスト指示自体は維持する。
- [ ] `checkTimeMs` のコメントを、各ローカル検証コマンドとCI待機へ別々に上限を適用している説明にする。時間設定や計算方法は変更しない。
- [ ] 作成したPR本文を1回読み込み、その文字列で `Closes #<Issue番号>` と検証済みcommitの両方を検査する。検査・停止条件とcommit前後・モデル実行前後などの再照合は維持する。

新しい監査基盤、Jevの実行時組込み、MCP・router・外部パッケージ導入、指示の全面共通化、応答schema・上限・権限・公開手順の変更は対象外。関連する #99 の全面共通化はこのIssueで完了扱いにしない。

## 確認済みの文案

初回実装の対象2文群（調査版で501文字）をまとめた424文字の案:

```text
Complete the agreed implementation, needed tests and documentation, and targeted checks needed to prepare it for host verification without pausing for approval of routine choices within scope; reuse sufficient existing verification. Leave configured full verification to the host after implementation. Do not commit, push, publish, change the Issue, weaken acceptance criteria, or launch browsers or servers in your sandbox.
```

修正担当の対象文群（調査版で241文字）の160文字の案:

```text
Preserve agreed acceptance criteria and verification of required behavior; never hide realistic regressions to make checks pass. Do not commit, push or publish.
```

時間制限コメント案:

```text
Applied separately to each local verification command and the CI wait.
```

文字数の達成自体を完了条件にしない。上記の責任・禁止事項を明示して保つための小さな文言調整は範囲内。実装担当と評価担当は原文・周辺指示も読み、全文の意味を照合する。

## 根拠と未確認事項

調査対象: [f0b887c5280b7109d3ba48c7fa1104ec972e8e6d](https://github.com/thkt/dotagents/commit/f0b887c5280b7109d3ba48c7fa1104ec972e8e6d)。確認日: 2026-09-18 JST。

- [初回実装と時間設定](https://github.com/thkt/dotagents/blob/f0b887c5280b7109d3ba48c7fa1104ec972e8e6d/scripts/development.ts)、[修正担当とローカル検証](https://github.com/thkt/dotagents/blob/f0b887c5280b7109d3ba48c7fa1104ec972e8e6d/scripts/correction.ts)、[CI期限](https://github.com/thkt/dotagents/blob/f0b887c5280b7109d3ba48c7fa1104ec972e8e6d/scripts/ci.ts)。CIは呼出し時から新しい期限を作り、ローカル検証の経過時間を差し引いていない。
- 公開済みコード抜粋と短縮案を公式Jev APIへ渡した探索試験では、初回実装の初稿から弱まった対象チェックの目的・範囲を修正した。修正後の11条件と修正担当の9条件を個別に確認したが、全文の意味等価性や実担当の実行品質は保証しない。コメントの総合的な整合性判断ではコード読解との食い違いもあった。
- 実コメントの一括削除は行わない。独立した理由説明を残す。
- 根拠はこのIssueと版付きコード参照で引き継げるため、ローカルのJev試験スクリプト・生ログ・内部パスを必須入力やPR成果物にしない。

## 検証と公開

セットアップは `bun install --frozen-lockfile --ignore-scripts`、提出前は引数なしの `bun run check`。既存のdevelopment・correctionの検証を再利用し、実装をなぞるだけのテストを増やさない。既存検証が文字列の変更で失敗する場合は、守る責任・禁止事項を弱めず適切に更新する。

独立評価で原文と新しい指示の条件・範囲・権限、PR本文の両条件、維持する再照合、文書更新の要否を確認する。PRには実際の削減内容と検証の限界を説明し、同じPR headの `checks`・`verify` を確認する。プロダクト画面媒体は不要。内部の表現と読込みの整理であり、利用者向け操作が変わらなければ新しい説明文書は追加しない。

## 合意

2026-09-18、依頼者は上記4件の修正候補と未適用の提案差分を確認した後、「prにしてください」と指示した。この4件の実装・検証・独立評価・PR公開までを進める。人のレビューとマージは依頼者が判断する。
