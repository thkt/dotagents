---
name: build
description: 公開 GitHub Issue の Plan 1件を実装・検証し、任意で branch を push して下書き PR を作成する。Issue 公開後の end-to-end Build に使用する。
---

# Build

準備済みの Build input を`codex-flow run --input <task-input-json>`で実行する。controller は選択された公開 Plan からすべての実行 step を導出する。

## 入力

- 明示的な invocation では`#123`のような Issue shorthand を受け付け、現在の worktree の`origin` GitHub repository から選ぶ。hook が小さな Build input を準備する。実行 step を手書きしない。
- controller は GitHub network access を有効にして実行し、固定済み Issue の読み取りも controller 自身に行わせる。execution sandbox が`api.github.com`を拒否した場合は、同じ controller command を network escalation 付きで再実行する。準備のために別の`gh ... view`を実行せず、ブラウザの内容を contract の代わりにしない。
- Build 開始時に選択した Issue を 1 回だけ読み、その terminal JSON Plan を唯一の実装 authority とする。公開者の local receipt、別 rendering、body hash は要求しない。
- controller は Plan から actor goal、結合した file scope、test command を導出する。Build input を実装意図の別 source にしない。
- final test 後に、公開済みの goals と contracts に対して差分全体を独立した read-only SDK review にかける。

## 権限

- ユーザーが先頭で明示した invocation を、hook が束縛した repository における local branch、最終検証済み commit 1 件、Ship 有効時の push 1 回と下書き PR 作成 1 回の承認として扱う。`Ship`の確認を重ねて求めない。
- 同じ依頼で push または下書き PR 作成をユーザーが明示的に除外した場合を除き、`Ship`を含める。
- resume 時は、外部 action を繰り返す前に branch、commit、push、draft PR の postcondition を照合する。
- ユーザーが PR screenshots を明示的に求めた場合は、安全な画像名と alt text を準備済み Build input に追加する。完成した UI を render し、controller が指定した path に要求された画像を撮影する。controller が seal した画像 bytes と一致する場合だけ Ship し、画像の変更や未解決の添付があれば別 PR を作らず停止する。
- 追加 Issue の候補は報告するだけで、作成しない。
- active Build の取消をユーザーが求めた場合は hook-bound な`codex-flow cancel`を実行する。取消後は実装、commit、push、draft PR を作成しない。

## エスカレーション

契約外の設計不足は `think` に戻し、事実・証拠不足は `research` に戻す。機械的な実装・テスト失敗はローカルで修正する。

## 報告

workflow contract と PR body は英語のままにする。終了状態、branch、test と review の結果、最終 commit、`Ship`の状態、検証済み PR URL を含む、ユーザー向けの最終報告だけを設定言語へ翻訳する。PR URL は`Ship`の検証が成功した後だけ報告する。
