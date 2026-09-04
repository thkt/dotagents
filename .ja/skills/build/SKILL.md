---
name: build
description: 公開 GitHub Issue の Plan 1件を実装・検証し、任意で branch を push して下書き PR を作成する。Issue 公開後の end-to-end Build に使用する。
---

# Build

準備済みの Build input を`codex-build run --input <task-input-json>`で実行する。controller は選択された公開 Plan からすべての実行 step を導出する。

## 入力

- 明示的な invocation では`#123`のような Issue shorthand を受け付け、現在の worktree の`origin` GitHub repository から選ぶ。hook が小さな Build input を準備する。実行 step を手書きしない。
- 最初の束縛された controller command 自体を network escalation で呼び、対応していれば同じ tool call で prefix `["codex-build", "run"]`の永続的な許可を要求する。Build 専用 command は task と repository に束縛された`$build` approval を引き続き必須とし、Build の run と cancel だけを公開するため、この prefix は永続的に許可できる。一時的な access failure が発生した場合だけ、同じ controller command を network escalation で正確に再実行する。準備のために別の`gh ... view`を実行せず、ブラウザの内容を contract の代わりにしない。
- Build 開始時に選択した Issue を 1 回だけ読み、一意な`## Plan` section 内の JSON Plan を唯一の実装 authority とする。周囲の表示用 markup、公開者の local receipt、別 rendering、body hash は要求しない。
- controller は Plan から actor goal、結合した file scope、test command を導出する。Build input を実装意図の別 source にしない。
- 1 人の actor が Plan 全体を実装・自己レビューし、test 後に 1 人の独立した read-only SDK reviewer が契約適合と品質を確認する。具体的な失敗があれば実装 actor に戻し、再検証する。

## 権限

- ユーザーが先頭で明示した invocation を、hook が束縛した repository における local branch、最終検証済み commit 1 件、Ship 有効時の push 1 回と下書き PR 作成 1 回の承認として扱う。`Ship`の確認を重ねて求めない。
- 同じ依頼で push または下書き PR 作成をユーザーが明示的に除外した場合を除き、`Ship`を含める。
- resume 時は、外部 action を繰り返す前に branch、commit、push、draft PR の postcondition を照合する。
- ユーザーが PR screenshots を明示的に求めた場合は、安全な画像名と alt text を準備済み Build input に追加する。完成した UI を render し、controller が指定した path に要求された画像を撮影する。controller が seal した画像 bytes と一致する場合だけ Ship し、画像の変更や未解決の添付があれば別 PR を作らず停止する。
- 追加 Issue の候補は報告するだけで、作成しない。
- active Build の取消をユーザーが求めた場合は hook-bound な`codex-build cancel`を実行する。取消後は実装、commit、push、draft PR を作成しない。

## エスカレーション

契約外の設計不足は `think` に戻し、事実・証拠不足は `research` に戻す。機械的な実装・テスト失敗はローカルで修正する。

## 報告

workflow contract と PR body は英語のままにする。終了状態、branch、test と review の結果、最終 commit、`Ship`の状態、検証済み PR URL を含む、ユーザー向けの最終報告だけを設定言語へ翻訳する。PR URL は`Ship`の検証が成功した後だけ報告する。
