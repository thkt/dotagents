---
name: code
description: 複数単位または TDD の実装計画を、編集範囲を限定した担当処理とゲートの単位で進める。構造化された編集と検証が明示された依頼に使用し、小さな直接修正には使用しない。
---

# Code

`codex-flow describe --workflow code`で現在のワークフロー契約を確認する。shell ゲートの証拠を選ぶときは、[shell ゲートの証拠](../../workflows/flow/references/shell-gate.md)を読む。

## 判断

- 実装単位を実行順に並べ、各単位の観測可能な完了状態を決める。
- 実装単位の境界、Red/Green または Direct、リポジトリで定義された証拠を決める。
- 開始前からある依頼範囲外の変更は、すべての単位の編集範囲から外す。

## リファレンス

- 受け入れテストまたはゲートを決めるときは、[テスト設計](references/testing.md)を読む。
- バージョンで変わり得る外部 API が実装に影響する場合は、[出典確認](references/source-verification.md)を読む。
- このパッケージの Skill を変更する場合は、[Skill 作成](references/skill-authoring.md)を読む。
- このパッケージのワークフローまたはフックを変更する場合は、[Workflow 作成](references/workflow-authoring.md)を読む。

## エスカレーション

契約外の設計不足は `think` に戻し、事実・証拠不足は `research` に戻す。機械的な実装・テスト失敗はローカルで修正する。

## 報告

終了状態、実行定義のハッシュ、ゲートの証拠、修正回数、停止理由を報告する。
