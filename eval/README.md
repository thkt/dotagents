# 指示変更の比較eval

比較eval専用の実行コード・corpus・合成課題・模擬テストと操作説明を、このディレクトリにまとめています。通常ハーネスの実行経路からevalを起動・importしません。

## 配置と入口の移行

| 対象 | 現在の配置 | 旧配置 |
| --- | --- | --- |
| 実行コード | `eval/*.ts` | `scripts/eval/*.ts` |
| 課題・採点基準 | `eval/corpus/` | `scripts/eval/corpus/` |
| 合成課題workspace | `eval/fixtures/workspace/` | `fixtures/workspace/` |
| 模擬テストとホスト用資料 | `eval/tests/` | `scripts/tests/eval/` |

repoルートから`bun eval/eval.ts plan|preflight|run CONFIG`、`bun eval/eval.ts report RUN_DIRECTORY [JUDGMENTS_JSON]`を使います。旧入口`bun scripts/eval/eval.ts ...`は残していません。新配置を含むcommitへ固定し、設定の`workspaceFiles`も新配置へ更新してください。Issueでcorpus・workspaceのcommitを固定している場合は、そのIDを維持し、変更後のrunnerを別に固定します。固定A/Bの指示commitと指示側のパスは変更しません。過去runは上書き・再開せず、歴史資料と固定A/Bの検証snapshotも書き換えません。

課題ファイルはrepo相対パスを保って隔離環境の`/work/repo/eval/fixtures/workspace/`へ配置します。新配置のcorpusにある依頼文・checkと同じパスになり、両条件で同じ本文・hashを使います。ホスト用のcorpus・テスト・採点情報は転送しません。

`eval`から`../scripts/shared/`のプロセス制御・値判定・使用量集計を参照します。停止・記録などの共通処理をコピーせず再利用するための依存です。初回担当入力は固定A/BのGit blobから取得し、現在の通常implementをimport・再帰起動しません。runtimeは`container.ts`の本文を固定してread-onlyで渡すため、ホストのソース配置と隔離環境の`/runtime/container.ts`は別です。runnerのhashと未commit変更の検査は新配置、共通処理、package/lockfileを対象にします。

模擬テストは`bun run test:eval`、通常制御テストは`bun run test:control`です。両方とも既存のJUnit確認runnerを使い、0件・skip・失敗を成功にしません。総合`bun run check`は両方のテストと静的検査を含みます。合成課題の変更前コードを一律lintすることはせず、課題検証・参照解・反例による既存の確認を維持します。これは実モデル・実API・実Docker imageの稼働確認ではありません。

## 指示変更時の同条件eval

`scoping`・`implement`や、それらに適用する`AGENTS.md`を改善するとき、[Issue #191](https://github.com/thkt/dotagents/issues/191)の合意に従って、変更前後の行動・成果・負担を比べます。[Issue #335](https://github.com/thkt/dotagents/issues/335)により、下記の共通参照文書も明示して比較できます。入口は `bun eval/eval.ts plan|preflight|run CONFIG` と `report RUN_DIRECTORY [JUDGMENTS_JSON]` です。通常のdevelopment、定期監査、全PRのCIには接続しません。既存の証拠で判断できる変更には実モデル呼出しを追加しません。

[ケース](corpus/cases.json)は、[#183の公開コメント](https://github.com/thkt/dotagents/issues/183#issuecomment-5793406460)にある依頼文5件を再利用しています。実際の失敗の再現ではなく、公開済みの適用条件から作った正例2件・負例2件・採点外の境界1件です。ケースの依頼文の出典・期待ラベル・採点基準はホストだけが読みます。実装ケースの`context`には対象Issue本文の固定コピーだけを含め、選択時には文脈だけを`evaluation-issue.json`として渡し、その場所だけを依頼文に追記します。過去の中断runや他条件の回答は渡しません。この1ファイルは版管理する評価入力で、雛形や実行結果ではありません。実行結果は`outputDirectory`で指定したリポジトリ外へ保存します。統合後の評価では、新しい配置と内容を含むcommitを`corpusCommit`に指定します。ケースを追加・変更する場合は、実際の見落としの根拠と適用範囲をIssueへ残し、新旧集合を同条件の改善率にしません。

### 実行条件を固定する

実行ホストにはBun、Git、Dockerが必要です。Dockerのinternal bridgeで `gateway_mode_ipv4=isolated` を使えることが条件です。[Dockerの仕様](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)に従い、評価側にホストへのgatewayや外部へのdefault routeを置きません。未対応なら開始前の検査で止め、ネットワークを緩めて続行しません。通常ハーネスのmacOS登録を切り替える操作ではありません。

ホスト担当者は、認証情報・私的資料・追加スキル・起動hookを含まないLinuxのツール用imageを用意して内容を確認し、ローカルに存在するdigestを指定します。`/usr/local/bin/bun`、`codex`、`git`、`sh`、`sleep`、CA証明書が必要です。imageの既定環境変数とvolume宣言も検査します。実行中のpull・依存導入や、利用者のホーム・Docker socket・Git履歴のマウントは行いません。既存のimageやDocker daemon自体を敵対的な実装から守る仕組みではなく、ホストと確認済みimageを信頼境界とします。

Linux arm64の採用候補には[image.Dockerfile](image.Dockerfile)を使えます。build contextには、公式配布のBun実体を`bun`、Codexの`package/vendor/aarch64-unknown-linux-musl/`の内容を`codex-vendor/`として置きます。CLIの本体だけを抜き出さず、同梱のcode実行用プログラムや`rg`も含めます。ホストのホーム・設定・登録スキルをbuild contextへ入れません。

| 固定した配布物 | 入手先と照合値 |
| --- | --- |
| Bun 1.4.3 Linux arm64 | [公式zip](https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-aarch64.zip)、SHA-256: `efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21` |
| Codex 0.163.0 Linux arm64 | [公式npm配布物](https://registry.npmjs.org/@openai/codex/-/codex-0.163.0-linux-arm64.tgz)、SHA-512 SRI: `sha512-IH2/R+4OarjGvsAf1ll3fdyLwrPgYLl3uzp6u9CyD9sj2Lw+ViDSe3QBZVHdcHJs0eIiZFg6Wprcuy4CRZaUGw==` |

照合したcontextから`docker build --platform linux/arm64 -f eval/image.Dockerfile -t dotagents/eval:cli01630 CONTEXT`で作成します。タグやimage IDを設定のmanifest digestに代用せず、使用するregistryでdigestを確定し、ローカルに存在する参照を指定してください。外部registryへの公開は別の権限を要します。今回の準備ではホスト内のregistryだけを使っています。build時のOS package取得は将来同じ版になる保証がないため、Git等の実効版・image内容・digestを再照合し、新しいimageのpreflightを行います。Dockerfileの一致だけで、過去のimageと同一とは扱いません。

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
  "preflightDirectory": "/absolute/path/outside-checkout/completed-preflight",
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
bun eval/eval.ts preflight /absolute/path/preflight-config.json
bun eval/eval.ts run /absolute/path/eval-config.json
bun eval/eval.ts report /absolute/path/outside-checkout/new-eval
```

`plan` はモデルを呼ばず、入力内容、各ファイルと固定した実行コードのSHA-256、変えた指示、ケース・判定基準を表示します。各版の `missingReferences` は、選択済みの指示にある相対インラインMarkdownリンクのうち、その版の入力にない参照先を `source`・`target` で示します。参照先の取得や全repoの走査はせず、任意の参考リンクも含むため自動停止条件にはしません。空白・括弧を含むリンク先、参照形式のリンク、コード表記のパス、外部URLやアンカーの有効性は検査しません。リストが空でも必要な参照が揃う保証にはなりません。

担当者は `run` の前に `plan` の両版を読み、次を確認します。

1. 入力の本文が公開可能で、秘密情報・ホスト用の期待値・過去runを含まないこと。
2. 指示本文から今回必要な参照を辿り、`missingReferences` と検査対象外の表記も確認すること。不足を必要性に応じてリストへ追加し、再度 `plan` を確認すること。リンク先が存在しても、適用条件や内容が十分とは限りません。
3. 変更する共通指示が `instructionFiles` にあり、両版の本文・hashと `changedInstructions` が意図した比較を表すこと。固定する課題側は両版で同じ本文・hashであること。

`run` は同じ計画を保存し、ケース・時間・モデル要求数・公開範囲を表示してから、beforeの全ケース、afterの全ケースを各1回実行します。ケースの順序と集合は両条件で同じです。モデルには現在のケースの依頼文と入力ファイルだけが見えます。スキルは新しいコンテナーのホームから、その条件の実体へ登録します。既存の登録や進行中タスクは変更しません。

### モデルなしの互換性確認（#401）

[#401](https://github.com/thkt/dotagents/issues/401)の2026年10月17日の合意に基づき、evalだけの隔離境界を外側のDockerへ集約します。通常repair／reviewのsandboxは変更しません。固定A/Bのpromptと過去の出典を保ち、`actorInputs.sourceLaunch`に元の`workspace-write`等を、`launch`とplanの`effectiveLaunch`にevalの`danger-full-access`・承認`never`等を分けて記録します。内側のworkspace境界は失います。`/work/repo`だけでなく、試行用HOMEと設定・スキル登録を含む`/work`、`/tmp`へ書けます。各試行で空の一時領域を作り、終了時に破棄します。過去方式と同条件の結果、通常のworkspace-writeへの安全性・行動の一般化として報告しません。

`plan` → `preflight` → image・版・hash・実効条件の照合 → API・費用・範囲の別判断 → 明示指示後の`run`の順に進めます。preflight成功は実モデル起動の許可ではありません。`preflight`の`outputDirectory`はcheckout外の新規保存先にします。後日の`run`には別の新規`outputDirectory`と、成功した保存先の`preflightDirectory`を指定します。`run`は出力先・証拠参照先を除く設定、入力hash、runnerのソースhash、実効条件、合成応答資産のhashを照合し、各試行でも外側と版を再確認します。過去の成功ファイルが存在するだけでは進みません。

本番gatewayは固定Responses endpointへ送る専用実装のままです。preflightは別の`preflight-container.ts`を外部bridgeへ接続せずに起動し、APIキーを渡しません。本番と同じ要求検査、CLI引数、コンテナー引数、probeとcleanupを使い、固定SSEだけを返します。新形式のnamespaceとローカルfunction／custom宣言、呼出し・結果は構造を保持します。未知の制御・フィールド、remote tool、保存参照、外部grammarとSchema参照は拒否します。説明・コード文字列のURLやSchemaのプロパティ名は、外部参照と同一視しません。[公開の最小宣言](tests/local-tools.fixture.ts)はIssueから作った合成入力であり、実CLI採取原本ではありません。

呼出し先は同じ要求内の宣言位置に依存せず照合します。後方に宣言があっても、未宣言・型不一致の宛先を許可しません。宣言を持たない既存のinline履歴は維持します。`call_id`は要求全体で一意とし、結果が完了したIDも再使用を拒否します。Schemaの`dependencies`も、プロパティ名の配列とSchemaを区別し、後者に入れた外部参照を拒否します。プロパティ名・`const`等のデータは、参照制御として検査しません。

ホストはgateway・probe・actorを起動前にinspectします。image名と実体ID、user、readonly root、capability、NoNewPrivs、PID／network、readonly mount、memory 2g・CPU 2・pids 64、`/work` 256MiB・`/tmp` 64MiB、ログの`local`・10m・1ファイル・`compress=false`を照合します。actor／probe／模擬gatewayのDNS上流はコンテナー自身のloopbackに固定し、Dockerの名前解決から外部へ転送する経路も閉じます。gatewayのalias解決とDNS拒否の実動作はホスト検証対象です。actor内でもPID 1・UID/GID 1000、権限、readonly mount、書込み拒否、default route不在と版を確認してからCLIを起動します。不一致時のホスト直接実行、sandbox方式の自動fallback、権限拡大はありません。

preflightの7シナリオはscoping、初回実装、境界操作、既知のコマンド失敗、marker欠落、期限、ホスト割込みです。1件120秒・最大4要求・全体20分・再試行0で、開始前に一覧を出力します。使用量・ログ観測は計5秒以内、コンテナーとnetwork削除は各30秒以内で、終了確認の猶予は1件最大65秒です。CLI終了0に加え、要求・結果の到達、終了イベント、marker・成果物本文、初回repairの応答契約を照合します。負の対照は期待した失敗を検出できることを確認し、期限・割込みでは終了と削除を観測します。失敗・終了不明・資産不足では理由を保存して後続を止めます。分離した子プロセスの停止はPID namespaceとprobeでも確認します。

固定応答と期待値は独立テスト担当の`eval/tests/preflight.json`から読みます。`preflight.ts`の`scenarioSchema`が読取り形式です。公開の合成入力・固定SSEと要求内の結果照合、markerと成果物、初回repairのschemaを含めます。境界ケースには合成canary、許可されたHOMEへの書込みと禁止mountへの書込み拒否、直接IP・hostname・Docker DNS・host側・link-local・別のモデル／公開endpoint・子経路の正常／拒否操作を含め、外部の実サービス・秘密情報を試験しません。`host-canary`は試行ディレクトリに作り、actorへmountしません。応答を成功まで変える探索は行いません。

#### preflight資産の接続契約

`eval/tests/preflight.json`は7シナリオの配列です。各要素は次の項目を持ち、未知の項目は受け付けません。これは資産の接続形式であり、期待結果は#401の保証から独立テスト担当が定めます。

| 項目 | 形式と接続先 |
| --- | --- |
| `id` | `scoping`・`initial`・`boundaries`・`command-failure`・`missing-marker`・`timeout`・`interrupt`を1件ずつ |
| `prompt` | CLIへ渡す合成依頼文の文字列 |
| `responseSchema` | 任意のJSON Schemaオブジェクト。`initial`には通常repairの`status`・`findings`の応答契約を指定 |
| `steps` | 1〜4件。各要素は`requestIncludes: string[]`と`sse: string`。検査済み要求の本文に必要な文字列を照合し、その回の固定SSEを返す |
| `files` | 正規の相対パスから合成本文へのmap。readonly入力から試行workspaceへコピーする |
| `marker` | 次要求のローカルツール結果で確認する非空文字列。呼出しコードや最終返答に書かれただけでは成功にしない |
| `artifact`・`artifactText` | workspace相対の成果物パスと、期待する本文。正常経路ではsnapshotと照合する |
| `runtimeArtifact` | 操作Bun自身が版・実体を記録するJSONファイルのworkspace相対パス。入力には事前配置しない |
| `networkCanary` | `boundaries`だけに指定する合成待受けの`path`・`body`。実URLはホストが生成する |
| `expectedRejected` | 1〜16の整数、既定1。共通probeと固定操作で予定した中継拒否の合計 |

`timeout`と`interrupt`は入力に含めていない`artifact`と`runtimeArtifact`を固定操作で生成し、その後も処理を継続する。ホストは稼働中のactorで成果物本文と操作Bunの観測を読み、`operation-observation.json`へ保存する。`interrupt`はその後にSIGINTを送り、`timeout`は自然な期限まで待つ。要求到達・起動試行だけを操作開始の証拠にせず、未開始の期限切れを拒否する。`command-failure`は既知の非0終了、`missing-marker`は他の必要条件を満たした上でmarker欠落を観測する。通常の実比較の非0終了の裁定は変更しない。

採用候補CLI 0.163.0の観測済み最小構造では、ローカルcode実行は`namespace: functions`の`custom`宣言`exec`を使い、inline JavaScriptから`tools.exec_command`等を呼ぶ。新形式の宣言・呼出し・結果を保つ。要求の`client_metadata`は観測済みの7キー（`x-codex-installation-id`・`x-codex-turn-metadata`・`turn_id`・`x-codex-window-id`・`session_id`・`root_turn_id`・`thread_id`）の文字列値だけ、`reasoning.context`は未指定または`all_turns`だけを受け付ける。これらの観測は新しいAPI機能全般の許可ではない。fixtureの識別子や本文には公開の合成値を使い、生ログをコピーしない。

模擬実行で`preflightDirectory`を接続する場合も、存在するファイルだけでは通らない。`preflight.json`は`error: null`、7シナリオそれぞれの`status: passed`、`manifest.modelFree: true`と一致する識別値を必要とする。`manifest.identity`は、planから`outputDirectory`と`preflightDirectory`を除いたconfig、runnerの`sourceHashes`、`effectiveLaunch`、各variantの`versions`、`corpusHash`を、順に`config`・`sources`・`launch`・`inputs`・`corpus`へ入れたオブジェクトの`JSON.stringify`に対するSHA-256である。`manifest.fixtureSha256`も現在の資産本文と照合する。模擬の証拠は実Docker・実CLIの受入結果には使わない。

証拠ファイルの最小構造は次のとおり。`records`の要素は`id`ではなく`scenario`を持つ。hashの仮表記を実測値へ置き換える必要があり、この合成例は成功の証拠ではない。

```json
{
  "manifest": {
    "identity": "現在のplanから求めたSHA-256",
    "modelFree": true,
    "fixtureSha256": "現在のpreflight.json資産本文のSHA-256"
  },
  "error": null,
  "records": [
    { "scenario": "scoping", "status": "passed" },
    { "scenario": "initial", "status": "passed" },
    { "scenario": "boundaries", "status": "passed" },
    { "scenario": "command-failure", "status": "passed" },
    { "scenario": "missing-marker", "status": "passed" },
    { "scenario": "timeout", "status": "passed" },
    { "scenario": "interrupt", "status": "passed" }
  ]
}
```

固定SSEのツール層では、`functions.exec`の既定値は30秒での途中応答であり、コマンドの終了とは別である。採取した宣言の接続契約では、inline JavaScriptの先頭に`// @exec: {"yield_time_ms": 120000}`の形式で途中応答までの待機を指定できる。`tools.exec_command`も`yield_time_ms`内に終了しなければ`session_id`を返す。必要な操作が終わる前に最終SSEへ進まず、`tools.write_stdin`等で同じ処理の完了を観測する。これは失敗した操作の再実行ではない。期限・割込みケースでは、意図した停止より先に途中応答を返して別要求へ進まない条件を揃える。

採取した`tools.exec_command`の宣言では、待機の実効範囲は250〜30000msである。120000msと指定しただけでは120秒待てると仮定しない。`tools.write_stdin`の空入力による継続待機は5000〜300000msの範囲であり、終了したら`exit_code`、継続中なら`session_id`を返す。期限・割込みケースもこの契約で同じ処理を待つ。scoping・initialの固定操作には、既存の合成ファイルの読取りと変更、その変更の読戻し、新しい成果物の作成を含める。境界操作では、親と利用する子経路で合成通信先への拒否も確認する。

中継の`requests`は検査を通って模擬応答へ到達した件数である。共通probeの`GET /github`は拒否1件を記録する。通常はこの1件、現在の`boundaries`は親子による禁止path・別モデル要求の4件を加えた計5件を`expectedRejected`で照合する。完了するシナリオは固定SSE件数と一致する`requests`と`failed: false`を必要とし、予期しない拒否や追加要求を無視しない。

操作自身の観測は`runtimeArtifact`のJSON配列へ、`role: operation`・`bunVersion`・`execPath`・`realPath`として保存する。`boundaries`は実際の子Bunによる`role: child`の観測も必要とする。設定したBun版とimage内の`/usr/local/bin/bun`の実体へ照合し、親actorの`eval.runtime`やコマンド文字列だけでは代用しない。通常終了はartifact snapshotから、期限・割込みは生存中の読取り記録から確認する。秘密値やPATH全文は記録しない。

通信の正常対照は、評価網とは別のinternal bridgeに置く`preflight-canary`と`preflight-control`で行う。両網とも`gateway_mode_ipv4=isolated`を使い、外部bridge・公開port・資格情報を追加しない。新しい2役も同じimage・UID・readonly・権限・資源・ログ上限を使い、CLIは起動しない。待受けは8081の固定pathへのGETに公開の合成本文だけを返し、転送機能を持たない。正常対照はactorの前後で、同じ直接IPとDocker DNSのURLへ200・本文一致を確認する。評価側の親子操作は同じ宛先への到達拒否を確認する。`network-canary.json`、対照のstdout/stderrとinspectを保存し、待受け不在だけで通信隔離を成功としない。従来の合成host/link-local宛先への接続失敗、実効route・DNS、模擬gatewayの公開path・別モデル拒否は、それぞれの保証と区別して記録する。

#### 模擬接続で使うruntimeとinspect

利用者が渡すのはCONFIGだけであり、次のruntimeファイルはrunnerが生成する。独立テストで内部の接続を模擬するときは、同じ版のこの契約へ照合する。actor用`/runtime/settings.json`は`model`・`reasoning`・`prompt`・`cliVersion`・`bunVersion`・`gitVersion`を文字列、`maxRequests`・`maxOutputTokens`・`expiresAt`を数値として持つ。`expiresAt`は将来の有限のUNIX時刻（ミリ秒）である。`responseSchema`は初回実装だけの任意オブジェクトで、`gatewayAddress`には生成した隔離網のIPv4をホストが設定する。通信対照では、生成した直接IP・`canary` aliasのURLと合成本文を`networkCanary: {ipUrl, dnsUrl, body}`へ設定する。CONFIGから任意の外部URLを受け取らず、通常のモデル実行settingsには追加しない。

版の合成例は`cliVersion: "codex-cli synthetic"`・`bunVersion: "1.4.3"`・`gitVersion: "git version synthetic"`である。対応する`codex --version`・`bun --version`・`git --version`は終了0でその文字列を出し、前後の空白を除いた本文が設定と一致しなければ起動しない。入口Bunと子Bunの版も照合する。`codex exec`の代わりに`--version`の引数を記録して正常な担当起動と数えない。

actorは版取得を含むCLI起動前に、LinuxのPID 1・UID 1000、capabilityなし・NoNewPrivs、readonlyのroot・入力・runtime、default routeなし等を照合する。ホストでactorを直接起動した場合は、合成の版応答や環境変数だけではCLIを起動できないことが正常である。CLI引数・応答schemaの正常接続は実Dockerのpreflightで確認する。単体テストで観測を模擬しても、製品側へ境界を省く入口を作らない。

preflightのsettingsに限り、`hostCanaryPath`へホストが生成した合成canaryの絶対パスを設定する。そのファイルはmountしない。境界操作は実際のこのパスを使って読取り不能を確かめ、任意の存在しない別パスだけで代用しない。この値と生ログはローカルに留め、通常の実モデル用runtimeには追加しない。

ホスト側のDocker観測には、次の設定と実際の作成引数が対応する。gatewayも起動前の照合対象であり、probeの正常応答だけでactorの不一致を隠さない。

gatewayは設定を起動前と起動後に照合する。IPの割当ては起動後に観測し、設定の`gatewayAddress`へ記録する。gateway自身は隔離網だけへ登録した`gateway` aliasをIPv4で解決し、自分の非loopback interfaceに存在するIPだけで待ち受ける。作成時にIPが空でもwildcardへ切り替えない。probeは起動直後のhealth到達を最大3秒だけ待ち、その後に一般proxyの拒否と版を確認する。この観測待ちはモデル要求や固定操作の再実行ではない。

| inspectの対象 | 必要な値・関係 |
| --- | --- |
| image | `Config.Image`が設定digest、`Image`がimage inspectで得たIDと一致 |
| userとnamespace | `Config.User: "1000:1000"`、`HostConfig.ReadonlyRootfs: true`・`Privileged: false`、`PidMode`・`UTSMode`は空、`IpcMode`は空または`private` |
| 権限 | `CapDrop`に`ALL`、`CapAdd`は空、`SecurityOpt`は`no-new-privileges`だけ |
| 資源 | `Memory: 2147483648`・`NanoCpus: 2000000000`・`PidsLimit: 64` |
| 一時領域 | `Tmpfs`は`/work: rw,nosuid,nodev,size=268435456,uid=1000,gid=1000`と`/tmp: rw,nosuid,nodev,size=67108864,uid=1000,gid=1000`だけ |
| ログ | `LogConfig.Type: local`、`Config`の`max-size: 10m`・`max-file: "1"`・`compress: "false"` |
| mount | gateway・canary・controlはreadonlyの`/runtime`だけ、probeとactorはこれにreadonlyの`/input`を加える。Sourceも生成したディレクトリと一致。他の永続mountは不可 |
| network | `HostConfig.NetworkMode`と接続先集合を照合。probe・actor・preflight gatewayは評価用の隔離網だけ、canary・controlは対照用の隔離網だけ、本番gatewayは`bridge`と評価網だけ |
| DNSと転送 | 隔離網だけの役割は`Dns: ["127.0.0.1"]`で外部へのDNS転送を避ける。本番gateway・preflight-gateway・preflight-canary・preflight-controlは`Sysctls["net.ipv4.ip_forward"]: "0"`を明示し、内側でも実効値を照合。actor・probeにはこの明示設定と内側照合はなく、接続先network・DNS・default routeなし等を検査する |
| 追加接続 | `Devices`・`DeviceRequests`・`ExtraHosts`・`Links`・`VolumesFrom`は未指定または空 |

模擬Dockerでこの構造を再現する場合も、値の不一致、markerや成果物・schemaの欠落、ログ保存失敗、期限・割込みのケースを実際に対象へ到達させる。模擬検証で実Dockerの成立を証明したとは扱わない。

2026年10月18日のホスト再受入では、独立テスト担当が用意した固定SSE・シナリオ資産を使い、実Docker・採用CLIで7シナリオすべてを確認しました。既存ファイルの読取り・変更、新規成果物、ツール結果の次要求への到達、初回repairの応答schemaに加え、実操作の親子Bunの版・入口・実体を照合しています。期限・割込みは、操作が生成した成果物と版の記録を生存中に読んでから、停止・削除を確認しました。

追加の独立評価で、本文のないSSE完了イベントの受入と、stats・gatewayログ・canaryログの待機枠の合計超過が見つかりました。完了本文の`status: completed`を必須にし、3つの観測へ合計5秒の共通予算を適用しました。この修正後の版でも、実Docker・採用CLIの7シナリオすべてが通りました。独立テストでは、不正な完了本文と後続送信の抑止、canaryありの共有予算、観測失敗後の削除・終了記録を確認しています。模擬検証と実Dockerの結果は分けて保存しています。

通信対照はactorの前後で直接IP・Docker DNSの両URLへの200と本文一致を観測し、評価側の親子から同じ宛先への到達拒否を確認しました。禁止された公開pathと別モデル要求への403も実操作に含め、予定した拒否5件と受理された固定応答2件を照合しています。実モデル・外部モデルAPI・実APIキーは使っていません。初回確認の不足はこの再受入で補っており、別のimage・版・ホストへ成功をそのまま適用しません。

受入途中の旧版ではBun 1.4.3のactorが異常終了し、後続シナリオを停止しました。出力の読取り・書込みの完了を待ち、版取得時に両出力を回収する処理へ修正した後の7シナリオは通りましたが、異常終了の原因と再発防止は確定していません。固定応答や資源上限を緩めて成功させたものではありません。失敗記録と修正後の結果を分けて保持し、終了不明や再発時は後続を止めます。

ホスト受入では、採用候補CLI 0.163.0の正規`gpt-6.1-sol`情報を使い、未知モデルfallbackやmetadata改変を認めません。公開配布物から専用imageを準備し、base digest、Bun配布物のSHA-256、Codex配布物のSHA-512 SRI、導入コマンド、実効版をローカル証拠へ残します。Issueの調査基点はmain `0c7316253a9768844eb1c224961e00be52dcdcf2`、確認した環境はmacOS／OrbStack、Docker 29.4.0、Linux arm64、baseは`debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587`、Bun 1.4.3、Git 2.39.5です。配布物のdigest値やローカルimage参照を推測で補いません。

`preflight-plan.json`、`preflight.json`から対象版・条件・資産hash・各シナリオへ辿ります。各ディレクトリに`inspections.json`、`containers.json`、probe・actor・gatewayのstdout/stderr、ログ取得結果と`safety.json`を残します。inspectの環境変数値は保存前に伏せます。期限・ホスト割込みは別workerで操作開始を観測し、割込みではSIGINTを送ります。`worker.*`・`session.json`・`operation-observation.json`も保存します。正常CLIの要求・呼出し・結果はgateway原記録で確認し、公開可能な最小部分をfixtureへ反映する必要があれば独立テスト担当へ戻します。生ログ・ローカルパスは公開しません。

これらは当該image・ホスト・版・条件のローカル互換性と境界の確認です。実APIの利用権限・モデル提供・実応答・品質・請求額は未確認として残します。ホストの入口と子Bunへ同じ固定環境を渡し、[ホスト検証後の再評価](../scripts/README.md#ホスト検証後の再評価)で新しい外部ログと証拠から同じ差分を再評価します。旧runの停止記録・部分修正・原ログを保全し、旧本文へ結び付いた`--host-run`からは再開しません。

### 8課題の行動比較を準備する（#393）

[#393](https://github.com/thkt/dotagents/issues/393)の準備変更は、実モデル比較の実行許可を含みません。モデルを使わずに入力・有限上限・経路を確認し、実行コード、corpus、workspaceを共有済みcommitへ固定してから、依頼者の別の実行指示を受けます。準備変更だけを実モデルの行動改善、APIの利用可能性、imageの実稼働確認として報告しません。imageと実CLIのモデルなし受入結果は、前節の#401の確認範囲に限ります。

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

`totalTimeMs` は計画の読取り・保存後から全ケースに共有する予算、`caseTimeMs` はケースの隔離準備とモデル実行の上限です。終了確認のため、モデル時間の外に各試行最大65秒（使用量取得5秒、コンテナー削除30秒、network削除30秒）の有限猶予があります。新規モデル起動は期限後に行いません。actorには同じ絶対期限を渡します。金額制御のgatewayは新規要求を同じ期限で拒否し、終了観測の5秒以内にPID 1と観測補助処理を止めます。ホストが停止しても内部の期限で終了します。モデル出力は16MiBを超えると停止します。成果物は1ファイル1MiB・合計8MiB・2000ファイルまで取得し、symlinkは取得不能として示します。`.git`・`node_modules`は含めません。取得失敗・時間切れの成果物不足を成功としません。

SIGINT/SIGTERM・失敗・期限で所有するコンテナーとnetworkを削除し、結果を保存します。終了確認に失敗したら後続試行は未評価で止めます。SIGKILL・Docker daemon停止等でホストの最終記録が欠けた場合は、`containers.json` の自分の資源だけをホストで照合し、停止・証拠を確認してください。停止runを再開・上書きせず、成功まで自動再試行しません。新しい保存先でも旧runの停止理由や合意上限を迂回しません。

### #393の金額制御

[#403](https://github.com/thkt/dotagents/issues/403)により、8課題の実runには次の`budget`を設定します。旧5課題へ金額条件を必須化しません。8課題のA/B・corpus・workspace・順序・時間・要求数・出力上限は維持し、runnerは新しい実装と検証を共有したcommitへ両条件共通で固定します。

```json
{
  "budget": {
    "currency": "USD",
    "unit": "usd-1e-7",
    "budget": 6000000000,
    "stop": 5000000000,
    "notify": 4000000000,
    "profile": "gpt-6.1-sol-standard-2026-10-18",
    "profileHash": "e8bf221b79b734deb14067747932e3256cc3ce92b8ac4a6490cce9afdf855193"
  }
}
```

このrunは予算$600・停止$500・通知$400を使います。外部送信前に最大費用を予約し、検査できたusageだけを精算します。不明な費用はゼロへ戻さず全体を止めます。通知は予約込みの見込額で、APIの請求確定額ではありません。停止後に残額を使って再開せず、未実行の試行も記録に残します。料金・model・tierの前提が変われば、このprofileの保証を引き継ぎません。$600までの自動追加使用は許可しません。

固定profileの正本は[budget.ts](budget.ts)です。2026年10月18日採用の`gpt-6.1-sol`／`medium`、Standard（要求・返却とも`service_tier: "default"`）、非regionalの通常従量課金を使います。[公式モデル仕様](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[料金](https://developers.openai.com/api/docs/pricing)、[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[Responses仕様](https://developers.openai.com/api/reference/python/resources/responses/methods/create)とIssueの固定条件に基づきます。実行中の価格取得、token count／Usage／Billing API、別providerや高額tierへの切替えはありません。

100万tokensあたり通常入力／cache読取り／cache書込み／出力は、入力272,000以下で$2／$0.10／$2.50／$10、それを超えると要求全体へ$4／$0.20／$5／$15です。書込みは通常入力単価への加算ではなく置換です。通常入力は入力から読取り・書込みを引き、推論は出力の内数として再加算しません。最大入力922,000、最大出力8,000をすべて長文書込み・出力として予約すると、`922000 × 5 / 1000000 + 8000 × 15 / 1000000 = $4.73`です。計算・比較・保存にはUSDの10^-7単位の整数を使います。

ホストがrun全体の台帳を所有し、残額を同時に1つのgatewayへ委譲します。gateway内の要求検査・予約は直列化し、精算済み額＋返却不能額＋実行中要求の予約額に、新予約を加えて$500以下の場合だけ送信します。$500一致または不足による拒否で停止を固定し、精算後も再開しません。要求前の保存と$400以上で初回の通知は、ホスト専用`docker exec -i`の確認応答を待ちます。ホストCLI出力とローカル記録への通知完了前に後続送信を許可しません。外部配送・人の既読は保証しません。

委譲入力はgateway専用のread-only runtimeに置きます。actor／probeのsettings・入力・公開statsへ全体残額や他試行の履歴を含めません。新しいホスト書込みmount・Docker socket・資格情報・接続先は追加しません。runtimeの補助コードは固定lockfileの依存をBunでbundleし、image内で依存を取得しません。plan・互換性証拠にはprofileの内容とhash・金額条件・追加ソースhashを結び付けます。

送信後のHTTP失敗・429、費用未確定の切断・取消・期限・割込み、usage欠落や不正、model／tier不一致、重複・競合するSSE終端では、予約を返却不能額へ移して全体停止します。正常なstreamのEOFと一意な終端応答を確認するまで精算しません。確認後の下流切断でも精算の保存を待ち、その失敗は停止へつなぎます。保存・通知・委譲回収の失敗でも続行しません。未回収委譲枠は保留し、要求予約や通知見込額へ二重加算しません。取消がAPI側の処理・課金を即時停止するとは説明しません。

runの`budget.json`はホストが回収した台帳と未回収枠を区別します。各試行の`budget-N.json`、`budget-notice.json`、`budget-closed.json`に要求ID・応答識別hash・金額・停止理由と受渡し順序を保存します。受渡し原記録の欠落や強制終了を精算成功にせず、後続試行を未実行にします。費用記録と`safety.json`の資源削除確認は別です。観測補助処理も終了観測5秒の内側で止め、コンテナー削除30秒・network削除30秒を維持します。gatewayの終了観測中も新規要求の期限は延ばしません。

料金前提や上限に違反する応答は、課金項目と算定できた額を要求の`observation`へ残します。`confirmedCost`は既知の単価と使用量から算定できた値で、通常精算や請求確定へ読み替えません。不正な受渡しメッセージはホスト専用の`budget-rejected-message.json`へ保全します。いずれも前提違反による停止の証拠であり、上限超過を予約内の正常終了へ切り詰めません。

保証は採用profileの前提に基づく税抜API token利用料の保守的計上です。税・為替・他runや同projectの別利用・契約固有の割増・仕様変更を含む請求総額や、全16試行の完走を保証しません。Platformの補助上限・alertは人が別途判断し、今回のコードから操作しません。

2026年10月18日の実Docker・採用CLIによるモデルなし確認では、当時の金額経路の7シナリオがすべて通りました。12応答の合成usageを同じ台帳へ精算し、未回収枠・予約残り・返却不能額は0、各コンテナーとnetworkの削除も確認しました。金額閾値付近の動作は関数・模擬結合で検証し、この7シナリオの少量usageだけで$400通知・$500停止の到達を実証したとは扱いません。

初回のモデルなし確認では、正常に精算した応答の下流切断を費用不明として停止し、残る6シナリオを未実行にしました。正常なEOFと一意な終端を確認後も精算の保存を待ち、未確定の取消・切断と区別する処理へ修正した後の7シナリオが上記結果です。旧失敗記録と過去の#401の成功は別に保全しています。ソース・config・profile・fixtureを変えた場合は証拠を更新します。

未使用の予算bundle、同一境界の料金・計画検査、送信失敗・取消・不正usageでの同じ失敗の再保存を整理しました。保存と通知が確認できた失敗だけ再保存を省き、保存失敗時の停止・不明額保持は維持します。ホスト通知の模擬結合では、実stdoutへの正常出力と保存不能に加え、stdoutの非同期完了前・書込みerror時のack抑止を確認しています。終了snapshotの未完了予約・過去履歴欠落は、他の金額条件を整合させて検査します。

この再受入の途中でも、境界シナリオのactorでBun 1.4.3の`abort()`が再発し、残る4シナリオを未実行で停止しました。クラッシュの公式stackはGC helperのthread作成を指しています。PID上限到達の直接観測はないため原因は未確定です。[採用版のJSC設定](https://github.com/oven-sh/WebKit/blob/0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f/Source/JavaScriptCore/runtime/OptionsList.h)へ照合し、actorと子プロセスに`BUN_JSC_numberOfGCMarkers=1`を固定しました。同じimage・CLI・BunとPID 64・CPU 2・メモリ2gを維持した変更後の7シナリオが上記結果です。設定の認識と操作用の子Bunへの受渡しも観測しましたが、再発防止の確定や最大PID数の証明とは扱いません。失敗記録を保持し、再発時は後続を止めます。

固定SSEのusage・tierは公開仕様の合成fixtureで、実API採取原本ではありません。通常checkは模擬検証です。実APIのmodel／tier／usage互換性、hit率、請求額、品質は未確認です。実モデル・実キーの利用、API project・料金条件・送信範囲・summary公開先・具体的な実行指示は実装後に別途確定し、実装完了やマージを実行許可にしません。

#### 金額受渡しの模擬接続契約

独立テストで接続を模擬するときは、次の形式を使います。期待結果はIssue #403から定め、ここに示す形式自体を要求充足の証拠にはしません。設定の`budget`は前節の例と同じ7項目です。

| 接続 | 形式 |
| --- | --- |
| `budget-host.ts`の`createBudgetRun(directory, conditions)` | `conditions`は`currency`・`unit`・`budget`・`stop`・`notify`。返値は`state`、`delegate(runtime, expiresAt)`、`recover(runtime)`を持つ |
| `state` | `snapshot`、`delegation: string \| null`、`held: number`、`error: string \| null`。`directory/budget.json`には`conditions`とこれらを保存する |
| `runtime/delegation.json` | `id`はUUID、`conditions`は5項目、`initial`はsnapshot、`expiresAt`は有限のUNIX時刻ミリ秒 |
| gateway専用runtime | 元のruntimeを同じ試行ディレクトリの`gateway-runtime`へコピーし、元の`delegation.json`を取り除く。actor／probeへ元のruntimeを、gatewayへ専用runtimeをreadonlyでmountする |
| ホストの観測コマンド | `docker exec -i GATEWAY /usr/local/bin/bun /runtime/budget-runtime.ts`。標準出力は1行1件のJSON、標準入力は確認したsequenceの数値と改行、終了要求は`close`と改行 |
| `budget-host.ts`の`observeBudget(gateway, runtime, directory, expiresAt)` | gateway専用runtimeを読み、上記コマンドを起動する。返値は`close(deadline)`・`stop(deadline)`。`expiresAt`はUNIX時刻ミリ秒、`deadline`は`performance.now()`と同じ単位の終了観測期限 |
| 観測メッセージ | `delegation`は委譲ID、`sequence`は1から始まる整数、`kind`は`save`・`notify`・`closed`、`snapshot`は下記形式 |
| CLI通知の形式 | 1行のJSON。`type: "eval.budget-notice"`に、`kind: "notify"`の観測メッセージ全項目を加える。`budget-notice.json`は観測メッセージそのものを保存する |
| 保存結果 | 試行ディレクトリの`budget-SEQUENCE.json`、`budget-notice.json`、`budget-closed.json`。`recover(runtime)`は`runtime`の親にある`budget-closed.json`を読む |

通知ファイルの保存と標準出力への書込みは、それぞれの完了を確認してから、そのnotifyのsequenceへackを返す契約です。保存・標準出力のどちらかが失敗した場合はackを返さず、後続要求へ進みません。CLI出力先は呼出しプロセスの`process.stdout`で、`write(chunk, callback)`のcallback完了を非同期書込みの完了として扱います。callbackのerrorは出力失敗です。製品専用の出力注入引数はありません。

`close`は委譲の終了確認、`stop`は観測用の子プロセス・timer・pipeの停止です。呼出し側は`close`の成功・失敗を問わず、同じ終了観測期限を渡して`stop`を実行します。

snapshotは`runId: string`、固定した`profileHash: string`、整数の`settled`・`unrecoverable`・`reserved`・`accounted`、真偽値の`stopped`・`notified`、`reason: string | null`、`requests`配列を持ちます。要求は`id: string`、`state: reserved | sent | settled | released | unrecoverable`、`cost: number`、`response: string | null`、`billing: object | null`を持ちます。これらの内部接続は通常ハーネスの共有APIではなく、旧runを再開する入口にも使いません。

`requests`の課金項目は`billing: null | { id, status, model, service_tier, usage }`です。`status`は`completed`、model・tierは固定profileと一致し、usageは`input_tokens`、`input_tokens_details: { cached_tokens, cache_write_tokens }`、`output_tokens`、`output_tokens_details: { reasoning_tokens }`、`total_tokens`を持ちます。各token数と金額は非負の安全な整数です。予約中・送信済み・返却不能の要求額は最大予約額、解放済みは0で、精算済みには検査できたbillingを保存します。snapshotの各合計は対応する要求一覧と整合し、終了回収では実行中の予約がなく、過去の閉じた要求も維持されている必要があります。

要求の任意項目`observation`は、検査できなかった課金項目の`billing`と、整数または`null`の`confirmedCost`を持ちます。受渡し形式が不正な場合の保存先は`budget-rejected-message.json`です。これらを通常の精算済み額へ自動加算したり、請求総額の上限保証として使ったりしません。

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

