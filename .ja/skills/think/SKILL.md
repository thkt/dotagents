---
name: think
description: 実装方法を比較し、変更依頼1件を、出典に基づいて別担当がレビューしたPlan、または具体的な追加調査へ整理する。明示的な設計・計画依頼に使用し、実装やissue公開には使用しない。
---

# Think

`codex-think describe`で現在の入力形式と設計判断の契約を確認する。
最初の束縛された workflow command 自体を network escalation で呼び、その同じ tool call で対応していれば prefix `["codex-think", "run"]` の永続的な許可を要求する。一時的な`model_unavailable`が発生した場合は、intent を保持して同じ command を network escalation で正確に再実行する。

## 判断

- 存在する場合は[.codex/OUTCOME.md](../../.codex/OUTCOME.md)と関連する[workflow contracts](../../workflows/README.md)を読み、scope の判断に使う。実装上の制約は repository guidance を Plan に複製せず、対象 unit の contract と planned tests に記載する。
- 変更を 1 つに絞り、完了時に観測できる状態を定める。
- Plan を直接決める Research report を明示的に選ぶ。関連する Knowledge は背景情報として自動追加される。
- 完了状態と Plan の文言を決めるときは、[設計判断の文章](references/decision-writing.md)を読む。

## 境界

- 設計を変え得る未確定事項は、仮定して計画にせず、追加調査へ戻す。
- repository snapshot と明示的に選択した Research を事実の基礎にする。関連する Knowledge は背景情報として扱い、evidence、hash、repository rule を Plan に複製しない。

## 報告

Plan と workflow artifact は英語のままにする。`ready`と成果物パス、または`research_required`と具体的な問いを含む、ユーザー向けの最終報告だけを設定言語へ翻訳する。次の状態は`issue`または`research`とし、そこへは進まない。
