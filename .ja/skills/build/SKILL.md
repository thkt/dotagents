---
name: build
description: 公開GitHub Issue contract 1件を、検証済みの実装単位ごとにコミットし、下書きPRまで作成する。Issue公開後の実装を最初から最後まで進める明示的な依頼に使用する。
---

# Build

準備済みの Build input を`codex-flow run --input <task-input-json>`で実行する。controller は選択された公開 Plan からすべての実行 step を導出する。

## 入力

- 明示的な invocation では`#123`のような Issue shorthand を受け付け、現在の worktree の`origin` GitHub repository から選ぶ。hook が小さな Build input を準備する。実行 step を手書きしない。
- controller は GitHub network access を有効にして実行し、固定済み Issue の読み取りも controller 自身に行わせる。execution sandbox が`api.github.com`を拒否した場合は、同じ controller command を network escalation 付きで再実行する。準備のために別の`gh ... view`を実行せず、ブラウザの内容を contract の代わりにしない。
- 正確な GitHub `repository` と `issue_number` で公開 contract を選ぶ。公開者のローカル receipt を必須としない。
- issue workflow が埋め込んだ canonical machine Plan と、人が読む Plan および body digest の完全一致を要求する。
- controller が各 unit の outcome、file scope、actor mode、test command を公開 Plan に束縛する。Build input を実装意図の別 source にしない。
- Build 開始時、semantic review 直前、Ship 直前に Issue を再取得する。`load:plan`後の title、body、digest、Plan の変更は stale とする。
- final test 後に、公開済みの goals と contracts に対して差分全体を独立した read-only SDK review にかける。

## 権限

- tested unit では、controller が Red actor と Green actor の双方に正確な Plan file set を割り当てる。
- ユーザーが先頭で明示した invocation を、hook が束縛したリポジトリにおける宣言済みローカルブランチ、検証済み実装単位のコミット、push 1 回、下書き PR 作成 1 回の承認として扱う。`Ship`の確認を重ねて求めない。
- 同じ依頼で push または下書き PR 作成をユーザーが明示的に除外した場合を除き、`Ship`を含める。
- resume 時は、外部 action を繰り返す前に branch、commit、push、draft PR の postcondition を照合する。
- 公開 Plan が screenshots を宣言した場合は、完成した UI を render し、controller が指定した path にすべての画像を撮影する。controller が seal した画像 bytes と一致する場合だけ Ship し、画像の変更や未解決の添付があれば別 PR を作らず停止する。
- 追加 Issue の候補は報告するだけで、作成しない。
- active Build の取消をユーザーが求めた場合は hook-bound な`codex-flow cancel`を実行する。取消後は実装、commit、push、draft PR を作成しない。

## エスカレーション

契約外の設計不足は `think` に戻し、事実・証拠不足は `research` に戻す。機械的な実装・テスト失敗はローカルで修正する。

## 報告

終了状態、execution hash、ブランチと基準コミット、検証済みの実装単位とコミット、ゲートの証拠、修正回数、`Ship`の状態、存在する場合は検証済み PR URL を報告する。PR URL は`Ship`の検証が成功した後だけ報告する。
