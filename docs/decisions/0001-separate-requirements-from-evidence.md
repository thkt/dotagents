---
status: "superseded by DR-0003"
date: "2026-09-17"
decision-makers: "Issue #90の要求を合意した依頼者"
---

# 要求と根拠を分け、同じ参照を既存の実装・評価経路へ渡す

## Context and Problem Statement

調査や共有知識を実装の根拠として使うとき、未合意の提案を要求へ混ぜたり、工程ごとに異なる版を使ったりすると、何を根拠に実装・評価したかを追えません。要求・許可はIssueと合意記録が持ち、根拠は版と適用条件を保って渡す必要があります。

これは[Issue #90](https://github.com/thkt/dotagents/issues/90)と[PR #92](https://github.com/thkt/dotagents/pull/92)の採用内容から残す判断記録です。今回新しく権限や要求を決めるものではありません。

## Decision Drivers

- 今回の合意と、再利用する知識・未確認の仮説を区別する。
- 初回実装、修正、独立評価が同じ開始版を参照する。
- 既存のIssue、Git照合、評価記録を使い、別の要求正本を増やさない。

## Considered Options

- 各工程で文書の内容を読み取り、必要な定義と根拠を組み直す。
- 選択した知識と版を既存のIssue・報告参照へ結び、ホストが同じ内容を渡す。

## Decision Outcome

Chosen option: "選択した知識と版を既存の参照へ結び、ホストが同じ内容を渡す"。固定定義の転記を機械へ移し、意味・適用・合意の判断はAIと人に残すためです。関係先の知識は自動で要求に追加せず、矛盾が出た場合は影響する判断と必要な調査・合意へ戻します。

### Consequences

- 同じ参照と開始版を実装・修正・評価から辿れます。
- 参照の抽出・形式・版照合を保守する必要があります。形式の成功は内容・合意・効果を保証しません。
- 手書き定義の重複は減りますが、読解、適用判断、作業時間や手戻りの削減は未計測です。

### Confirmation

`scripts/research-handoff.ts` の `researchContext`、`scripts/correction.ts` の評価対象記録、`scripts/knowledge.ts` の旧JSON参照を照合します。既存の `bun run check` と独立評価で、版違いの拒否、未選択の提案の非混入、出典と適用条件の保持を確認します。今回の移行後の確認結果は、そのPRに記録します。

## More Information

### Evidence and Scope

[採用commit](https://github.com/thkt/dotagents/commit/5eca806df08ba870bb2dd037957e56ca63711fcb)と[当時の検証記録](../research/shared-knowledge-90.md)を参照してください。記録内の模擬検証は実モデルの意味判断や時間改善の実測ではありません。`date`は採用commitの日付です。合意者の個人名は今回再確認していません。

現行への適用は、今回のIssueに選んだ根拠の引き継ぎです。JSONやMarkdownという格納形式そのものを全リポジトリへ固定する判断ではありません。

### Reassessment Triggers

- 根拠の改訂や反する観測で、Issueの判断・適用範囲を変える必要が生じた場合。
- 参照形式や工程の変更で、同じ版の引き継ぎを維持できなくなる場合。
