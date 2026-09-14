# 制御CLIの試行手順

合意済みIssueから新しい変更を作る担当者と、既存の修正・独立評価の構成を設定して試す担当者向けの手順です。この文書をCLIの操作・実行制約の正本とします。目的に応じて次の入口を選びます。

- 合意済みIssueの開発は[implement](../skills/implement/SKILL.md)から`development.ts`を使います。初回実装からPR作成までの手順・利用条件・上限は[IssueからPR作成](#issueからpr作成)を参照してください。文書のみの合意済みIssueも同じ入口で扱い、[ドキュメントの更新](../DEVELOPMENT.md#ドキュメントの更新)を適用します。
- 修正・独立評価の構成を設定して試す場合は`correction.ts`を使います。[準備と実行](#準備と実行)で設定・実行上限を確認し、check失敗または独立評価の`needs_changes`から修正・再検証・再評価へ接続します。
- ハーネスの導入・検証は[READMEのセットアップと検証](../README.md#セットアップと検証)、変更とレビューの方針は[DEVELOPMENT.md](../DEVELOPMENT.md)を参照してください。制御CLIや実モデルの起動は不要です。
- 何を変更するか未確定の相談は[scoping](../skills/scoping/SKILL.md)で要求を整理し、[対話と方針の決定](../DEVELOPMENT.md#対話と方針の決定)に従って合意済みIssueへつなぎます。

中断後の確認は[結果と再実行](#結果と再実行)、公開担当の操作は[PRの公開](#prの公開)、PRと人のレビュー・承認は[レビューを助ける説明](../DEVELOPMENT.md#レビューを助ける説明)を参照してください。公開の許可と範囲は[implement](../skills/implement/SKILL.md)と[IssueからPR作成](#issueからpr作成)で確認します。共通check内の制御テストは模擬コマンドを使いますが、ここで説明するCLI試行は実モデルを呼びます。

## IssueからPR作成

```sh
bun /absolute/path/to/trusted/scripts/development.ts 99 --repo /absolute/path/to/target-checkout
```

番号または対象repoのIssue URLを渡します。実行前に対象のREADME・開発方針・適用される指示と、下記の設定を確認してください。ハーネスはBun、Git、gh、Codex CLIとホストの日本語確認環境を使います。対象repoの言語やテストツールは設定に従います。

開始時にcheckout・設定・fetch/push remote・GitHub repo ID・base branch・ghの主体とpush権限を照合します。公開する実行ではユーザー認証の対象アクセスも実装前に確認します。元checkoutがdirty、run保存先が既存、同名branchが存在する場合は作業を始めません。要求全文を保存し、元checkoutのcommitted HEADから `codex/development-N` の隔離worktreeを作ります。設定のsetupを隔離先で順に実行し、初回実装、文章確認、必要な撮影、対象のcheck、独立評価へ進みます。要求変更、対象・設定・主体の変更、上限超過は停止します。

新規実行の上限は初回実装・修正・独立評価のモデル累計20分、追加修正2回・独立評価2回、各checkとCI待機9分です。初回実装の消費時間をcorrectionへ渡す残時間から差し引きます。[文章確認](#日本語の確認と修正)のGeminiと忠実性評価は別枠です。予算拡大や途中実行の自動復旧は行いません。

保存先は `~/.local/share/dotagents/development/<Git管理ディレクトリの識別値>/<Issue番号>/` です。`--run-dir DIRECTORY` でcheckout・Git管理領域外を指定できます。`target.json` に対象設定・repo ID・gh主体、ほかに要求、指示・結果、検証ログ、作業checkout、PR本文・URL、CI結果を残します。既存保存先は再実行に使いません。中断後は記録・実プロセス・GitHubの状態を照合し、保存先の削除や別名での自動再試行をしません。

`--no-publish` は独立評価までで止め、commit・push・PR作成を行わず、push権限の確認も不要です。通常実行は検証済み対象を再照合し、commit、PR本文の文章確認、ユーザー認証と権限の再確認、gh主体の資格情報を明示したpush、ユーザー認証によるPR作成へ進みます。pushにはコマンド内だけで定義するHTTPSの公開先を使い、GitのURL書き換え後も対象が一致することを確認します。SSHへの切替や別repoへの書き換えは拒否します。`push.followTags`の設定にかかわらず、タグを同時に公開しません。生成媒体の変更を設定した保存先から添付します。

`ciChecks`に指定した全checkの登録とSUCCESSをCI待機9分の中で待ち、同時にPRのhead・base・OPEN状態を照合します。必要checkのSKIPPED・NEUTRALは成功にせず、同名checkが複数あれば全件の成功を求めます。他の登録済みcheckにも失敗・保留があれば完了にしません。各取得時の応答と診断は`ci-registration-N.stdout`・`.stderr`へ保存します。最新CIとPRのhead・baseを照合し、表示・再生・配置の確認は `rendered_media_check` として担当者へ渡します。CI未確認時はPR URLと記録を保持して非zero終了します。人がレビュー・承認・マージします。

## 対象repoの設定

対象checkoutのルートに `.dotagents.json` を置き、コミット済みの合意した設定から開始します。設定自体を変更するIssueは、実行前に適用する設定と検証方法を照合してください。実行中の設定置換で検証を省略することはできません。

```json
{
  "repository": "team/component",
  "remote": "upstream",
  "baseBranch": "release",
  "setup": [["python3", "-m", "venv", ".venv"], [".venv/bin/pip", "install", "-r", "requirements-dev.txt"]],
  "check": [".venv/bin/python", "-m", "pytest"],
  "ciChecks": ["tests"],
  "capture": null
}
```

コマンドはshell文字列ではなくargv配列です。実行ファイル名は非空とし、後続の空文字・空白引数はそのまま渡します。対象checkoutで実行し、非zeroは失敗です。セットアップ不要なら `setup: []` と明示します。`check` の欠落・空配列、撮影方針の省略を拒否します。対象のcheckがテスト未実行・skip等を成功扱いしないことも設定担当と独立評価で確認します。CLIが任意の外部runnerのレポート形式や合意の意味を判定するものではありません。

`ciChecks`はCIで実行成功を確認するcheck名の配列です。省略・空の名前・重複を拒否し、対象repoのcheck名をそのまま指定します。公開する`development.ts`実行では1件以上が必要です。CIを持たないrepoは空配列を明示し、`--no-publish`でローカル検証まで実行できます。既存設定にもこの項目を追加してください。

`capture: null` は必要媒体がない場合に使います。媒体が必要なら `command`（argv）、`destination`（生成媒体専用のrepo相対ディレクトリ）、`required` を指定します。必要媒体を常に撮る場合、Markdownを画面の入力にするrepo、文書Issueでも媒体が必要な場合は `required: true` です。`false` は下記の文書・保存記録が画面に影響しないrepoでのみ使えます。設定時にIssueの必要証拠と照合し、未設定を成功へ読み替えません。実装・評価担当は設定と要求が矛盾したら停止します。

`{harness}` はコマンド引数内で信頼するハーネス実体の絶対パスへ展開します。このハーネス自身の設定は [../.dotagents.json](../.dotagents.json) が正本です。別repoへこの設定を無条件にコピーしません。

読み取りによる照合は次で行えます。`--write` はghのpush権限も検証します。Issue・PRの作成・更新はここで表示するghユーザーの認証を使います。scopingの保存・十分性評価CLIはGitHubへ書き込まず、担当者が合意と対象を照合して既存ghのIssue操作を行います。

```sh
bun /absolute/path/to/trusted/scripts/target.ts /absolute/path/to/target-checkout https://github.com/team/component/issues/99 --write
```

対応は現在のmacOSホストとgithub.comです。GitHub Enterprise、他ホスティング、旧code/cleanup入口、旧state変換は対象外です。全調査への必須監査、質問・回答のruntime所有、公開intentの機械的拘束、自動再開は提供しません。人の合意と変更時の停止、対象の検証、独立評価、検証済み対象の同一性確認を維持します。

## ホストによるブラウザー検証と撮影

実装・修正担当はsandbox内でコード、テスト、文書、撮影定義を準備し、ブラウザーやサーバーの起動はホストCLIが担当します。ホストの実行を残しているだけなら`repaired`を返し、要求や許可の判断が必要な場合は`needs_human`で具体的な理由を返します。

必要媒体は対象設定のcapture commandで撮影します。コマンドにはcheckout外の新しい絶対出力ディレクトリを最後の引数として渡します。PNG/JPEG/WebP/MP4/WebMだけを直下に保存し、動画contextを閉じて確定してください。撮影中はcheckoutに媒体・コード・文書・レポートを書きません。ホストは空の出力、不正形式、symlinkを拒否し、対象不変を確認して `destination` へ取り込みます。生成媒体専用領域は置き換えるため手書きの記録を置きません。

付属のPlaywrightアダプターは `bun {harness}/scripts/capture.ts SPEC CONFIG ABSOLUTE_OUTPUT` です。対象repo側のPlaywright依存、指定したspecと設定のprojects・webServerを使います。元設定からの相対`testDir`、global setup/teardown、`tsconfig`、`webServer.cwd`を解決します。指定specが通常の`testDir`外にあれば、そのspecのディレクトリへ探索範囲を広げます。各撮影projectでは指定specだけを選び、依存・teardown projectは元の選択条件を保ちます。projectの`use`とブラウザーの選択、ホストの`PLAYWRIGHT_BROWSERS_PATH`を引き継ぎます。spec欠落、指定specの実行0件、skip、失敗は成功扱いしません。setupだけ成功しても撮影の成功にはしません。[trial repo](https://github.com/thkt/dotagents-workflow-trial/blob/d0134086ad9bdddb5ed2693327cb1ffb0859c4a2/README.md)では同repoのspec・config・媒体保存先を使います。この共通repoは商品とPlaywright依存を持ちません。ブラウザーやサーバーは対象設定で起動し、起動失敗をレポートから分類します。固定ブラウザーの事前起動は行いません。

アダプターは新しい外部出力先を要求し、生成設定・JSONレポート・artifactsの保存先もその隣へ指定します。既存snapshotの参照先は元設定の場所から解決し、snapshot更新は無効にします。媒体は拡張子とファイル先頭の形式識別子を照合し、空の出力とsymlinkを拒否します。完全なデコードや表示品質はこの照合では保証しません。spec、global hook、webServer自身の書込みもcheckout外へ向けてください。任意の対象コードの書込みを隔離する機能ではなく、ホストは撮影後に対象の不変を照合します。

`destination`の媒体は撮影で更新されます。過去の記録の固定ハッシュを最新媒体の根拠には使いません。撮影後に対象ソース（commitと未commit差分を含む）・撮影ログ・配置した媒体のサイズとSHA-256・検証結果を照合し、対応PRへ記録します。公開時はホスト固有のパス・非公開repo情報・非公開の実行ログを転載せず、公開可能な要約と根拠を示します。過去の記録は対象時点を保ち、PR内の表示・再生と同headのCIはそれぞれの実施結果を区別します。

correctionを単独で設定する場合も、capture commandに加えて `captureDestination` と `captureRequired` を明示します。`captureRequired: true` でcommandがない設定は実行前に拒否します。capture commandの省略は、媒体不要の合意がある場合だけ使います。通常入口のdevelopmentは対象設定をそのまま渡します。

以下の撮影再利用は `required: false` の場合だけ適用します。`true` は文書も撮影対象の同一性に含め、初回は必ず撮影します。

各検証の前に、HEADからの追跡ファイルの差分と未追跡ファイルを確認します。変更が通常の非実行Markdownファイルだけなら撮影と媒体の置き換えを省略し、既存媒体を保持して共通check・独立評価へ進みます。symlinkや実行属性の追加・解除・削除、コード、撮影定義、媒体など他の変更を含む場合や、変更を判定できない場合は通常どおり撮影します。文書が参照する媒体の不足や不整合は独立評価で確認します。

初回撮影後は、最後に成功した撮影と媒体取り込み時点のファイル内容、モード、パスを保存し、修正後と比較します。通常のMarkdown文書と、`destination`の親ディレクトリ内（`destination`を除く）の保存記録（`.json`・`.txt`・`.log`・`.stdout`・`.stderr`・`.diff`）だけの更新なら撮影を省略し、既存の媒体と撮影ログを保持します。これらは撮影の入力として使わない文書・記録の配置です。実行可能ファイルとsymlinkは省略対象にしません。コード、設定、撮影定義、媒体、その他のファイルが変わった場合、撮影失敗後、成功した比較基準がない場合は再利用しません。初回のMarkdownのみの変更を省略する条件は上記のとおりです。

撮影を再利用しても、文書や記録を含む全体の変更検知、共通check、独立評価は省略しません。評価者は保持された媒体の撮影対象と現在のコードの対応、および証拠記録の整合を確認します。停止済み実行の上限や状態は変更せず、この仕組みは同じ実行の修正ループ内で使います。

再撮影が必要な場合はcheckout外の新しい出力先で行います。要求とソースの不変を確認して媒体を取り込み、媒体を含む対象を確定して共通check、独立評価、公開へ進みます。撮影失敗時はログを修正担当へ渡します。起動不能は`capture_unavailable`、撮影の時間切れは`capture_timeout`として停止し、ホスト側での環境確認が必要です。撮影にも各checkと同じ9分の上限とプロセスグループの中断処理を適用します。正常な`needs_human`と不正応答を区別して表示し、記録と既存の消費上限を保持します。

## 準備と実行

```text
bun scripts/correction.ts /absolute/path/config.json
```

設定は信頼する公開・実行担当が用意します。対象base branchと照合した隔離作業コピーを用意し、設定、制御コード、証拠ディレクトリを修正対象の外へ配置します。以下は設定形式の例です。Issue番号、絶対パス、実行上限はその試行で合意した値を起動前に設定してください。例の値自体は新たな実行許可を意味しません。

```json
{
  "cwd": "/absolute/path/isolated-worktree",
  "runDir": "/absolute/path/evidence",
  "issue": ["gh", "issue", "view", "DELIVERABLE_ISSUE_NUMBER", "--repo", "OWNER/REPO", "--json", "title,body,updatedAt"],
  "check": ["bun", "run", "check"],
  "repair": ["bun", "/absolute/path/controller/scripts/codex-actor.ts", "repair", "/absolute/path/evidence"],
  "review": ["bun", "/absolute/path/controller/scripts/codex-actor.ts", "review", "/absolute/path/evidence"],
  "repairLimit": 2,
  "reviewLimit": 2,
  "modelTimeMs": 1200000,
  "checkTimeMs": 540000
}
```

`issue`は成果物の要求を取得するコマンドです。CLIは取得結果の全文を修正と独立評価の両方へ渡します。GitHubの書き込みコマンドはこの入口にありません。

### 成果物の要求と実験の管理

成果物のIssueには、目的、変更範囲、完了条件、適用する合意済み方針を記載します。成果物に必要な検証と説明も含めます。文書整理なら、読む順序、正本の配置、リンクの整合性などを要求にし、その実験の計測や公開作業を成果物へ書き込む指示にしません。

実験を行う場合は、実験管理のIssueから成果物のIssueを参照し、比較条件、実行上限、計測項目、結果の保管と公開を管理します。通常の変更に実験管理Issueを追加する必要はありません。実行担当はそこで合意した上限と権限を設定・実行に反映します。

`config.issue`には成果物のIssueを指定します。完了条件の理解に必要な別Issueの本文は取得対象に含めますが、実験管理の本文を一括で連結しません。要求と実験手順が混在している場合は、実行前にIssueを分けて合意し、見出し抽出で要求を省略する運用は避けます。過去の実測を再利用する場合は元のIssueや証拠を保持し、分離した要求を新しいIssueに記録します。

実行前に`config.issue`の取得結果を確認し、必要な要求と参照内容が揃い、実験手順が成果物の完了条件として混ざっていないことを照合します。この分離は入力準備の責任であり、CLIが内容を自動判定するものではありません。

### 修正・独立評価の担当

`repair`と`review`は要求と失敗根拠を標準入力で受け取り、結果のJSONだけを標準出力へ返します。評価は`status: accepted | needs_changes`と文字列`findings`、修正は`status: repaired | needs_human`と文字列`findings`です。欠落、不正、実行失敗は停止し、成功には読み替えません。これは呼び出し間の最小の結果形式で、Issueの完了条件を置き換える契約ではありません。

付属のCodex呼び出しはAstra/highを使い、修正はworkspace-write、評価はread-onlyで新しい実行を開始します。評価者はコード、テスト、文書を読み、ホスト側checkの結果と分けて評価します。実行前にCodexへログインし、対象モデルが利用できるCLIを用意してください。GitHubの書き込みtokenを成果物やプロンプトへ埋め込まないでください。

独立評価は公開や人のレビューへ渡せるかを判断します。要求の全文を読み、実装、意味のあるテスト、必要な文書、用意された画像や動画と対象の対応付けを確認します。これらの不足は修正へ差し戻します。PR作成、添付、PR内の表示確認は公開担当、人のレビューや承認は人の担当です。これらが公開前に未実施であることだけを実装の不備とは扱わず、残る担当作業をfindingsに記してacceptedを返します。要求を免除したり、未実施の確認を完了扱いしたりしません。

修正担当は調査や修正に必要な箇所を確認し、共通checkはホストが修正後に実行します。独立評価担当は共通checkを再実行せず、要求、コード、テスト、文書の妥当性を確認します。これはCLI試行での担当分担です。

文書の更新要否と完了条件は[ドキュメントの更新](../DEVELOPMENT.md#ドキュメントの更新)を参照します。修正担当と独立評価担当で同じ基準を使います。

## 結果と再実行

- `ready_for_human_review`で終了コード0、それ以外は未達として終了コード1です。人の承認やマージ完了を意味しません。
- `state.json`に消費回数、モデル累計時間、各check・モデルの対象と結果を残します。checkの時間はモデル累計時間に含めません。
- checkやモデルの標準出力とエラー、モデルへの指示を証拠ディレクトリへ保存します。CodexのJSONLは別の実行ディレクトリへ逐次保存します。
- 回数は起動前に予約します。時間超過ではプロセスグループを停止し、親プロセスの終了を待ちます。macOS/Linuxを対象とします。
- 同じ設定・証拠ディレクトリの再実行は回数を初期化しません。終端結果があれば再実行せず、対象が変わっていれば古い成功を返しません。
- SIGINT/SIGTERMでは実行中のコマンドと同一プロセスグループの子をSIGKILLで停止し、コマンド終了と出力保存を待って異常終了します。active予約を完了に読み替えず、次のコマンドへ進みません。
- 中断した予約やlockが残った場合は停止します。既存プロセス、ログ、消費量の照合が必要です。lockやstateを削除して制限を回避しないでください。完全自動再開は対象外です。

SIGKILLやOS停止は捕捉できません。CLIだけが強制終了すると、子プロセスが残る場合があります。この場合もlockまたはactive予約が再実行を拒否しますが、書き込み停止の保証とは別です。プロセスグループから離脱した子も停止保証の対象外です。

中断後は、設定したコマンド、作業ディレクトリ、開始時刻をプロセス一覧と照合し、実行が残っていれば対象を確認して停止します。その後、stateのactiveや消費回数、保存ログ、現在のIssueと作業差分を照合します。保存済み時間は中断した実行の全時間を含むとは限らないため、回数だけで再開可とは判断しません。このCLIには自動復旧やlock解除の入口はありません。再開の範囲や残り実行上限を判断するまで既存の証拠を保持します。

対象はGitの追跡ファイルとignoreされていない未追跡ファイルのパス・内容・モード、および取得した要求本文です。削除はそのパスが存在しない成果物として比較するため、検証済みの削除・renameをstage・commitしても同じ検証結果を再利用できます。受入後にファイルを復元したり、内容・モード・必要媒体・要求を変えたりすると古い成功を拒否します。既存の停止状態や消費予算は書き換えません。ignoredな依存関係や生成物まで同一性を保証しません。信頼する単一実行で使い、別作業による同じcheckoutの同時更新を避けてください。

準備時の分離や記録は、同一ユーザーによる悪意ある改変へのセキュリティ境界ではありません。検証定義の弱体化は独立評価と人のレビューでも確認します。

## 検証

現在の共通checkの順序、ハーネスの検証範囲は[README](../README.md#セットアップと検証)、書式・型情報を使うlint・テスト実行完了の方針は[DEVELOPMENT.md](../DEVELOPMENT.md#typescriptの書き方)を参照してください。
制御テストは `scripts/tests/` に置き、対象の責務に合わせて分けています。2026-09-14の修正で行った整理の判断と未確認範囲は[検証記録](../docs/evidence/harness-review-2026-09-14.md)へ分けています。

| 対象 | テスト |
| --- | --- |
| 修正フローの結果・上限・入力・保存状態 | [correction.test.ts](tests/correction.test.ts) |
| 制御プロセスの中断・timeout・ログ | [correction-process.test.ts](tests/correction-process.test.ts) |
| 撮影設定の解決・実行判定・外部出力 | [capture.test.ts](tests/capture.test.ts)、[capture-browser-errors.test.ts](tests/capture-browser-errors.test.ts) |
| 撮影・媒体の保持と再利用 | [correction-capture.test.ts](tests/correction-capture.test.ts) |
| 文章候補の検証・忠実性評価・採用判断 | [writing.test.ts](tests/writing.test.ts) |
| 作業ツリーへの文書反映・再評価・中断時の保全 | [writing-review.test.ts](tests/writing-review.test.ts) |
| 文書レビュープロセスの失敗分類・停止・ログ | [writing-process.test.ts](tests/writing-process.test.ts) |
| テスト実行完了の判定 | [test-runner.test.ts](tests/test-runner.test.ts) |

撮影アダプターの実動作はホスト専用の一時fixtureでも確認できます。既存のPlaywright依存と導入済みブラウザーを持つ対象repoを明示します。依存の導入や対象repoへの書込みは行わず、OSの一時ディレクトリにfixture・媒体・ログを保持します。ブラウザーを起動するためsandbox内では実行しません。

```sh
bun scripts/verify-capture.ts /absolute/path/to/target-repo firefox
```

最後の引数は`chromium`、`firefox`、`webkit`のいずれかです。通常の相対`testDir`とその外のspec、依存project、既定の`webServer.cwd`、選択ブラウザー、checkout不変、0件・skip・失敗・不正媒体・起動不能を実Playwrightで確認します。これは共通checkには含めず、対象Playwright版・選択ブラウザー・ログの場所と結果を別の証拠として報告します。共通repoの`capture: null`は維持します。

Playwright runnerを起動する契約テストは[trial repoのtrial/control/](https://github.com/thkt/dotagents-workflow-trial/tree/93b38f0bc690373b4b1f68e37a42f721929d6386/trial/control)に置き、同repoの `test:trial-control` が商品側の依存を使って実行します。Bun runnerと両レポート形式の拒否条件は `scripts/tests/test-runner.test.ts` に残します。

開発入口・要求整理・PR公開・Codex実行は、それぞれ `development.test.ts`・`discovery.test.ts`・`publish.test.ts`・`codex-actor.test.ts` で確認します。共有する試験環境とモデル応答データの組み立ては `tests/support/` に置き、テストケースと期待値は各テストファイルに置きます。

SIGKILLのテストでは残存プロセスをテスト側で後片付けしており、CLIの自動停止保証ではありません。

制御テストの成功は実モデルの判断品質の証拠には数えません。実測結果とその対象、未検証範囲は[検証記録](https://github.com/thkt/dotagents-workflow-trial/blob/93b38f0bc690373b4b1f68e37a42f721929d6386/trial/evidence/README.md)を参照してください。

## 日本語の確認と修正

Antigravity CLIの`agy`と既存のCodex CLIを使います。初回利用前に`agy models`で`gemini-3.8-flash-high`を確認し、ログインはホストの既存設定を使います。CIにモデル認証は追加しません。

Issueや直接作成・更新するPR本文、単独の文書は、本文案と事実・合意・出典のファイルを分けて準備します。対象に含まれない秘密・非公開ログを入力へ混ぜません。

```sh
bun /absolute/path/trusted-checkout/scripts/writing-review.ts file \
  --input /absolute/path/draft.md --facts /absolute/path/facts.md \
  --output /absolute/path/reviewed.md --run-dir /absolute/path/outside-checkout/writing-run
```

確認に成功すると、新しいoutputファイルへ確認済み候補を書き出します。Antigravity CLIを利用できない理由を確認できた場合は、原文をoutputへ保持し、`skipped.json`へモデル名、理由、入力hashを記録して通常の確認へ進みます。未実施の理由はIssueやPRの説明、または完了報告に記載し、確認済みとは報告しません。Issueではこのファイルを`gh issue create/edit --body-file`へ渡し、PRでは`publish.ts`または`gh pr edit --body-file`へ渡します。タイトルや機械的な識別子の生成はこの本文修正とは分けます。公開後は実際の本文、リンク、添付を読み直します。配置や説明を変更した場合も、その最新本文に同じ確認を適用します。

`development.ts`は変更されたMarkdownを対象に、ホストの共通check・独立評価の前と修正後に`documents`モードを実行します。変更のない文書は対象外です。候補の採用前に対象文書の集合・内容・根拠を再照合し、確認中に新たな文書が対象になった場合も停止します。同じ文書と根拠に対する成功記録を再利用します。利用不能の記録は成功とは分けて保持します。同じ保存先で入力が同じ場合は再試行せず、未実施の理由を通知します。入力が変わった場合は確認を試します。PR本文は検証結果から作成し、確認を通してからpush・公開します。`--no-publish`も文書の確認は行いますが、PR本文作成と公開は行いません。`correction.ts`を単独で使う場合は、設定の`writing`に同CLIの`--worker documents --facts FILE --run-dir DIRECTORY`呼び出しを指定します。

コードブロックと参照形式リンク・画像はBun標準のMarkdown parserでも抽出し、インデントされたfence、リスト内のコード、相対参照先を保護します。frontmatter、コード表記、URL、hash、Issue参照の既存の機械的照合も維持します。

Geminiは修正候補を作成し、別の読み取り専用Codexは原文、根拠、候補の間で意味の一致を評価します。モデルID、完了結果、JSON、コード表記、URL等を機械的に確認し、抽出した保護対象は本文中の順序と個数も保持します。意味の評価はモデルの判断であり、事実の正しさや完全一致を保証するものではありません。元資料の確認と人のレビューも必要です。

各モデル呼び出しの上限は5分、1回の処理全体の制限時間は11分です。文書処理は既存の修正サイクルごと、PR本文は公開前に1回行い、自動の再試行はありません。この時間は従来の実装・独立評価のモデル時間枠とは別枠として扱い、ログへ残します。入力が大きすぎる場合は情報を捨てずに停止します。必要に応じて対象を分割して確認した上で、再開方法を判断します。

記録はcheckout外に保存し、原文、根拠、執筆指示、Gemini候補、意味確認、成功記録を残します。利用不能のスキップ記録は成功と分けて保持します。原因不明の失敗や中断した記録を削除してやり直しません。`writing_failed`ではログを確認し、入力の修正、実行環境の復旧、または必要な人の判断へ戻します。CLI外からのGitHub操作自体を禁止する仕組みではなく、担当者も確認済み本文を使用する責任を持ちます。

## PRの公開

公開担当は信頼するハーネスから対象checkoutを指定し、ユーザーの既存gh認証を使います。App設定・署名鍵・installation tokenは不要です。環境変数のtokenが保存済み認証より優先される場合もあるため、実効主体を `gh api user` で確認します。対象hostはgithub.comです。`GH_HOST`が別hostを指定している場合はGitHub操作前に停止します。認証情報をrepo・ログ・PR本文へ保存しません。

```sh
bun /absolute/path/to/trusted/scripts/target.ts /absolute/path/target-checkout --write
bun /absolute/path/to/trusted/scripts/publish.ts --repo /absolute/path/target-checkout --actor USER_LOGIN --head codex/example --title '変更の概要' --body-file /absolute/path/pr.md
```

`target.ts CHECKOUT --write`は対象repo・base branch・remoteとghのpush権限・実効ユーザーを照合し、PRを作らず確認結果を返します。`--actor` は事前に確認したloginを指定します。developmentは開始時のloginを公開時にも渡し、不一致で停止します。PR書込みの細かなtoken権限や組織ポリシーは読み取り確認だけで保証せず、公開失敗時は停止理由とGitHub上の実状態を確認します。

同じhead・baseのopen PRがあれば作者と確認済み本文の一致を照合してURLを返します。不一致なら本文を保持して停止し、担当者が内容を照合して対応します。新規作成も同じgh認証を使い、作者と本文を確認します。旧Appや別ユーザーのPRを現在のユーザーの公開成功と扱いません。このCLIは既存PRの本文更新・push・承認・マージを行いません。正常終了時もコマンドの所有するprocess groupの残存子を終了させます。SIGINT・SIGTERMでは実行中のコマンドと子プロセスを停止し、後続の公開操作へ進みません。通信断や強制終了時は、再試行前にPRの実状態を確認します。制御テストの模擬応答は実際のGitHubアクセスの証拠ではありません。

### PRへの画像・動画の添付

添付直前に対象と開始時のユーザー認証を再照合し、同じユーザーのgh認証で`gh pr edit --attach`を実行します。対象 commit で取得した画像・動画を指定します。本文を指定しなければ、既存の本文を保って添付が追加されます。

```sh
gh pr edit PR_NUMBER --repo OWNER/REPO \
  --attach '/absolute/path/screenshot.png#検索結果の表示' \
  --attach /absolute/path/demo.mp4
```

添付後は`gh pr view PR_NUMBER --repo OWNER/REPO --json body --jq .body`で本文を取得し、アップロード先の URL を確認します。配置を整える場合は、この最新の本文をファイルに保存して編集し、`gh pr edit PR_NUMBER --repo OWNER/REPO --body-file /absolute/path/pr.md`で反映します。既存の説明と添付 URL を維持し、画像は必要に応じて table に並べます。動画の添付 URL は単独の行に置き、PR 内で再生できるようにします。

公開担当は[レビューを助ける説明](../DEVELOPMENT.md#レビューを助ける説明)に従い、実際のPR画面で表示・再生と配置・説明の読みやすさを確認します。動画には確認する操作・状態と画面条件が分かる見出し・説明を添え、撮影準備時に選んだ説明手段が実際に伝わるかを確認します。キー表示・字幕・音声がある場合の確認と、説明不足の戻り先も同方針に従います。必要な整形後に再確認して完了とし、確認できない場合は未確認点を報告します。`rendered_media_check`はこの確認全体を指し、CLIのアップロード成功だけでは完了しません。一部のアップロードが失敗すると、成功した添付を反映したうえでコマンドが失敗終了するため、本文を確認し、未添付のファイルだけを再実行します。
