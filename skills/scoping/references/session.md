# 保存・評価CLI

信頼するcheckoutの`scripts/discovery.ts`をBunで実行する。このスキルのディレクトリからは`../../scripts/discovery.ts`にある（この参照文書からは[discovery.ts](../../../scripts/discovery.ts)）。CLIはLLM・GitHub・ブラウザーを起動しない。必要な調査とユーザーとの会話は担当者が行う。

## 開始設定

設定ファイルに次を指定する。repoは調査成果を残す対象checkout、contextDirはセッション状態・評価・lockの保存先で、別の場所にする。絶対パスは利用環境に合わせる。contextDirは/tmpの作業コピーとは別の、継続保存する場所を選ぶ。

```json
{
  "repo": "/absolute/path/to/repository",
  "contextDir": "/absolute/path/to/private-context/github.com/owner/repository",
  "task": "reset-discovery",
  "referencePaths": ["README.md", ".dotagents.json"],
  "criteriaFile": "/absolute/path/to/skills/scoping/references/criteria.json",
  "request": "絞り込み後に元の一覧へ戻す操作を分かりやすくしたい"
}
```

```sh
bun /absolute/path/to/trusted/scripts/discovery.ts start /absolute/path/config.json
```

出力したSESSIONを以降のコマンドへ渡す。既存セッションを再開するときは最初にstatusを読み、依頼・対象・決定事項・未解決事項を確認する。同じtaskの開始は上書きせず失敗する。contextDirはGitの共通管理ディレクトリに紐づき、同じリポジトリのworktree間で共有する。GitとBunが必要。別cloneは同じremoteでも別の保存先を使う。対象worktreeのrepoと新しいtaskを指定して開始し、対象repoのresearch/にある調査から適用できるものを選ぶ。担当者はセッションごとのcheckout・基準・評価を共有しない運用とし、現在のコード・要求に対して再評価する。調査成果は、それを含むコミットを取り込んでworktreeやclone間で共有する。

criteriaFileはIDをキー、問いを非空文字列とするJSONオブジェクト。開始時の全文を保持するので、元ファイルの変更で実行中の基準は変わらない。開始した基準を実行途中で置き換えない。referencePathsは参照候補であり、存在・内容・十分性をCLIが検証したという意味ではない。外部資料のURL・版と選択理由はnoteに残す。

## 操作

| 操作 | 入力・結果 |
| --- | --- |
| `status SESSION` | 依頼、基準、revision、根拠、評価、決定の参照を表示する |
| `note SESSION NOTES.md` | 根拠・決定の正本への参照・未解決事項を保存する。旧評価を無効にする |
| `assess SESSION ASSESSMENT.json` | 現在のrevisionと全基準への評価を保存する |
| `gate SESSION` | 未評価・不足なら終了1、充足なら次の判断を表示して終了0 |
| `archive SESSION REPORT.md` | gateが通る場合だけ指定した報告本文を対象checkoutのresearch/へ、入力Markdownと同じ名前で保存する |

start・note・assess・archiveの終了0は保存成功を示す。assessが不足を保存した場合も0であり、進行の判定には必ずgateを使う。エラー時は非zero。statusは読み取りのみ。gateは更新との競合を防ぐため一時lockを使うが、保存済みの評価は変更しない。

以下は説明用に基準がpurposeの1項目だけの場合の評価例。実際にはセッションの全IDをchecksへ含める。未評価の項目を省略しない。

```json
{
  "revision": 0,
  "decision": "一覧復帰のUI方針を選ぶ",
  "checks": {
    "purpose": { "status": "missing", "reason": "元の一覧に戻した後の期待が未確定" }
  },
  "next": "UI実装を保留する。チャットで復帰後の期待を確認し、決定をIssueに記録して再評価する"
}
```

## 判断前の評価

次の判断や引き継ぎの前にstatusを読み、現在のrevisionに対して全基準を評価してassessで保存する。不足にはその影響、止める作業、解消方法・再開条件をnextへ具体的に記す。判断を変える回答・根拠が増えたらnoteで旧評価を無効にし、再評価する。

進む直前にgateを実行し、非zeroなら依存作業を止める。質問・回答はチャット、方針の決定は[開発方針](../../../.codex/DEVELOPMENT.md#対話と方針の決定)に従って扱い、noteには正本への参照と次の判断への影響を残す。回答受領や保存成功だけでgateは成功にならない。gate成功を人の合意や実装許可として扱わない。要求達成の保証にもならない。質問の提示・回答の確認や実装入口の制御をCLIが強制するものではない。

## 保存と制約

contextDirのwork/task/state.jsonがセッション記録の正本。archiveは実行場所にかかわらず、セッションのrepoに記録されたcheckoutのresearch/へREPORT.mdの本文をそのまま保存する。保存名は入力パスのファイル名を使う。小文字英数字をハイフンで区切り、.mdを付けて内容を表す名前にする。たとえばscoping-research-storage.mdとし、README.mdは大文字・小文字にかかわらず入口用に予約する。ディレクトリ部分は保存先へ引き継がない。文章確認ツールの出力がreviewed.mdなどの場合は、本文を変えず内容を表す名前にしてから渡す。

同名・同内容の再保存は成功し、同名の別内容は上書きせず失敗する。同じ調査には既存の名前を使う。別名の同一本文の重複排除は行わない。セッションの絶対パス、revision、内部評価は報告に付加しない。

既存報告の改訂はresearch/の同じファイルを編集し、Git差分でレビューする。変更した根拠をnoteへ記録し、再評価と必要な文章確認を終えてから[引き継ぎ手順](#調査成果の引き継ぎ)へ進む。改訂済みのファイルをarchiveへ渡した場合は同内容の再保存になるが、編集前の書込みをCLIが防いだり、改訂内容を自動審査したりするものではない。

REPORT.mdには問い、出典と対象版・確認日、結論、適用条件、未解決事項を含める。別の開発者やcloneから辿れる参照を使う。入力本文に含まれる機密情報やローカルパスをCLIが検出・除去する保証はないため、共有する本文を担当者が選んで確認する。要求合意の正本はGitHub Issueであり、報告やstate.jsonはその代替ではない。

CLIはセッションの保存先が対象checkout・Git管理領域内になる設定、別GitリポジトリによるcontextDirの再利用、既存taskの上書きを拒否する。contextDirは参加する全checkoutの外に置く。報告の保存先はGitで無視されていないことを確認し、research/や既存の保存先ファイルがsymlinkの場合は拒否する。Git add・commit・push、既存の外部researchの移管・削除は行わない。

セッションの更新はlockと一時ファイルからの置換を使う。ロックやstate.json.tmpが残った場合は自動で削除・再開せず、実行中のプロセスと保存済み内容を照合してから対応する。

信頼する担当者が操作する単一ホスト用。悪意ある同一ユーザーによる保存ファイルの改変、外部資料の変更検出、全ディスク障害への耐久性は保証しない。gateは保存時の評価を返すため、外部のコード・要求・資料が変わったら担当者がnoteで変更を記録し再評価する。実装CLIの起動をシステム全体で禁止する機構ではない。

## 調査成果の引き継ぎ

archiveの成功はローカル保存の完了。共有担当は差分を読み、今回共有する報告と公開範囲を確認する。依頼と既存の許可に従い、対象repoの検証・独立評価を経た通常の変更やPRへ報告を含める。既存の調査と重なる場合はそのコミット済み記録を参照し、生ログや外部保存庫を一括で追加しない。

implementはcleanなcommitted HEADからworktreeを作る。引き継ぐ前に、必要なresearch/の各報告がそのHEADに含まれ、確認済みの本文と一致することをgit showで照合し、git statusでcheckoutがcleanであることを確認する。未コミットの報告を退避してcleanにしただけでは引き継げない。必要な報告は既存の許可範囲でコミットに含め、コミット自体に追加の許可が必要なら依存する引き継ぎを保留する。公開の許可がない場合は公開だけを保留し、報告を含むcleanなHEADからの公開しない実装（--no-publish）は進められる。保存した場所と未完了の操作を報告する。

共有後はIssueにrepo相対の報告パス、コミット、公開先の参照を残す。終了時もローカル保存、コミット、公開を分けて伝える。別checkoutは報告を含むコミットから開始し、現在の要求に対する基準と評価を新しいセッションで確認する。過去の評価や合意を自動で引き継がない。

## 共通登録を変更する場合

スキル本文はこのrepoの`skills/scoping`に置く。利用先の`~/.agents/skills`から共通スキルを検出し、スキル実体の相対位置から信頼するCLIを解決する。対象repoのパスは別に指定する。登録の追加・変更でローカルな`.agents/skills`に同名コピーがある場合は二重検出を確認し、[開発方針](../../../.codex/DEVELOPMENT.md#旧資産の保全と登録変更)に従って保全してから登録を整理する。変更後のCLI検証と、新しいタスクからの検出・実行確認を区別する。既存の受入結果は[Issue #54](https://github.com/thkt/dotagents/issues/54)から参照する。
