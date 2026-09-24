---
globs: ["scripts/research-handoff.ts", "scripts/development.ts", "scripts/correction.ts", "scripts/review.ts"]
scenes: ["plan", "implement", "pr-create"]
---

# 判断に使う根拠を同じ版で引き継ぐ

## 内容

今回の要求と許可はIssueと合意記録から確認し、文書は判断の根拠として使います。選んだ根拠のパス・Git blob・開始commitを初回実装、修正、独立評価へ渡し、途中で新しい版へ置き換えません。参照の一致だけでは、内容の正しさや今回への適用、人の合意を確認したことにはなりません。

## 定型手順

1. 今回の判断に関係する文書だけを選び、出典の版、適用条件、合意・観測・提案の区別を確認します。操作は[CLIの引き継ぎ手順](../../scripts/README.md#調査報告を指定した実装開始)に従います。
2. 確認した内容と開始commitの参照を照合します。必要なファイルの欠落、版違い、未確認の変更は解消してから開始します。
3. 実装中の改訂は、固定した開始版との差分として評価します。根拠の不足や矛盾が判断を変える場合は、影響する判断と必要な調査・合意を示します。
4. 独立評価で判断を妨げる不足が残った場合は、必須の未解決指摘として扱います。参照した文書の役割・理由・版は既存の評価記録とPR説明から辿れるようにします。

## 参照コード

- `scripts/research-handoff.ts` の `verifyReportBase`・`verifyReports`：開始版、通常ファイル、確認済み内容を照合します。
- `scripts/research-handoff.ts` の `researchContext`：出典、適用性、合意の区別と、根拠が変わった場合の戻り先を各工程へ渡します。
- `scripts/correction.ts` の `reviewTarget`・`documentVersions`：選択した根拠と、評価で参照した文書の対象版を記録します。
- `scripts/review.ts` の `reviewInstructions`・`parseReview`：意味の独立評価を指示し、必須の未解決指摘が残る受入を拒否します。意味の正しさ自体は形式検査の保証外です。

## 由来

- [DR-0003](../decisions/0003-retire-shared-knowledge-selection.md)：共有モデル選択を終了し、要求と根拠の分離・報告参照による版付き引き継ぎを維持します。

## 根拠

- [#73](https://github.com/thkt/dotagents/issues/73)：同じ根拠を実装、修正、独立評価、PR説明へ引き継ぐ範囲を整理しました。
- [#90](https://github.com/thkt/dotagents/issues/90)・[PR #92](https://github.com/thkt/dotagents/pull/92)：当時、選択した共有知識を版照合と評価記録へ接続しました。今回の廃止理由と旧記録の扱いは[DR-0003](../decisions/0003-retire-shared-knowledge-selection.md)に記録します。
- 今回の変更の確認基点は `104082c8b586681f8142a2097730df654ec743a0` です。時間・手戻りの改善は[当時の検証記録](../research/shared-knowledge-90.md)で未計測とされています。
