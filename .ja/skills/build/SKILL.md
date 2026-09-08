---
name: build
description: 公開 GitHub Issue の Plan 1件を実装・検証し、任意で branch を push して下書き PR を作成する。Issue 公開後の end-to-end Build に使用する。
---

# Build

この段階で確定する内容は、共通の[契約の粒度](../../workflows/README.md)に従う。

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

設計質問を `think`、事実不足を `research` に返す前に、共通方針の handoff review を行う。未指定の内部実装の選択は実装担当が決める。

## 報告

Research または Think は、結果を大きく左右する好み・scope・policy の判断が必要で、ユーザーに決定権がある場合だけ、investigator または designer が作成した安定した質問を 1 つ返せる。表示前に、独立した audit または review が質問全体を受理する。選択肢は説明付きで 2 つまたは 3 つとし、推奨する場合はその中の 1 つを指す。事実の不確実性は Research の audit 済み unknown として残し、内部実装の選択は担当に委ねる。

host は同一の prompt・選択肢・説明・推奨を省略せず、利用可能で許可された質問 UI で表示する。UI がなければ同じ全文をテキストで表示する。header や推奨マーカーは表示時だけ付け、workflow 契約に tool 名・host mode・UI schema・推奨 suffix を含めない。明示的な選択回答または自由記述を受け取り、runtime が渡した owner binding、表示した質問の全コンテキスト、回答原文を 1 件の record として元の hook-supplied root input に追記する。同じ task identity のまま、正確に元の root command を再実行する。再 arm や置き換え invocation の作成、nested child input の直接編集、label や同時の指示からの回答推測は禁止する。空・取消・timeout・回答なし・沈黙・推測・説明文だけの応答では待機を続ける。

root input の `clarification_answers` 配列へ追記する。record は `owner`、待機質問の `id` を写した `question_id`、変更のない `prompt`・`choices`・`recommendation`（省略時は null）、および `selection` と `answer` を持つ。最後の 2 項目の片方だけに明示された選択肢の label または自由記述の原文を入れ、もう片方は null にする。元の全項目と既存の record は変更しない。

待機では未完成の Research または Think report、Knowledge、Plan、Issue を作らない。元の invocation、変更不能な起動時 snapshot、選択済み evidence、受理済み履歴、correction と retry の予算、actor state、child ownership、および root 全体で最大 2 child の制限を保持する。未回答で同じ command を再実行しても model や child を呼ばない。runtime は有効な回答を journal に保存し、正確に束縛された waiting leaf だけへ届ける。Think → Research、Build → Research、Build → Think、Build → Think → Research でも同じ root から提出する。repository evidence を更新するには、新たな明示的 invocation が必要である。

Think の `research_required` は内部の判断に留め、自動で Research を実行して design と独立 review に戻り、検証済み ready Plan だけを公開する。提案 Plan には別の Issue 公開と新たな Build が必要である。公開 Issue は Build の唯一の実装 authority であり、待機中は Issue の再読み込み・編集、captured Plan の変更、実装再開、repository 書き込み、commit、Ship を行えない。回答は child 分析だけに使い、Issue 公開の承認、公開 Plan の拡張、Ship の承認には使わない。既存の明示的 invocation と network execution の規則は維持する。

workflow contract と PR body は英語のままにする。終了状態、branch、test と review の結果、最終 commit、`Ship`の状態、検証済み PR URL を含む、ユーザー向けの最終報告だけを設定言語へ翻訳する。PR URL は`Ship`の検証が成功した後だけ報告する。
