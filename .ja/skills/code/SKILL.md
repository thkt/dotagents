---
name: code
description: 直接的な repository 変更1件を、任意の scope と test command で実装する。commit、push、pull request 作成を行わない明示的な coding request に使用する。
---

# Code

`codex-code describe`で現在の input を確認し、最初の hook-bound command 自体を network escalation で呼ぶ。Code は scope 内の repository file を任意に編集できるため、`codex-code run` prefix の永続的な許可は要求しない。controller は Build と共通の implementation executor に request を compile する。

1 人の actor が依頼全体を実装・自己レビューし、共通の test gate で検証する。検証で失敗した場合だけ実装へ戻す。

## 判断

- 具体的な変更 request を 1 件示す。
- repository 内の許可範囲を狭める必要がある場合だけ`scope_paths`を指定する。
- 自動推定が適切でない場合だけ repository test command を指定する。
- 開始前からある無関係な変更は request scope の外に保つ。

## リファレンス

- 受け入れテストまたはゲートを決めるときは、[テスト設計](references/testing.md)を読む。
- バージョンで変わり得る外部 API が実装に影響する場合は、[出典確認](references/source-verification.md)を読む。
- このパッケージの Skill を変更する場合は、[Skill 作成](references/skill-authoring.md)を読む。
- このパッケージのワークフローまたはフックを変更する場合は、[Workflow 作成](references/workflow-authoring.md)を読む。

## エスカレーション

契約外の設計不足は `think` に戻し、事実・証拠不足は `research` に戻す。機械的な実装・テスト失敗はローカルで修正する。

## 報告

workflow contract は英語のままにする。終了状態、変更 path、test result、修正回数、停止理由を含む、ユーザー向けの最終報告だけを設定言語へ翻訳する。Code は commit、push、pull request 作成を行わない。
