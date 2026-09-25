---
globs: ["scripts/implement/orchestrator.ts", "scripts/implement/research-handoff.ts", "scripts/implement/correction.ts", "scripts/implement/issue.ts"]
scenes: ["plan", "implement"]
---

# 実装開始の条件

## 内容

このページはdotagentsの開始条件を説明する、手で更新する文書です。今回の要求と許可はIssueと合意記録、実行制御は信頼するホストが担います。必要な根拠は[報告参照の手順](../../scripts/README.md#調査報告を指定した実装開始)でpath・Git blob・開始commitを渡します。参照の一致は意味の正しさ、合意、公開許可を保証しません。文書のないrepoにwikiの作成を要求するものではありません。

新しいIssueの初回実装では、元checkoutの無関係な作業を保全し、起動時のHEADを開始commitに固定して隔離worktreeへ実装します。元checkoutは既存作業の場所、隔離worktreeは新しい成果物の場所です。開始時の未確認差分と、実装後の成果物差分を区別します。

## 開始時に照合する条件

- `.dotagents.json`と選択した必要報告が開始commitに通常ファイルとして存在し、確認済みの内容・版と一致することを確認します。本文だけでなくGit index（ステージ領域）やモードの未コミット差分も停止条件です。
- 準備中のHEAD変更、必要入力の欠落・不一致、既存の保存先や同名branchとの衝突では開始しません。無関係な未コミット差分・未追跡ファイルは元checkoutへ残せます。開始のために一括commit・stash・削除はしません。
- 元checkoutでのsetup後と、隔離worktreeでのsetup後にも、必要入力とHEADを再照合します。setup成功だけでモデルを起動しません。
- ホストは対象repo、実効ユーザー、権限、公開先と設定した検証・必要媒体を照合します。AIは根拠の内容・適用条件・矛盾を調べ、要求・権限の変更は人の合意へ戻します。

[既存PRの修正](../../scripts/README.md#既存prの修正)では、前回の検証済み公開headと同じcheckout、追跡・未追跡差分のない状態、採用した修正依頼、新しい保存先を確認します。新規実装の隔離条件を流用せず、前回の開始commitと報告参照を維持します。報告を実装中に改訂した場合は、固定した開始版との差分として評価します。

## 過去の観測と未検証事項

[当時の検証定義](https://github.com/thkt/dotagents/blob/765adbb29c51747b2d4ada473ca03a3e40ed7651/scripts/tests/development.test.ts)には、設定や必要報告のindexを変更した後、本文だけを元に戻しても停止する条件がありました。本文一致だけで開始可能とする説明ではこの条件を表せません。これは模擬コマンドと一時Git repoによる確認例であり、新しい実障害の報告ではありません。

[Issue #90の検証記録](../research/shared-knowledge-90.md)は当時の選択・生成機構の検証です。現在の操作や今回の実行結果として流用しません。準備や手戻りを減らす効果、実モデルの意味判断の品質、時間・費用の改善は未検証です。今回の機構廃止から効果を推定しません。反する観測があれば、影響する開始判断と出典を既存のfindings・assessmentsへ示し、事実不足は調査、条件・要求・権限の変更は人の判断へ戻します。

## 参照コード

- [development.ts](../../scripts/implement/orchestrator.ts) の `selectStart`・`verifyStartInputs`・`prepare`・`implement`：開始入力、setup前後、隔離先、実装直前の照合。
- [research-handoff.ts](../../scripts/implement/research-handoff.ts) の `verifyReportBase`・`verifyReports`・`researchContext`：報告の版照合と権限の区別。
- [revision.ts](../../scripts/implement/revision.ts) の `previousRun`、[correction.ts](../../scripts/implement/correction.ts) の `execute`：現行形式の保存記録と実行中の同一性を照合。
- [development.test.ts](../../scripts/tests/development.test.ts)：必要入力・無関係な作業・setup後の変化の制御テスト。実モデルの効果測定ではありません。

## 由来

- [DR-0004](../decisions/0004-use-current-document-inputs-only.md)：現行形式だけを受け付ける判断。
- [DR-0003](../decisions/0003-retire-shared-knowledge-selection.md)：共有モデル選択を終え、説明をwikiへ集約した経緯。

## 根拠

- [Issue #265](https://github.com/thkt/dotagents/issues/265)：2026-09-24T17:36:37Z版の合意。今回の開始commitは`104082c8b586681f8142a2097730df654ec743a0`です。
- [Issue #85](https://github.com/thkt/dotagents/issues/85)・[PR #89の採用commit](https://github.com/thkt/dotagents/commit/7c869f80bd95ea01b47e1ffd35f89e2899657bf2)：初回実装の開始条件の由来。過去の整理は#90の引用と採用コードに基づき、当時のPR本文・CIの再検証ではありません。
- [開始時点の旧原本](https://github.com/thkt/dotagents/blob/104082c8b586681f8142a2097730df654ec743a0/docs/knowledge/implementation-start.json)・[DR-0001](../decisions/0001-separate-requirements-from-evidence.md)：旧モデルの範囲・合意・仮説・観測と採用理由を辿るための履歴です。現在の開始条件は上記コードと今回の合意へ照合します。
