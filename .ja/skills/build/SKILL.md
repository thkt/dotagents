---
name: build
description: 公開GitHub Issue contract 1件を、検証済みの実装単位ごとにコミットし、下書きPRまで作成する。Issue公開後の実装を最初から最後まで進める明示的な依頼に使用する。
---

# Build

`codex-flow describe --workflow build`で現在のワークフロー契約と Plan 契約を確認する。shell ゲートの証拠を選ぶときは、[shell ゲートの証拠](../../workflows/flow/references/shell-gate.md)を読む。

## 入力

- 明示的な invocation では`#123`のような Issue shorthand を受け付け、現在の worktree の`origin` GitHub repository から選ぶ。準備済みの source をそのまま使い、Issue の検索や source の再構築は行わない。
- 公開 contract は正確な GitHub `repository` と `issue_number` で選ぶ。公開者のローカル receipt は必須ではない。
- issue workflow が埋め込んだ canonical machine Plan と、人が読む Plan および body digest の完全一致を要求する。
- 各 unit の outcome と test command をその公開 Plan に束縛する。manifest の文言を実装意図の別 source にしない。
- Build 開始時、semantic review 直前、Ship 直前に Issue を再取得する。`load:plan`後の title、body、digest、Plan の変更は stale とする。
- final test 後に、公開済みの goals と contracts に対して差分全体を独立した read-only SDK review にかける。

## 権限

- tested unit の Plan file が workflow 開始時点で存在しない場合、その file は Red actor と Green actor の双方の allowed files に含める。既存 file の Red/Green 分割は許可する。
- ユーザーが先頭で明示した invocation を、hook が束縛したリポジトリにおける宣言済みローカルブランチ、検証済み実装単位のコミット、push 1 回、下書き PR 作成 1 回の承認として扱う。`Ship`の確認を重ねて求めない。
- 同じ依頼で push または下書き PR 作成をユーザーが明示的に除外した場合を除き、`Ship`を含める。
- resume 時は、外部 action を繰り返す前に branch、commit、push、draft PR の postcondition を照合する。
- 追加 Issue の候補は報告するだけで、作成しない。
- active Build の取消をユーザーが求めた場合は hook-bound な`codex-flow cancel`を実行する。取消後は実装、commit、push、draft PR 作成を行わない。

## エスカレーション

契約外の設計不足は `think` に戻し、事実・証拠不足は `research` に戻す。機械的な実装・テスト失敗はローカルで修正する。

## 報告

終了状態、実行定義のハッシュ、ブランチと基準コミット、検証済みの実装単位とコミット、ゲートの証拠、修正回数、`Ship`の状態、存在する場合は検証済み PR URL を報告する。PR URL は`Ship`の検証が成功した後だけ報告する。
