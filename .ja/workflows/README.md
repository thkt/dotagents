# Workflows

プロジェクトの成果条件は[.codex/OUTCOME.md](../../.codex/OUTCOME.md)に定義する。

## Flow

1. Research は repository と任意の外部証拠を独立 audit 済みの report にまとめるか、独立して受理された 1 件のユーザー判断を待つ。
2. 完了した Research は、原典 report を指す topic 別 Knowledge 索引の再構築を試みる。
3. Think は明示的に選ばれた report と、Knowledge 索引で選ばれた最大 3 件の関連原典を読む。review 済みの事実不足を自動で Research に調査させ、検証済み ready Plan または独立して受理された 1 件の待機質問を返す。
4. Issue は読みやすい説明と 1 つの canonical Plan を公開する。作成と、選択済み Issue 全体の更新に対応する。
5. Build は選択された Issue を 1 回読み、1 人の actor が Plan 全体を実装・自己レビューする。test と独立レビュー後に 1 件の commit を作る。
6. Ship は明示的な承認がある場合だけ push と下書き PR 作成を行う。

Code は直接の変更依頼を受け、Build と共通の executor を Git action なしで使う。

## 契約の粒度

この節を Research・Think・Issue・Build・Code の共通方針とする。

契約には、観測可能な動作、許可する編集範囲、必要な外部互換性・永続データの互換性、安全条件、受け入れを確認する証拠を定める。正確な名前・型・field・format・algorithm は、明示した互換性または安全性の要件に必要な場合だけ指定する。それ以外の内部の型・関数・範囲内のファイル構成・algorithm は実装担当が選ぶ。Issue に全 TypeScript schema や API 名を列挙する必要はない。

Research は事実を確認し、未解決の事実上の主張を示す。未指定の実装上の選択は証拠不足ではない。Think は委譲に必要な外部要件と制約を確定し、実装上の選択を担当へ残す。その要件を変え得る、本当に未確定の事実は Research へ戻す。Issue はレビュー済みの同じ Plan を忠実に公開し、公開や翻訳で内部要件を追加しない。

Build と Code はこの区別に従い、認可された範囲で実装・自己レビューする。handoff を提案した場合だけ、返却前に独立した read-only review が、本当に契約外の設計判断または事実不足かを確認する。handoff が不要なら、その指摘を同じ実装 actor に返し、1回だけ修正する。unit stage や、成功した actor 呼び出しへの無条件の review は追加しない。確認された設計判断は Think、事実不足は Research に戻す。通常の実装上の選択と test failure はローカルの作業として扱う。現在の test・source・review・公開時の検証は維持する。

## Ownership

| Directory    | 責務                                         |
| ------------ | -------------------------------------------- |
| `research/`  | 証拠 report と、その派生 Knowledge 索引      |
| `think/`     | Plan の判断と追加調査の問い                  |
| `plan/`      | 共通 Plan の契約と検証                       |
| `issue/`     | 説明文と公開 Plan の公開                     |
| `build/`     | Issue 読み込み、検証、commit、Ship           |
| `code/`      | 直接の変更依頼の変換                         |
| `execution/` | Build と Code で共有する実装・検証・再開処理 |
| `runtime/`   | 起動承認、CLI 入出力、保存、host 環境        |
| `shared/`    | repository・model・schema・text の汎用処理   |

## Boundaries

- ユーザー入力は依頼と対象の選択を持つ。内部実行 record は持たない。
- workflow 契約と機械向け artifact は英語とし、Issue 説明文・表示する Plan Markdown・最終報告は設定言語を使う。
- 公開 Issue 内の唯一の JSON Plan を Build authority とする。Issue 作成時に ready Think Plan を title・prose に使う設定言語の `plan_markdown` へ忠実に翻訳し、全要件・identifier・file path・command を維持する。controller が Plan 見出しと変更のない canonical JSON block を追加する。翻訳表示を省略する既存 caller は英語描画を継続する。
- 任意の PR screenshot は Build の納品入力とし、公開 Plan authority に含めない。
- Research report は証拠記録であり、Knowledge は原典 report を指す再生成可能な索引である。日時は関連候補の順序付けに使い、現在の事実である証明にはしない。
- Build と Code は依頼全体を 1 人の actor で実装する。test または blocking review の失敗時は同じ実装工程へ戻り、test と review を再実行する。
- Plan unit は成果と受け入れ条件を整理する。actor 呼び出しの単位にはせず、レビューの証拠を編集範囲へ制限しない。編集は Plan 全体の許可範囲を守る。
- モデルは判断と指摘を返す。runtime が invocation と source を束縛し、モデルに controller の識別子や digest の復唱を要求しない。
- 1 件の invocation record が task、workflow、repository、外部書き込みの承認を持つ。入力ファイルは task 内で workflow ごとに分ける。hook は host identity を渡し、runner が入力検証、再開、停止理由の管理を行う。
- runtime の GitHub command は `shared/github.ts` に宣言する。shell test には GitHub credentials を渡さない。
- `codex-build` と `codex-code` は共通 executor の薄い adapter とし、一致する workflow binding だけを受理する。
- Issue 公開と Ship はそれぞれ明示的な承認を必要とする。Code は commit、push、PR 作成を行わない。
- 再開時は実行済み action の postcondition を照合し、二重適用を防ぐ。検証済み source と commit 対象の一致を確認する。
- 安定した判断は repository documentation に記載する。

## File naming

- `runner.ts` は workflow の公開 CLI 入口とする。
- 各 workflow の `manifest.ts` は入力を内部実行形式へ変換する。`execution/manifest.ts` は共通実装 step の構築と検証を持つ。
- `execution/engine.ts` は共有実行 loop、`actor-receipt.ts` は受理済み作業の receipt、`repository-isolation.ts` は sandbox と再開可能な変更適用を持つ。
- `research/knowledge.ts` は派生索引の更新と検索、`build/screenshots.ts` は画像の検証と納品をまとめて持つ。
- `runtime/storage.ts` は保存先、atomic write、artifact 命名を持つ。ソースの移動によって保存済みデータの場所は変えない。
- 独立した責務のない小さな helper は唯一の利用先に統合する。公開 CLI の入口は維持する。
- テストは検証する責務と同じディレクトリ名で分類する。

## Verification

`bun run check` を実行する。Bun 1.4.0 と `bun.lock` から依存関係も復元する場合は `bun run verify:clean` を使う。

## 保留中の判断

Research または Think は、結果を大きく左右する好み・scope・policy の判断が必要で、ユーザーに決定権がある場合だけ、investigator または designer が作成した安定した質問を 1 つ返せる。表示前に、独立した audit または review が質問全体を受理する。選択肢は説明付きで 2 つまたは 3 つとし、推奨する場合はその中の 1 つを指す。事実の不確実性は Research の audit 済み unknown として残し、内部実装の選択は担当に委ねる。

host は同一の prompt・選択肢・説明・推奨を省略せず、利用可能で許可された質問 UI で表示する。UI がなければ同じ全文をテキストで表示する。header や推奨マーカーは表示時だけ付け、workflow 契約に tool 名・host mode・UI schema・推奨 suffix を含めない。明示的な選択回答または自由記述を受け取り、runtime が渡した owner binding、表示した質問の全コンテキスト、回答原文を 1 件の record として元の hook-supplied root input に追記する。同じ task identity のまま、正確に元の root command を再実行する。再 arm や置き換え invocation の作成、nested child input の直接編集、label や同時の指示からの回答推測は禁止する。空・取消・timeout・回答なし・沈黙・推測・説明文だけの応答では待機を続ける。

root input の `clarification_answers` 配列へ追記する。record は `owner`、待機質問の `id` を写した `question_id`、変更のない `prompt`・`choices`・`recommendation`（省略時は null）、および `selection` と `answer` を持つ。最後の 2 項目の片方だけに明示された選択肢の label または自由記述の原文を入れ、もう片方は null にする。元の全項目と既存の record は変更しない。

待機では未完成の Research または Think report、Knowledge、Plan、Issue を作らない。元の invocation、変更不能な起動時 snapshot、選択済み evidence、受理済み履歴、correction と retry の予算、actor state、child ownership、および root 全体で最大 2 child の制限を保持する。未回答で同じ command を再実行しても model や child を呼ばない。runtime は有効な回答を journal に保存し、正確に束縛された waiting leaf だけへ届ける。Think → Research、Build → Research、Build → Think、Build → Think → Research でも同じ root から提出する。repository evidence を更新するには、新たな明示的 invocation が必要である。

Think の `research_required` は内部の判断に留め、自動で Research を実行して design と独立 review に戻り、検証済み ready Plan だけを公開する。提案 Plan には別の Issue 公開と新たな Build が必要である。公開 Issue は Build の唯一の実装 authority であり、待機中は Issue の再読み込み・編集、captured Plan の変更、実装再開、repository 書き込み、commit、Ship を行えない。回答は child 分析だけに使い、Issue 公開の承認、公開 Plan の拡張、Ship の承認には使わない。既存の明示的 invocation と network execution の規則は維持する。

## マージ後の整理

`$cleanup <issue>` は検証済み Build Ship receipt から Git を変更しない preview を作成する。過去の receipt は推測しない。`$cleanup approve <prepared digest>` が repository、task、inventory、削除対象を拘束する。`codex-cleanup describe` が `prepare`、`run`、`resume` を示し、hook が input と task identity を指定する。

cleanup は dirty state を所有権付き recovery commit に保存し、検証済みのマージ先 base で files/index を復元・照合してから、expected-OID lease による remote topic 削除、topic config、local ref の atomic 削除を行う。同じ OID の無関係な ref、reflog、worktree、config、staged/unstaged/untracked/ignored の状態を保持する。preview にはパスと対象の identity のみを示し、保存内容の bytes は出力しない。永続記録は primary worktree の `.codex/workflow-artifacts/cleanup` に統一し、承認対象の作業 worktree を別に拘束する。未完了の承認済み cleanup は linked worktree を含む協調する workflow writer を排他する。inventory 検査は外部の変更を検出するが、任意の Git/filesystem writer を禁止するものではない。

中断した操作は元の input から再開する。remote 削除が pending で expected OID が残っている場合は削除を再送せず、local/recovery ref を保持して手動解決を求める。不在を検証できれば同じ intent を照合して続行できる。report は完了・pending・未着手の工程と保持した recovery を示す。Stop hook から自動実行しない。intent-to-add など未対応の index/filesystem 状態は承認前に停止する。未取得 base の fetch 後に競合が判明した場合は、先に保存した recovery OID/ref を保持して `blocked` を返し、削除しない。新しい base が保存済みの untracked/ignored パスを追跡する場合は、内容が同じでも競合とする。
