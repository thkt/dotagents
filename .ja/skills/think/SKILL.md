---
name: think
description: 実装方法を比較し、変更依頼1件を、出典に基づいて別担当がレビューしたPlan、または具体的な追加調査へ整理する。明示的な設計・計画依頼に使用し、実装やissue公開には使用しない。
---

# Think

`codex-think describe`で現在の入力形式と設計判断の契約を確認する。

## 判断

- 存在する場合は [.codex/OUTCOME.md](../../.codex/OUTCOME.md) を読み、安定した規則は [workflow contracts](../../workflows/README.md) の該当箇所をパスと正確な引用付きで `Plan.rules` に記載する。
- 変更を 1 つに絞り、完了時に観測できる状態を定める。
- バグ、機能追加、ドキュメント変更、保守作業のいずれかに分類する。
- 設計判断に直接関係する計画用の調査レポートだけを含める。
- 完了状態と Plan の文言を決めるときは、[設計判断の文章](references/decision-writing.md)を読む。

## 境界

- 設計を変え得る未確定事項は、仮定して計画にせず、追加調査へ戻す。
- Context は正本 artifact から自動供給されるが、repository または選択した evidence で再検証し、Context 自体を根拠にしない。

## 報告

Plan を作成できるか、追加調査が必要か、決定と理由、JSON と Markdown の成果物パス、実装単位数、次の状態を報告する。次の状態へは進まない。
