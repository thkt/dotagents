---
name: think
description: 変更依頼1件を、検証済み ready Plan または独立レビュー済みのユーザー判断の質問1件へ整理し、事実不足は自動で Research に調査させる。明示的な設計・計画依頼に使用し、実装やissue公開には使用しない。
---

# Think

この段階で確定する内容は、共通の[契約の粒度](../../workflows/README.md)に従う。

`codex-think describe`で現在の入力形式と設計判断の契約を確認する。
最初の束縛された workflow command 自体を network escalation で呼び、その同じ tool call で対応していれば prefix `["codex-think", "run"]` の永続的な許可を要求する。一時的な`model_unavailable`が発生した場合は、intent を保持して同じ command を network escalation で正確に再実行する。

## 判断

- [.codex/OUTCOME.md](../../.codex/OUTCOME.md)と関連する[workflow contracts](../../workflows/README.md)を読み、scope の判断に使う。OUTCOME.md が存在しない場合は、Think を実行する前にプロジェクトの outcome と検証可能な完了条件を記載して作成するようユーザーへ依頼する。必要な動作と根拠のある制約を対象 unit の contract と acceptance tests に記載し、repository guidance は複製しない。
- 変更を 1 つに絞り、完了時に観測できる状態を定める。
- Plan を直接決める canonical JSON 原典を、`research/records` からの相対ファイル名または同じファイルの絶対パスで選ぶ。private path と生成 Markdown は selector にしない。Knowledge は最大 3 topic の最新原典を日時付きの手掛かりとして追加し、古い原典へ戻らない。runtime は原典の全項目と selected・related・private runtime-child の出自を保存し、再開時もその context を保持する。
- 完了状態と Plan の文言を決めるときは、[設計判断の文章](references/decision-writing.md)を読む。

## 境界

- 要件を変え得る未確定の事実は Research に戻す。範囲内の実装上の選択は担当に委ね、未指定だけを理由に Plan を不完全としない。
- repository snapshot と明示的に選択した Research を事実の基礎にする。Knowledge で選ばれた report の主張は現在の snapshot で確認する。作成日時だけで鮮度を判断せず、調査の evidence と repository rule を Plan に複製しない。

## 報告

Research または Think は、結果を大きく左右する好み・scope・policy の判断が必要で、ユーザーに決定権がある場合だけ、investigator または designer が作成した安定した質問を 1 つ返せる。表示前に、独立した audit または review が質問全体を受理する。選択肢は説明付きで 2 つまたは 3 つとし、推奨する場合はその中の 1 つを指す。事実の不確実性は Research の audit 済み unknown として残し、内部実装の選択は担当に委ねる。

host は同一の prompt・選択肢・説明・推奨を省略せず、利用可能で許可された質問 UI で表示する。UI がなければ同じ全文をテキストで表示する。header や推奨マーカーは表示時だけ付け、workflow 契約に tool 名・host mode・UI schema・推奨 suffix を含めない。明示的な選択回答または自由記述を受け取り、runtime が渡した owner binding、表示した質問の全コンテキスト、回答原文を 1 件の record として元の hook-supplied root input に追記する。同じ task identity のまま、正確に元の root command を再実行する。再 arm や置き換え invocation の作成、nested child input の直接編集、label や同時の指示からの回答推測は禁止する。空・取消・timeout・回答なし・沈黙・推測・説明文だけの応答では待機を続ける。

root input の `clarification_answers` 配列へ追記する。record は `owner`、待機質問の `id` を写した `question_id`、変更のない `prompt`・`choices`・`recommendation`（省略時は null）、および `selection` と `answer` を持つ。最後の 2 項目の片方だけに明示された選択肢の label または自由記述の原文を入れ、もう片方は null にする。元の全項目と既存の record は変更しない。

待機では未完成の Research または Think report、Knowledge、Plan、Issue を作らない。元の invocation、変更不能な起動時 snapshot、選択済み evidence、受理済み履歴、correction と retry の予算、actor state、child ownership、および root 全体で最大 2 child の制限を保持する。未回答で同じ command を再実行しても model や child を呼ばない。runtime は有効な回答を journal に保存し、正確に束縛された waiting leaf だけへ届ける。Think → Research、Build → Research、Build → Think、Build → Think → Research でも同じ root から提出する。repository evidence を更新するには、新たな明示的 invocation が必要である。

Think の `research_required` は内部の判断に留め、自動で Research を実行して design と独立 review に戻り、検証済み ready Plan だけを公開する。提案 Plan には別の Issue 公開と新たな Build が必要である。公開 Issue は Build の唯一の実装 authority であり、待機中は Issue の再読み込み・編集、captured Plan の変更、実装再開、repository 書き込み、commit、Ship を行えない。回答は child 分析だけに使い、Issue 公開の承認、公開 Plan の拡張、Ship の承認には使わない。既存の明示的 invocation と network execution の規則は維持する。

workflow 契約と canonical JSON Plan は英語とする。Issue 説明文・表示する Plan Markdown・最終報告は設定言語を使う。最終報告には `ready` と成果物パス、または report path を伴わない待機質問の全文を含める。完了時の次の状態は`issue`とし、別の承認なしに公開しない。
