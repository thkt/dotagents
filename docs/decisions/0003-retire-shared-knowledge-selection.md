---
status: "superseded by DR-0004"
date: "2026-09-25"
decision-makers: "Issue #265の要求を合意した依頼者"
---

# 共有モデル選択を終了し、説明をwikiへ集約する

## Context and Problem Statement

[DR-0001](0001-separate-requirements-from-evidence.md)では、共有モデルをIssueで選び、JSON正本から人向け説明とAI入力を作る方式を採用しました。「要求・許可と根拠を分け、同じ版を実装・修正・独立評価へ渡す」という原則と、この選択・生成方式は分けて判断できます。[Issue #265](https://github.com/thkt/dotagents/issues/265)で利用者は共有知識機構とJSONの廃止、現行説明のwikiへの整理を選択しました。

## Decision Drivers

- 現在必要な開始条件を通常の文書として更新できるようにする。
- 要求・許可はIssue、根拠は版付きの報告参照、実行制御はホストという責任を維持する。
- 過去に選んだ根拠を黙って脱落させず、旧Issue・run・Git blobを保全する。

## Considered Options

- JSON・ID選択・生成説明と専用AI入力を維持する。
- JSONを残し、専用AI入力だけを終了する。
- 選択・生成を終了し、現行説明をwiki、根拠の引き継ぎを既存の報告参照へ集約する。

## Decision Outcome

Chosen option: "選択・生成を終了し、wikiと既存の報告参照へ集約する"。#265で合意した方向であり、JSONを残す案では説明の二重管理が残ります。DR-0001の方式を置き換えますが、要求と根拠を分けて同じ版を渡す原則は維持します。DR-0001の本文にある当時の理由・結果・確認基準は履歴として保存します。

### Consequences

- 新しいIssueはJSON・ID選択なしで開始できます。必要なMarkdownのpath・blob・開始commitの照合、意味・合意・権限の境界は維持します。
- wikiは手で更新し、コード・Issue・版付き原本との整合を既存の独立評価で確認します。生成物照合、モデルのID・関係・状態の形式検査、選択内容の専用抽出は終了します。
- 旧選択を含むIssueや保存済みrunは明示的に停止します。担当者が原本と合意を確認し、新しいIssue・報告参照・runへ移る条件を[CLI手順](https://github.com/thkt/dotagents/blob/dadea8f8f2dd5cfe58e25fb70a549b6acfdbdaab/scripts/README.md#旧共有知識からの移行)に示します。旧記録を変換・再開しません。
- 説明の更新責任は執筆・既存の独立評価・人の確認に残ります。生成機構の廃止が品質、時間、費用、手戻りを改善したとは判断しません。

### Confirmation

初回実装・修正・レビューの通常経路、旧ブロックの明示停止と保存状態の保全、報告参照の版照合を既存の制御テストで確認します。変更文書の出典・日本語・リンク、HTMLの表示・リンクと`bun run check`の実行結果は今回の検証・独立評価へ引き継ぎます。ここに未実行の結果は記載しません。

## More Information

### Evidence and Scope

合意の出典は#265の2026-09-24T17:36:37Z版の本文です。dateは今回の判断を記録した日で、マージ・公開の完了日ではありません。確認基点は`104082c8b586681f8142a2097730df654ec743a0`です。[旧原本](https://github.com/thkt/dotagents/blob/104082c8b586681f8142a2097730df654ec743a0/docs/knowledge/implementation-start.json)と[当時の検証記録](../research/shared-knowledge-90.md)を保存し、過去の観測を今回の効果へ読み替えません。過去報告にある削除済みファイルへの相対リンクは、その報告の当時の版で辿ります。

対象はdotagentsの共有機構と開始条件の説明です。全repoへのwiki作成義務、報告参照の廃止、過去Issue・run・検証結果の改変は含みません。

### Reassessment Triggers

- 既存の報告参照で必要な版・根拠・適用条件を引き継げない事実が見つかった場合。
- 旧Issue・runの移行で要求や公開範囲の追加判断が必要になった場合。
