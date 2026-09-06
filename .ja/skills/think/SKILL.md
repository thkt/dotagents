---
name: think
description: 実装方法を比較し、変更依頼1件を、出典に基づいて別担当がレビューしたPlan、または具体的な追加調査へ整理する。明示的な設計・計画依頼に使用し、実装やissue公開には使用しない。
---

# Think

この段階で確定する内容は、共通の[契約の粒度](../../workflows/README.md)に従う。

`codex-think describe`で現在の入力形式と設計判断の契約を確認する。
最初の束縛された workflow command 自体を network escalation で呼び、その同じ tool call で対応していれば prefix `["codex-think", "run"]` の永続的な許可を要求する。一時的な`model_unavailable`が発生した場合は、intent を保持して同じ command を network escalation で正確に再実行する。

## 判断

- [.codex/OUTCOME.md](../../.codex/OUTCOME.md)と関連する[workflow contracts](../../workflows/README.md)を読み、scope の判断に使う。OUTCOME.md が存在しない場合は、Think を実行する前にプロジェクトの outcome と検証可能な完了条件を記載して作成するようユーザーへ依頼する。必要な動作と根拠のある制約を対象 unit の contract と acceptance tests に記載し、repository guidance は複製しない。
- 変更を 1 つに絞り、完了時に観測できる状態を定める。
- Plan を直接決める Research report を明示的に選ぶ。Knowledge 索引から関連する原典 report を最大 3 件、作成日時付きの手掛かりとして追加する。
- 完了状態と Plan の文言を決めるときは、[設計判断の文章](references/decision-writing.md)を読む。

## 境界

- 要件を変え得る未確定の事実は Research に戻す。範囲内の実装上の選択は担当に委ね、未指定だけを理由に Plan を不完全としない。
- repository snapshot と明示的に選択した Research を事実の基礎にする。Knowledge で選ばれた report の主張は現在の snapshot で確認する。作成日時だけで鮮度を判断せず、調査の evidence と repository rule を Plan に複製しない。

## 報告

Plan と workflow artifact は英語のままにする。`ready`と成果物パス、または`research_required`と具体的な問いを含む、ユーザー向けの最終報告だけを設定言語へ翻訳する。次の状態は`issue`または`research`とし、そこへは進まない。
