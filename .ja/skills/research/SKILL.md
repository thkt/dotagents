---
name: research
description: プロジェクトまたは技術上の問い1つを調査し、別担当による検証と未確定事項を含む、出典確認済みの成果物にする。明示的な調査依頼に使用し、変更の実装やPlan自体の作成は行わない。
---

# Research

この段階で確定する内容は、共通の[契約の粒度](../../workflows/README.md)に従う。

`codex-research describe`で現在の入力形式と成果物の契約を確認する。
最初の束縛された workflow command 自体を network escalation で呼び、その同じ tool call で対応していれば prefix `["codex-research", "run"]` の永続的な許可を要求する。一時的な `model_unavailable` が発生した場合は、intent を保持して同じ command を network escalation で正確に再実行する。

## 判断

- [.codex/OUTCOME.md](../../.codex/OUTCOME.md)を読み、関連する一次資料だけを最小限確認する。存在しない場合は、Research を実行する前にプロジェクトの outcome と検証可能な完了条件を記載して作成するようユーザーへ依頼する。
- 問いを 1 つに絞る。
- 調査対象外の証拠を除く必要がある場合だけ、リポジトリ内の対象範囲を指定する。
- repository の証拠だけでは回答できない場合に限り外部資料を有効にし、一次資料を優先する。

## 境界

- 確認できない事実は未確定事項として残す。実装担当に委ねた内部実装の選択を、事実上の未確定事項にしない。
- 関連する Knowledge は手掛かりとして扱い、各 finding を支える現在の repository または外部 source を示す。

## 報告

Research または Think は、結果を大きく左右する好み・scope・policy の判断が必要で、ユーザーに決定権がある場合だけ、investigator または designer が作成した安定した質問を 1 つ返せる。表示前に、独立した audit または review が質問全体を受理する。選択肢は説明付きで 2 つまたは 3 つとし、推奨する場合はその中の 1 つを指す。事実の不確実性は Research の audit 済み unknown として残し、内部実装の選択は担当に委ねる。

host は同一の prompt・選択肢・説明・推奨を省略せず、利用可能で許可された質問 UI で表示する。UI がなければ同じ全文をテキストで表示する。header や推奨マーカーは表示時だけ付け、workflow 契約に tool 名・host mode・UI schema・推奨 suffix を含めない。明示的な選択回答または自由記述を受け取り、runtime が渡した owner binding、表示した質問の全コンテキスト、回答原文を 1 件の record として元の hook-supplied root input に追記する。同じ task identity のまま、正確に元の root command を再実行する。再 arm や置き換え invocation の作成、nested child input の直接編集、label や同時の指示からの回答推測は禁止する。空・取消・timeout・回答なし・沈黙・推測・説明文だけの応答では待機を続ける。

root input の `clarification_answers` 配列へ追記する。record は `owner`、待機質問の `id` を写した `question_id`、変更のない `prompt`・`choices`・`recommendation`（省略時は null）、および `selection` と `answer` を持つ。最後の 2 項目の片方だけに明示された選択肢の label または自由記述の原文を入れ、もう片方は null にする。元の全項目と既存の record は変更しない。

待機では未完成の Research または Think report、Knowledge、Plan、Issue を作らない。元の invocation、変更不能な起動時 snapshot、選択済み evidence、受理済み履歴、correction と retry の予算、actor state、child ownership、および root 全体で最大 2 child の制限を保持する。未回答で同じ command を再実行しても model や child を呼ばない。runtime は有効な回答を journal に保存し、正確に束縛された waiting leaf だけへ届ける。Think → Research、Build → Research、Build → Think、Build → Think → Research でも同じ root から提出する。repository evidence を更新するには、新たな明示的 invocation が必要である。

Think の `research_required` は内部の判断に留め、自動で Research を実行して design と独立 review に戻り、検証済み ready Plan だけを公開する。提案 Plan には別の Issue 公開と新たな Build が必要である。公開 Issue は Build の唯一の実装 authority であり、待機中は Issue の再読み込み・編集、captured Plan の変更、実装再開、repository 書き込み、commit、Ship を行えない。回答は child 分析だけに使い、Issue 公開の承認、公開 Plan の拡張、Ship の承認には使わない。既存の明示的 invocation と network execution の規則は維持する。

単独 Research は、Git の ignore 対象外の `research/records/<research_id>.json` と生成 view `research/reports/<research_id>.md` を人のレビューと commit 用に返す。生成 view を編集せず、staging・commit・push・Issue 公開は行わない。自動 child は private な audit 済み evidence だけを返す。後で共有するには、新たな単独 invocation で `retained_child_report` を選び、完了済み child state と所有権を保持する。runtime は原典を日時付き context として保存し、新 snapshot で再調査と両 audit を行う。canonical identity・中断 pair の復旧・互換性のない state は英語の [corpus 契約](../../../research/README.md) を参照する。成功した Research は canonical 原典だけを指す private な topic 別 Knowledge 索引の再構築を試みる。Knowledge の書き込み失敗によって Research report を無効にしない。workflow artifact は英語のままにする。回答、finding と未確定事項の件数、成果物パス、次の状態が`think`であることを含む、ユーザー向けの最終報告だけを設定言語へ翻訳する。Think へは進まない。
