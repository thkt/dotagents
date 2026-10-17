# 指示変更の比較eval

比較eval専用の実行コード・corpus・合成課題・模擬テストと操作説明を、このディレクトリにまとめています。通常ハーネスの実行経路からevalを起動・importしません。

## 配置と入口の移行

| 対象 | 現在の配置 | 旧配置 |
| --- | --- | --- |
| 実行コード | `eval/*.ts` | `scripts/eval/*.ts` |
| 課題・採点基準 | `eval/corpus/` | `scripts/eval/corpus/` |
| 合成課題workspace | `eval/fixtures/workspace/` | `fixtures/workspace/` |
| 模擬テストとホスト用資料 | `eval/tests/` | `scripts/tests/eval/` |

repoルートから`bun eval/eval.ts plan|run CONFIG`、`bun eval/eval.ts report RUN_DIRECTORY [JUDGMENTS_JSON]`を使います。旧入口`bun scripts/eval/eval.ts ...`は残していません。新配置を含む同じ共有commitをrunner・corpus・workspaceへ指定し、設定の`workspaceFiles`も新配置へ更新してください。固定A/Bの指示commitと指示側のパスは変更しません。過去runは上書き・再開せず、歴史資料と固定A/Bの検証snapshotも書き換えません。

課題ファイルはrepo相対パスを保って隔離環境の`/work/repo/eval/fixtures/workspace/`へ配置します。新配置のcorpusにある依頼文・checkと同じパスになり、両条件で同じ本文・hashを使います。ホスト用のcorpus・テスト・採点情報は転送しません。

`eval`から`../scripts/shared/`のプロセス制御・値判定・使用量集計を参照します。停止・記録などの共通処理をコピーせず再利用するための依存です。初回担当入力は固定A/BのGit blobから取得し、現在の通常implementをimport・再帰起動しません。runtimeは`container.ts`の本文を固定してread-onlyで渡すため、ホストのソース配置と隔離環境の`/runtime/container.ts`は別です。runnerのhashと未commit変更の検査は新配置、共通処理、package/lockfileを対象にします。

模擬テストは`bun run test:eval`、通常制御テストは`bun run test:control`です。両方とも既存のJUnit確認runnerを使い、0件・skip・失敗を成功にしません。総合`bun run check`は両方のテストと静的検査を含みます。合成課題の変更前コードを一律lintすることはせず、課題検証・参照解・反例による既存の確認を維持します。これは実モデル・実API・実Docker imageの稼働確認ではありません。

## 指示変更時の同条件eval

`scoping`・`implement`や、それらに適用する`AGENTS.md`を改善するとき、[Issue #191](https://github.com/thkt/dotagents/issues/191)の合意に従って、変更前後の行動・成果・負担を比べます。[Issue #335](https://github.com/thkt/dotagents/issues/335)により、下記の共通参照文書も明示して比較できます。入口は `bun eval/eval.ts plan|run CONFIG` と `report RUN_DIRECTORY [JUDGMENTS_JSON]` です。通常のdevelopment、定期監査、全PRのCIには接続しません。既存の証拠で判断できる変更には実モデル呼出しを追加しません。

[ケース](corpus/cases.json)は、[#183の公開コメント](https://github.com/thkt/dotagents/issues/183#issuecomment-5793406460)にある依頼文5件を再利用しています。実際の失敗の再現ではなく、公開済みの適用条件から作った正例2件・負例2件・採点外の境界1件です。ケースの依頼文の出典・期待ラベル・採点基準はホストだけが読みます。実装ケースの`context`には対象Issue本文の固定コピーだけを含め、選択時には文脈だけを`evaluation-issue.json`として渡し、その場所だけを依頼文に追記します。過去の中断runや他条件の回答は渡しません。この1ファイルは版管理する評価入力で、雛形や実行結果ではありません。実行結果は`outputDirectory`で指定したリポジトリ外へ保存します。統合後の評価では、新しい配置と内容を含むcommitを`corpusCommit`に指定します。ケースを追加・変更する場合は、実際の見落としの根拠と適用範囲をIssueへ残し、新旧集合を同条件の改善率にしません。

### 実行条件を固定する

実行ホストにはBun、Git、Dockerが必要です。Dockerのinternal bridgeで `gateway_mode_ipv4=isolated` を使えることが条件です。[Dockerの仕様](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)に従い、評価側にホストへのgatewayや外部へのdefault routeを置きません。未対応なら開始前の検査で止め、ネットワークを緩めて続行しません。通常ハーネスのmacOS登録を切り替える操作ではありません。

ホスト担当者は、認証情報・私的資料・追加スキル・起動hookを含まないLinuxのツール用imageを用意して内容を確認し、ローカルに存在するdigestを指定します。`/usr/local/bin/bun`、`codex`、`git`、`sh`、`sleep`、CA証明書が必要です。imageの既定環境変数とvolume宣言も検査します。実行中のpull・依存導入や、利用者のホーム・Docker socket・Git履歴のマウントは行いません。既存のimageやDocker daemon自体を敵対的な実装から守る仕組みではなく、ホストと確認済みimageを信頼境界とします。

設定例のcommit、image digest、実際のツール版、対象Issue/PR、保存先を置き換えます。対象・有限上限・送信先と公開範囲が改善作業の合意内であることを開始前に照合します。設定の存在だけを合意とは扱いません。範囲や上限を広げる場合は依頼者へ戻します。

```json
{
  "repository": "thkt/dotagents",
  "issue": "https://github.com/thkt/dotagents/issues/191",
  "before": "変更前の完全なcommit ID",
  "after": "変更後の完全なcommit ID",
  "corpusCommit": "ケースを保存した完全なcommit ID",
  "workspaceCommit": "両条件で共通に使う課題の完全なcommit ID",
  "workspaceFiles": ["package.json"],
  "instructionFiles": [
    "AGENTS.md",
    "skills/scoping/SKILL.md",
    "skills/implement/SKILL.md",
    "skills/references/documents.md",
    "docs/wiki/development-policy.md",
    "README.md",
    "scripts/README.md"
  ],
  "cases": ["requirements", "implementation", "question", "review", "ambiguous"],
  "image": "確認済みimage名@sha256:完全なdigest",
  "imageReview": "確認した作成元・版と、資格情報や追加の登録がないことの確認記録",
  "model": "利用するモデルID",
  "reasoning": "high",
  "cliVersion": "codex --versionの実出力",
  "bunVersion": "1.4.3",
  "gitVersion": "git --versionの実出力",
  "caseTimeMs": 300000,
  "totalTimeMs": 3000000,
  "maxModelRequestsPerCase": 30,
  "maxOutputTokens": 8000,
  "maxTrials": 10,
  "outputDirectory": "/absolute/path/outside-checkout/new-eval",
  "disclosure": {
    "inputs": "reviewed-public-committed-files-only",
    "raw": "local-only",
    "summary": "manual-issue-or-pr"
  }
}
```

ファイルリストは例であり、このままで各課題の参照が揃うことは保証しません。対象課題に必要な公開コード・検証・固定する参考資料を `workspaceFiles` に、判断へ適用する指示を `instructionFiles` に列挙します。指示側の許可範囲は次のとおりです。許可される場所でも、公開可能な指示であることを担当者が確認します。

- 各階層の `AGENTS.md` と `skills/scoping/`・`skills/implement/` 配下。
- `skills/references/` 配下の `.md` 文書。
- `README.md`、`scripts/README.md`、`docs/wiki/development-policy.md` の3文書。`docs/` 全体や任意のwikiは許可しません。

ルートの `AGENTS.md` と両スキルの `SKILL.md` は必須です。そのほかも、今回適用する `AGENTS.md`、スキル内の参照、共通指示を明示します。課題の実装コードやホスト用の期待値を指示側へ移さないでください。許可範囲外の文書を比較する必要があれば、入力制限の変更を別途レビューし、`workspaceFiles` への移動で代用しません。

UTF-8の通常Git blobだけを使い、symlink、作業差分、未追跡資料、評価の期待値は入力にしません。`eval/`のうち課題入力の`eval/fixtures/workspace/`以外、旧`scripts/eval/`、ルートの `evals/`・`.git/`・`.agents/`、認証・ローカル設定の拒否は両リストへ適用します。パス検査は内容の秘密情報や採点情報を判別しないため、公開範囲の内容確認も必要です。両リストの重複、未知のケース、有限上限や公開範囲の欠落を拒否します。課題側は共通commit、指示側だけはbefore/afterから取得します。共通参照だけの変更でも、その内容・SHA-256・`changedInstructions` に差が現れます。対象commitに他のコード差分があっても、その差分を課題側へ混ぜません。指定した指示に差がなければモデルを起動しません。

```sh
bun eval/eval.ts plan /absolute/path/eval-config.json
bun eval/eval.ts run /absolute/path/eval-config.json
bun eval/eval.ts report /absolute/path/outside-checkout/new-eval
```

`plan` はモデルを呼ばず、入力内容、各ファイルと固定した実行コードのSHA-256、変えた指示、ケース・判定基準を表示します。各版の `missingReferences` は、選択済みの指示にある相対インラインMarkdownリンクのうち、その版の入力にない参照先を `source`・`target` で示します。参照先の取得や全repoの走査はせず、任意の参考リンクも含むため自動停止条件にはしません。空白・括弧を含むリンク先、参照形式のリンク、コード表記のパス、外部URLやアンカーの有効性は検査しません。リストが空でも必要な参照が揃う保証にはなりません。

担当者は `run` の前に `plan` の両版を読み、次を確認します。

1. 入力の本文が公開可能で、秘密情報・ホスト用の期待値・過去runを含まないこと。
2. 指示本文から今回必要な参照を辿り、`missingReferences` と検査対象外の表記も確認すること。不足を必要性に応じてリストへ追加し、再度 `plan` を確認すること。リンク先が存在しても、適用条件や内容が十分とは限りません。
3. 変更する共通指示が `instructionFiles` にあり、両版の本文・hashと `changedInstructions` が意図した比較を表すこと。固定する課題側は両版で同じ本文・hashであること。

`run` は同じ計画を保存し、ケース・時間・モデル要求数・公開範囲を表示してから、beforeの全ケース、afterの全ケースを各1回実行します。ケースの順序と集合は両条件で同じです。モデルには現在のケースの依頼文と入力ファイルだけが見えます。スキルは新しいコンテナーのホームから、その条件の実体へ登録します。既存の登録や進行中タスクは変更しません。

### 8課題の行動比較を準備する（#393）

[#393](https://github.com/thkt/dotagents/issues/393)の準備変更は、実モデル比較の実行許可を含みません。モデルを使わずに入力・有限上限・経路を確認し、実行コード、corpus、workspaceを共有済みcommitへ固定してから、依頼者の別の実行指示を受けます。現在の準備を実モデルの行動改善、APIの利用可能性、imageの実稼働確認として報告しません。

追加した課題は公開の合成例です。実際に観測した失敗の再現でも、全工程の網羅でもありません。既存5課題はそのまま残し、追加8課題と混在させません。モデルへは現在の依頼と通常の仕様・コード・独立検証・合成履歴だけを渡します。下表のC番号、criteria、Issue #393本文、対照の分類、他条件の回答、ホストの参照解・反例は渡しません。

| ホスト用ID | corpusのID | 担当 | 事前の順序 |
| --- | --- | --- | --- |
| C01 | `storage-fields` | scoping、下書きまで | A→B |
| C02 | `completion-message` | 初回実装 | B→A |
| C03 | `retry-limit` | scoping、下書きまで | A→B |
| C04 | `guide-link` | 初回実装 | B→A |
| C05 | `work-area` | 初回実装 | A→B |
| C06 | `cli-description` | scoping、下書きまで | B→A |
| C07 | `history-record` | scoping、下書きまで | A→B |
| C08 | `save-diagnostics` | 初回実装 | B→A |

`cases`はこの8件だけ、`maxTrials`は16です。`trialOrder`へ、表の順に各組の`before-ID`と`after-ID`を並べた16要素を明示します。重複・欠落・別課題・組の分離と、A先行/B先行が4組ずつでない計画を拒否します。`trialOrder`のない旧ケースの既定順序は、従来のA全件→B全件です。

指示版はA=`fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092`、B=`6181233d17a29c711a84f20549f78507c5c3e5fb`に固定します。`premise-validation.md`、`caller-first-design.md`、`mechanization.md`はAの`ls-tree`で不存在を確認し、`absentInstructions`へ対象commitと由来を残します。空ファイルを作ったりBから補ったりしません。Bでの不存在、他の必須資料の欠落、取得失敗、symlinkは拒否します。

`workspaceFiles`には、独立テスト担当が用意した`eval/fixtures/workspace/`の通常Git blobをファイルごとに明示します。`specs.md`、README、`docs/`、`data/`、`src/`、`tests/`を同じworkspace commitから取り、両条件で同じ本文・hashを使います。`eval/tests/task-fixtures.test.ts`の参照解・反例はホスト用であり、入力に指定できません。課題用の検証資産を実装モデルが変更することは許可しません。不足はfindingsへ戻します。

共通workspaceへの`scripts/implement/`配下のTSの指定も拒否します。担当指示を含む信頼版コードを課題側へ移して、指示比較を迂回することを防ぎます。担当入力の生成元は、固定した指示版から別途取得します。

`instructionFiles`にはAGENTS、README、CLIガイド、開発方針、両SKILL、scopingの4参照（sufficiency・experiment・session・issue）、testing参照、共通の5参照（documents・natural-japanese・premise-validation・caller-first-design・mechanization）を指定します。共通文書から必要になる場合は`skills/templates/wiki.md`と`skills/templates/decision.md`も指定できます。必要な参照の判断は本文と用途へ照合し、ファイル存在や`missingReferences`だけで十分としません。任意のTSを指示として許可しません。

初回実装の4件は、[入力生成](initial-input.ts)が上記の固定commitにある`orchestrator.ts`の初回prompt式と`repair.ts`の`repairInstructions`を使います。対象workspaceの同名TS、別版、手書きの類似promptでは代用しません。通常CLIを再帰起動せず、`repair`役割・`initial`工程の担当単位で起動します。`codex-actor.ts`のrepair応答schemaを起動へ接続し、固定版の役割・起動設定の出典もplanに残します。絶対参照は隔離環境の`/work/repo/skills/`へ解決し、ホストのパスを持ち込みません。

`actorInputs`には実際のprompt本文とhash、repair指示本文とhash、出典の本文とhash、必要な参照、応答schema、起動設定、共通の評価条件への変更を保存します。setupなし・課題別check・captureなしの契約と、独立準備記録を両条件に渡します。準備記録は、その試行の修正前・修正後の成功を主張しません。A/Bのpromptはrepair指示を除く部分と応答schemaが同じか照合します。配置によるパスの差を行動指示の差と数えません。`runner`は実行コードのcommit、未commit変更の有無とソースhashを記録します。初回担当を含むrunは、runner・共通実装・package/lockfileに未commit変更があれば起動を拒否します。モデル起動前に共有版と、同じcorpus/workspaceのcommit・hashを確定してください。

初回の推奨値は`gpt-6.1-sol` / `medium`、`caseTimeMs: 600000`、`totalTimeMs: 9600000`、`maxModelRequestsPerCase: 20`、`maxOutputTokens: 8000`です。この8件の計画では推奨時間・要求数・出力を上限として検査します。全体時間は計画の保存後から、待機・停止処理も含めて共有します。最大320要求、成功までの再試行0で、要求数は金額や合計tokenの保証ではありません。終了確認の既存猶予は1件最大65秒、16件で追加最大17分20秒です。準備と手動裁定は別に記録します。

probeはactorと同じ固定環境で子CLI・Bun・Gitの版を観測し、入口Bunと子Bunの一致も確認します。これは任意の測定コマンドの版を証明するものではなく、その実出力も照合します。実行時に、利用可能なモデル・API利用と資格情報、Bun 1.4.3を含む実効CLI/Bun/Git版、確認済みdigest固定imageと事前導入した依存、checkout外の新しい保存先、公開先・費用・送信範囲を別途確定します。未確定のimageや版を仮の実測値として保存しません。送信先は既存中継の`https://api.openai.com/v1/responses`、rawはlocal-only、summaryは合意したIssue/PRへ手動共有です。ChatGPTログインの認証は流用しません。

裁定は既存のcriteria・reasonと、その試行のファイル・内容hash・行範囲を使います。条件名を表示しない成果物と完全な行動記録を裁定者へ渡し、ホストは原記録との対応を保持します。指示内容から条件を推測できるため、完全な盲検とは呼びません。発見・参照だけで適用成功にせず、判断・操作・成果物がどう変わったかを確認します。C05の順序は時系列の操作記録で判定し、非公開の思考を推測しません。

必要な行動の確認、見落とし・不適切な適用、記録不足を理由と証拠で区別します。不要な調査・規則・承認待ちと、適切な見送りも区別します。初回担当の4件はスキル選択の採点外とし、全16試行の実行状態と`fulfilled` / `unfulfilled` / `indeterminate`を別に集計します。各課題の改善・悪化・差が確認できない理由を残し、失敗・時間切れ・採点不能を分母から消しません。モデル終了0、スキル選択、検証件数を要求充足へ変換しません。課題・検証・基準・ログの不足も原因候補に含めます。

実行と採点の費用、取得できた使用量・ツール操作を分け、未取得の子モデル使用量や請求額をゼロにしません。両条件の成功だけで改善とせず、少数例から一般的な精度・安定性・費用改善、4件それぞれの独立した寄与、通常implement全体の効果を断定しません。新しい採点基盤・総合点・定期実行は追加しません。

### 隔離・上限・停止

ホストの `OPENAI_API_KEY` はモデル中継コンテナーだけへ渡します。評価側にはAPI key・gh認証・ホスト環境を渡しません。中継は隔離網側だけで待ち受け、固定の `https://api.openai.com/v1/responses` へPOSTする機能だけを持ちます。URL・認証・任意headerの転送、redirect、ホストされた検索等のremote toolを許さず、モデル・推論設定・出力上限を固定します。通常のChatGPTログインの認証ファイルを流用する経路はありません。API利用条件が今回の合意に含まれなければ `run` を開始しません。

評価側は非root、read-onlyのroot、権限昇格禁止、capabilityなし、独立したPID/network namespaceで動きます。書込みは容量上限のある `/work` と `/tmp` に限り、入力と実行コードのマウントはread-onlyです。モデル起動前にimage・network・実コンテナーの設定、rootと入力への書込み拒否、default routeの不在、モデル専用中継、実際のCLI/Bun/Git版を確認します。分離した子プロセスを起動するprobeが終了し、PID namespaceが停止したことも確認します。確認失敗は `unevaluated` と理由を残し、その試行のモデルを起動しません。

子CLIが中継を使っても、ケース内で共有する `maxModelRequestsPerCase` を超える要求は拒否します。並列要求も同じ上限です。CLIのHTTP・stream再試行を0にし、中継も同一要求の再送とprovider失敗後の続行を拒否します。[Codexの接続設定](https://developers.openai.com/codex/config-reference)を使いますが、固定版CLIと選んだモデルがこの設定で動くかは実試行で確認します。モデル・ツールの終了0は要求充足の判定ではありません。

`totalTimeMs` は計画の読取り・保存後から全ケースに共有する予算、`caseTimeMs` はケースの隔離準備とモデル実行の上限です。終了確認のため、モデル時間の外に各試行最大65秒（使用量取得5秒、コンテナー削除30秒、network削除30秒）の有限猶予があります。新規モデル起動は期限後に行いません。コンテナー内部にも同じ絶対期限を渡し、ホストが停止しても期限でPID 1を終了させます。モデル出力は16MiBを超えると停止します。成果物は1ファイル1MiB・合計8MiB・2000ファイルまで取得し、symlinkは取得不能として示します。`.git`・`node_modules`は含めません。取得失敗・時間切れの成果物不足を成功としません。

SIGINT/SIGTERM・失敗・期限で所有するコンテナーとnetworkを削除し、結果を保存します。終了確認に失敗したら後続試行は未評価で止めます。SIGKILL・Docker daemon停止等でホストの最終記録が欠けた場合は、`containers.json` の自分の資源だけをホストで照合し、停止・証拠を確認してください。停止runを再開・上書きせず、成功まで自動再試行しません。新しい保存先でも旧runの停止理由や合意上限を迂回しません。

### 判定と関係者への報告

`evaluation.json` は計画・各試行・実時間・取得できた中継要求数・実効ツール版・停止と終了確認の記録です。`plan.json` で入力とファイル版へ戻れます。各試行の `actor.stdout`（JSONLと取得できた成果物）、`actor.stderr`、`probe.stdout`、`safety.json` を保持します。これらは私的なローカル証拠です。モデル出力に含まれるコード・パス・命令をホストで実行せず、同じ試行の根拠として読みます。

ホストの独立した判定では、スキル本文を取得した箇所と用途に沿う行動を別々に参照します。言及・部分検索・資料としての読取りだけで選択としません。非選択は完全な行動記録で判断し、欠落があれば `unknown`。成果は各ケースの基準と成果物・検証を照合して `fulfilled` / `unfulfilled` / `indeterminate` とします。境界例は選択の正誤の分母から除きますが、成果と費用には残します。API・GitHub・依存導入が使えない実装ケースでは、ローカルの本文を渡しただけで#187の要求充足を保証せず、不足を判定不能として残します。

裁定を保存するJSONの例です。参照は同じ試行のファイル名、SHA-256、1始まりの行範囲です。各ケースについて基準を適用した理由を記し、使わない参照配列は空にします。`both` は両スキルそれぞれの取得・適用を参照します。成果判断には `evidence`、非選択には `completeTrace` が必要です。参照の一致検査は意味判断の正しさを保証しません。

```json
{
  "evaluationSha256": "evaluation.jsonのSHA-256",
  "conclusion": "indeterminate",
  "reason": "観測した差と、判断できない理由",
  "nextDecision": "依頼者が次に判断すること。採用・マージは人が行う",
  "conditionDifferences": [],
  "trials": [{
    "trial": "before-requirements",
    "selection": "scoping",
    "bodyReads": [{"file": "actor.stdout", "sha256": "同じ試行のSHA-256", "lines": [1, 2]}],
    "applications": [{"file": "actor.stdout", "sha256": "同じ試行のSHA-256", "lines": [3, 4]}],
    "completeTrace": [],
    "outcome": "indeterminate",
    "evidence": [],
    "reason": "本文取得と要求整理を確認。成果判断に必要な記録は不足"
  }]
}
```

`report` は裁定なしでも `comparison.md` を生成し、全件を選択不明・成果判定不能にします。裁定JSONを渡すと、同じrun内にその版を `judgments-*.json` として保存し、その内容のhashを付けた別の `comparison-*.md` を生成します。既存ファイルを上書きしません。原記録が変わった場合は裁定も同じ版から更新し、旧裁定・旧表を保全します。異なる条件や実行失敗を含む比較は `indeterminate` とし、選択と成果をまとめた改善率を生成しません。

関係するIssue/PRには、確認した版・指示差分・条件差、ケースごとの行動・成果・安全条件、分母・試行数・再試行0・実時間・取得使用量、結論と次の判断を短い表と説明で残します。`improved` / `worsened` / `indeterminate` は今回の観測に限る結論です。少数例の差を安定した効果へ一般化しません。子モデル・欠落イベント・請求額をゼロとせず未確認とし、準備と採点の費用は実行費用と分けます。

公開担当は、生成表からローカルの生ログへのリンクを外し、合意した公開先に置いた非機密の根拠へのリンクに置き換えます。私的ログ・個人パス・認証情報は公開しません。依頼者には改善・悪化・判定不能と理由、次の判断を伝えます。CLIは投稿・採用・マージを行いません。通常のimplement runがあれば[#177のreport.html](https://github.com/thkt/dotagents/issues/177)へローカルで辿れますが、選択evalを `result.json` に変換せず、[#149のケースHTML](https://github.com/thkt/dotagents/issues/149)も流用しません。

同条件比較と少数例の限界には[#171](https://github.com/thkt/dotagents/issues/171)と[開発方針](../docs/wiki/development-policy.md#改善効果の比較)を適用します。#183の当時の選択成功、#171の候補採用保留、#177/#149の表示結果は、この入口の実モデル成功や安全確認の証拠にはしません。共通checkは模擬Docker・模擬providerで制御を確認します。実Dockerの隔離確認と実モデルの意味判断、GitHub公開は別の結果です。

