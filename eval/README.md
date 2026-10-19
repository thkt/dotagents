# 指示変更の比較eval

比較eval専用の実行コード・corpus・合成課題・模擬テストと操作説明を、このディレクトリにまとめています。通常ハーネスの実行経路からevalを起動・importしません。

## ChatGPT認証の軽量比較（#405・#409）

[Issue #405](https://github.com/thkt/dotagents/issues/405)の軽量入口は`bun eval/light.ts plan|preflight|run CONFIG`、裁定は`bun eval/light.ts report RUN_DIRECTORY [JUDGMENTS_JSON]`です。[Issue #409](https://github.com/thkt/dotagents/issues/409)により軽量方式へ一本化し、API専用入口・Docker・中継・金額台帳を削除しました。専用認証環境や認証情報のコピー、APIキー・Dockerの準備は不要です。通常ハーネス・公開CI・スケジューラーには接続しません。

このIssueの許可は入口・操作説明・モデルなしの検証までです。`plan`と`preflight`は推論を起動しません。`run`は比較モデルを起動する入口なので、実装の完了やcheck・CIの成功は実行許可に含めず、後続の具体的な実行指示を待ってください。実モデル、実認証による推論、ログイン、認証情報の移送、課金変更や追加購入は今回行いません。

### 計画と後続の操作例

先に`plan`で公開blobの本文・hash、Aで意図した不存在、参照の欠落、固定初回担当入力・応答契約・テストhash、runnerのcommit・未commit変更・ソースhashを確認します。本文のある固定担当ソースは`actorSources`にhashでまとめ、各条件から参照します。共通workspaceは部分集合へ減らせません。採点基準・参照解・他方の結果・本Issue本文・過去run・ホスト記録はactorに渡しません。

設定は既存API設定を流用せず、次の軽量専用契約でJSONに保存します。未知のキーや、旧sandbox設定、任意の読取りパス・hook・MCP・追加agentの指定は拒否します。

| 項目 | 値と確認方法 |
| --- | --- |
| `repository` / `issue` | `thkt/dotagents`と合意したIssueまたはPRのURL |
| `authentication` / `permissionProfile` | `chatgpt` / `eval-light` |
| `before` / `after` | `fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092` / `6181233d17a29c711a84f20549f78507c5c3e5fb` |
| `corpusCommit` / `workspaceCommit` | 両方`0c7316253a9768844eb1c224961e00be52dcdcf2` |
| `workspaceFiles` | 同commitの`git ls-tree -r --name-only 0c7316253a9768844eb1c224961e00be52dcdcf2 -- eval/fixtures/workspace`の全行を配列にする |
| `instructionFiles` | 後述の固定入力にある指示ファイル一覧。両条件で同じ一覧を指定する |
| `model` / `reasoning` | `gpt-6.1-sol` / `medium`。実アカウントでの提供は未確認。利用できなければ停止する |
| `cliExecutable` | 必要なら採用CLI実体の絶対パス。未指定時はPATHの`codex`。shimの場合は背後のCLI実体もホストで観測し、同じ版へ固定する |
| `cliVersion` / `bunVersion` / `gitVersion` | 採用する実効版の文字列。候補は`codex-cli 0.163.0` / `1.4.3`。親子に同じ固定環境を渡す |
| `stage` / `cases` / `trialOrder` / `maxTrials` | 下表の段階ごとの固定値。順序・片側・重複・余分な課題は変更できない |
| `caseTimeMs` / `totalTimeMs` | 各試行600000以下、全体は第1段階2400000以下・第2段階7200000以下 |
| `outputDirectory` | checkout外の、新しい絶対パス。既存runを再開・上書きしない |
| `boundaryEvidence` | ホストで作成するモデルなし確認の外部JSON。未指定でもplanは作れるが、推論を開始できない |
| `disclosure` | `inputs: fixed-public-inputs-with-common-context`、`raw: local-only`、`summary: manual-issue-or-pr` |

| 段階 | `cases`（この順） | `trialOrder` | `maxTrials` |
| --- | --- | --- | ---: |
| 1 | `storage-fields`, `completion-message` | `before-storage-fields`, `after-storage-fields`, `after-completion-message`, `before-completion-message` | 4 |
| 2 | `retry-limit`, `guide-link`, `work-area`, `cli-description`, `history-record`, `save-diagnostics` | `before-retry-limit`, `after-retry-limit`, `after-guide-link`, `before-guide-link`, `before-work-area`, `after-work-area`, `after-cli-description`, `before-cli-description`, `before-history-record`, `after-history-record`, `after-save-diagnostics`, `before-save-diagnostics` | 12 |

例えば、公開入力を確認した第1段階の設定を`/absolute/path/light-stage1.json`へ保存したら、まず`bun eval/light.ts plan /absolute/path/light-stage1.json`で確認します。モデルなし確認は別の新しい`outputDirectory`を指定して`bun eval/light.ts preflight /absolute/path/light-stage1.json`で行います。認証操作やモデル実行の許可にはなりません。

後続で実行が指示された場合だけ、同じ共有runner commit、実効ツール版・モデル・設定を固定し、ホスト確認済みの`boundaryEvidence`と新しい保存先を指定して`run`を使います。第2段階は、第1段階の裁定を見た依頼者の別の指示と新しいrunが必要です。段階を自動で進めたり、第1段階を再実行したりしません。認証保存先の`eval-light-runs`に段階と固定runner・入力の予約を排他的に保存するため、同じ段階を別の保存先でやり直す操作も拒否します。停止記録・予約を削除して上限を回避しないでください。

### 認証・入力・境界

保存済みChatGPT認証を公式CLI自身が使い、更新します。独自OAuth、tokenの抽出・再送、API中継への置換、APIへのfallbackはありません。子環境はPATH・HOME・CODEX_HOME・TMPDIRだけから選び、actorのコマンド環境はさらに必要な実行パスと専用一時領域へ限定します。APIキー、provider上書き、起動hookなどの環境は引き継ぎません。各試行の直前にCLIの`login status`でChatGPT認証を確認し、未ログイン・API認証・不明・失敗では推論を開始しません。アカウントやworkspaceの選択、通常のログインが必要な場合は、後続実行前に人が行います。認証本文をplan・ログへ保存しません。

普段の`CODEX_HOME`または既定の保存先を公式CLIへ渡し、登録の存在だけでは拒否しません。CLI自身のHOMEは通常のまま保ち、actorのコマンド環境だけをprofileで専用HOME・一時領域へ限定します。ファイル保存・OS資格情報ストアの切替えやtokenの読取りは行いません。この組合せで現在の保存方式を使えなければ未対応として止めます。

`--ignore-user-config`・`--ignore-rules`、祖先文書の自動取込みの抑止、不要機能の無効化を維持します。固定AGENTS本文をdeveloper指示へ渡し、同名の個人登録で置き換えないよう、workspaceのscoping・implementの絶対パスを明示します。個人の登録を意図的に全件読み込む機能は追加しません。登録済みhookやMCP等の実行許可にもなりません。

planの`commonContext`とrunの`common-context.json`・`evaluation.json`に、既知の登録元の非秘密の要約を残します。認証保存先の実体パスはhash、CODEX_HOMEのAGENTS・config・hooksは本文hash、skills・plugins・rules・memoriesとHOMEの`.agents/skills`は直下の登録のメタデータを要約し、symlinkは追いません。認証本文・設定全文・個人指示全文・全環境は保存しません。把握した条件が計画後や試行間で変われば後続を止めます。入れ子の登録本文・symlink先の変更や、CLIの全自動入力の同一性は保証しません。通常の個人指示が送信・生ログへ入る可能性があり、生ログはローカル限定です。`disclosure.inputs`の旧値`reviewed-public-committed-files-only`も固定課題入力の宣言としてのみ読み、全送信入力が公開blobだけという意味にはしません。結果は日常環境の共通条件下の少数比較であり、完全な入力隔離や指示変更だけの純粋な因果効果とは扱いません。

[採用CLIのscratch処理](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/sandboxing/src/seatbelt_scratch.rs)は、`minimal`から`/private/tmp`・`/private/var/tmp`を暗黙に開くため、両方を明示的に拒否します。試行のworkspaceと専用一時領域だけをその下で開き直し、個別denyへ列挙していないcanaryも検査します。profileはrootの読取りを拒否し、必要なシステム・実行ファイルの読取りと、その試行のworkspace・専用一時領域の書込みだけを許可する方針です。指示・仕様・独立テスト等は読取り専用、認証・他試行・ホスト用記録は拒否します。コマンドの外部通信を禁止し、web search・登録MCP・connectors・browser・画像表示／生成・追加モデル・hook等の不要な経路を無効にします。multi-agentは`agents.enabled=false`も明示し、CLI自身のモデル通信・認証更新とは区別します。新しいセッションで`ephemeral`を使い、resumeしません。`danger-full-access`や旧`--sandbox`との混在、全ホームの許可、workspace内への認証コピーで回避しません。

[公式のpermission profiles](https://learn.chatgpt.com/docs/permissions)は、旧sandbox設定と混在させないこと、ローカルコマンドとCLIのサービス通信を分けることを説明しています。[認証の説明](https://learn.chatgpt.com/docs/auth)も参照してください。これは採用ホスト・公開読取りツール・実認証での成功を示す証拠ではありません。

### モデルなし確認と現在の未確認事項

`preflight`は実認証を使わず、専用の合成canaryと[既存の固定操作](tests/light-boundary.fixture.ts)、[ホスト確認の条件](tests/fixtures/light-host-cases.json)を使います。公式の`codex sandbox`で通常入力の読取り・workspaceと専用一時領域の書込みを確かめ、ダミー認証・別試行・採点・私的領域の読取り／書込みとloopback通信の拒否を観測します。canaryは先に作成してhashを残し、未存在や単なる接続失敗を拒否成功にしません。同じBun・固定通信操作・宛先・環境をprofile外→内→外で実行し、前後は接続でき、内側だけが拒否されることを照合します。内側の`EPERM`／`EACCES`、または公式`--log-denials`が対象PIDに絞った`network-outbound`と当該ポートの一致を要求します。`ECONNREFUSED`単独や別ポートの拒否、対照の欠落・失敗・終了不明は未確認です。正常対照が起動できなければ、後続診断を止めます。推論・外部provider・ブラウザーは起動しません。通信の正常対照には、公開の合成本文だけを返す一時的なlocalhostサーバーを使い、終了時に閉じます。

公開読取りツールはコマンドfixtureで代用しません。初回宣言に加え、独立担当の`nativeToolInventoryResponses()`で実行時の`ALL_TOOLS`を採取します。採用設定では独立したローカルファイル読取りツールを公開せず、汎用MCP操作には登録先・resource・templateがありません。`apply_patch`の正常な変更と保護対象の読取り拒否も別に照合します。通常の子処理を含む期限・SIGINT・SIGTERM・正常終了には、独立したネイティブ固定応答の操作・成果物・PIDの証拠が必要です。コマンドだけの部分診断は`diagnostic.json`へ残し、`preflight.json`の成功には完全な外部証拠との照合も要求します。実アカウントを使って不足を補完しません。固定応答を実CLIへ接続する操作は、[ホスト確認driverの手順](tests/fixtures/light-host-driver.md)を参照してください。操作ごとに新しい保存先を指定し、旧記録は保全します。

ホストの`boundaryEvidence`は`light-native.ts`の契約に従い、`status: passed`、`runnerHashes`、実効`versions`（起動入口のパス・hashを含む）、`profilePolicyHash`、`fixtureHashes`、`readToolInventory`、`observations`を保持します。`plan`の`boundaryEvidenceSchema`で保存形式を確認できます。`readToolInventory`は独立したローカルファイル読取りツールが無効な実効一覧の外部ログとhashを指します。観測は`command`・`read-tool`・`lifecycle`を分け、対象・操作（`read`・`write`・`network`・`execution`）・allowed／denied／stopped・外部生ログの絶対パス・SHA-256を対応させます。通常入力・2種類の書込み・保護対象4種類・未列挙のscratch領域2種類・通信・期限と割込み・通常の子処理を欠かせません。コードは対象版・必要観測・ログhashを照合しますが、ログ内容の真実性や意味はホスト担当AIと独立評価が確認します。設定文字列や自分で記入した成功値だけで証拠を作らないでください。確認に失敗すれば未対応として止めます。

2026年10月20日にmacOS 27.0.1 arm64、CLI 0.163.0、Bun 1.4.3、Apple Git 2.54.0で、合成の通常HOME・認証保存先と固定ローカル応答を使う48操作を確認しました。A/Bそれぞれのscoping・初回implementについて、要求への固定入力の接続、AGENTSと両スキルの読取りhash、担当入力の配置先と応答契約を照合しています。通常の読取り・書込み、認証の実体とsymlink別名・他試行・採点・私的領域・未列挙scratchの拒否、`apply_patch`の境界、実効ツール一覧と空のMCP登録も確認しました。期限・SIGINT・SIGTERMの3操作は想定どおり非0で停止し、通常操作を含む親子プロセスの終了と後始末30秒以内を確認しています。通信の前後正常対照と拒否を合わせた41観測を最終ソース・fixture・実体hashへ照合し、公開preflightは`passed`・`inferenceLaunched: false`でした。

この確認は、証拠の行境界とJSONLの重複解析を修正した後のrunnerで、新しい保存先へ48操作を実行した結果です。10月19日の修正前の証拠は保全し、変更後の成功へhashを付け替えていません。証拠行の回帰テストは、修正前の架空行受入7件を検出し、修正後は最終行・実在空行・空ファイルを含む20件が成功しました。

これはモデルなしの接続・境界確認です。自発的なスキル選択、実ChatGPT認証の互換性、モデル提供、契約枠の消費、指示の効果は未確認です。生ログはcheckout外のローカル保存先に保持します。通常checkは模擬CLIと制御テストだけで、このホスト確認を実行しません。別のrunner・ツール・profileで使う場合は[ホスト検証後の再評価](../scripts/README.md#ホスト検証後の再評価)で対象版と証拠を更新してください。実効境界をモデルなしで確認できなければ、軽量版を未対応として報告します。過去のDockerや通常登録を含まない旧診断を、今回の成功へ流用しません。

### 停止・容量・裁定

試行準備・CLI・ツールに加え、成果物の回収・記録保存までを各試行の時間へ含めます。CLIのツールが別sessionを作るため、CLIのgroupだけでなく、稼働中に観測した通常の子孫も開始時刻とともに保持して止めます。観測失敗や残存は終了不明とし、敵対的なdaemonや意図的な監視回避の捕捉は保証しません。終了観測とプロセス停止に実際に使った時間だけを、最大30秒の別枠として扱います。未使用の別枠を回収・記録保存へ充てず、終了不明を成功にしません。最大追加枠は第1段階2分、第2段階6分です。CLI失敗・時間切れ・認証や利用枠のエラー・保存失敗・容量超過・終了不明では後続を起動せず、未実行も予定行として残します。保存例外などで起動状態が分からない行は`launchUnknown`を付け、起動0や成功と読み替えません。通常の課題内コマンド失敗と、CLI全体の失敗をJSONLで区別します。成功するまでの自動再試行は0です。

終了JSON等を含むログ合計は16MiB／試行、成果物は1ファイル1MiB・合計8MiB・2,000件以下で収集します。ディレクトリも件数へ含め、symlinkは収集しません。これはログと回収の上限であり、作業ディスクのquotaではありません。Docker同等のCPU・メモリー・PID隔離、全HTTP捕捉、内部の再送禁止、APIのtier・usage監査は保証しません。ネイティブのプロセス群終了もPID namespaceと同じ保証ではなく、確認済みの合成課題だけに限定します。

`evaluation.json`は段階・全予定行・実行方式・版・境界証拠・実行状態・取得できたusageと実時間を持ちます。各試行の`versions.json`で開始直前の実効版・実体hashを再照合します。`actor.stdout`はJSONL、`actor.stderr`・`launch.json`（実際のargv・profile・prompt hash）・`probe.json`・`trial.json`・`artifacts.json`と回収物はローカル限定です。正常終了・自己申告・参照への言及だけで要求充足にしません。既存8課題の基準で、発見・適用、要求充足、不要な調査や逸脱、負担を独立に裁定します。裁定JSONの証拠ファイル・hash・行、条件差、理由を照合し、`fulfilled`／`unfulfilled`／`indeterminate`と実行状態を別に残します。ネイティブでは実際の境界・終了証拠を要求し、Docker削除済みの架空値は使いません。

usage未取得・不正・JSONL欠落を0や無料にせず、ChatGPT枠をAPI単価でドルへ換算しません。第1段階の出口は「記録と基準で裁定できる／不足がある」と次の判断です。差なし・悪化・判定不能も残し、#385・#387・#388の効果はまだ未評価です。各条件1回の少数例から統計的改善、4件それぞれの独立効果、通常フロー全体、費用や速度改善を主張しません。両段階を合わせるのはrunner・モデル・入力・設定が共通の場合だけで、期間差を明示します。

採点は既存の条件名を伏せる手順を使えますが、指示から推測できるため完全な盲検ではありません。採点専用モデル・自動投稿は追加しません。生ログと採点情報はhost-only、公開summaryは後続で合意したIssue/PRへ人が確認して手動共有します。実アカウントの推論互換性、利用枠消費、指示の効果は本Issue完了後も未確認です。

## 固定入力

`instructionFiles`には`AGENTS.md`、`README.md`、`scripts/README.md`、`docs/wiki/development-policy.md`、`skills/scoping/SKILL.md`、`skills/implement/SKILL.md`、`skills/scoping/references/`のsufficiency・experiment・session・issue、`skills/implement/references/testing.md`、`skills/references/`のdocuments・natural-japanese・premise-validation・caller-first-design・mechanizationを、それぞれ`.md`まで含むパスで指定します。必要なら`skills/templates/wiki.md`・`skills/templates/decision.md`も指定できます。

Aで意図した3参照の不存在はGit treeで確認し、Bから補いません。参照の欠落はplanへ残し、存在だけで意味の十分性を保証しません。固定corpusの8課題・仕様・判定基準とworkspaceは変更しません。初回実装4課題は固定A/Bの担当入力・応答契約・課題別checkと独立テストhashを使い、配置先だけを共通規則で変換します。通常implement全体・独立テスト作成・公開は起動しません。

## 過去の方式と証拠

API方式の現行入口・互換reader・転送はありません。旧専用キー`image`・`imageReview`・`budget`・`preflightDirectory`・`maxModelRequestsPerCase`・`maxOutputTokens`はstrictな設定検査で明示的に拒否します。旧金額設定を読み捨てたりChatGPT枠へ換算したりしません。

過去のIssue・run・原記録・予約と固定入力は保全します。旧方式の操作・金額・Docker確認は[変更前の操作説明](https://github.com/thkt/dotagents/blob/40f85c6224082120511f5ab76fe1712cbfb4f1fa/eval/README.md)と[#401](https://github.com/thkt/dotagents/issues/401)・[#403](https://github.com/thkt/dotagents/issues/403)を参照してください。当時の成功と停止はその版・条件の証拠であり、今回の認証条件・profile・固定入力での成功へ流用しません。旧runを再実行・再集計する経路は維持しません。既存Docker資源・認証・課金設定も変更しません。

軽量入力テストは[A/B pack](tests/fixtures/trusted-inputs.json)と[共通入力pack](tests/fixtures/light-common-inputs.json)を[共通処理](tests/trusted-inputs.ts)で一時Gitリポジトリへ展開し、pack・mode・blob ID・本文hashを照合します。浅いcheckoutでのテスト専用準備であり、実比較の固定公開commitを補完しません。`bun run test:control`・`bun run test:eval`と総合`bun run check`はモデルなしで、0件・skip・失敗を成功にしません。過去のAPI専用テストの削除後も、公開入力の選別、固定初回入力、参照欠落、裁定・証拠、容量・期限・停止は軽量テストで確認します。

### 判定と関係者への報告

`evaluation.json` は計画・各試行・実時間・実効ツール版・停止と終了確認の記録です。`plan.json` で入力とファイル版へ戻れます。各試行の `actor.stdout`（JSONLと取得できた成果物）、`actor.stderr`、`probe.json`、`trial.json` を保持します。これらは私的なローカル証拠です。モデル出力に含まれるコード・パス・命令をホストで実行せず、同じ試行の根拠として読みます。

ホストの独立した判定では、スキル本文を取得した箇所と用途に沿う行動を別々に参照します。言及・部分検索・資料としての読取りだけで選択としません。非選択は完全な行動記録で判断し、欠落があれば `unknown`。成果は各ケースの基準と成果物・検証を照合して `fulfilled` / `unfulfilled` / `indeterminate` とします。境界例は選択の正誤の分母から除きますが、成果と費用には残します。GitHub・依存導入が使えない実装ケースでは、ローカルの本文を渡しただけで#187の要求充足を保証せず、不足を判定不能として残します。

裁定を保存するJSONの例です。参照は同じ試行のファイル名、SHA-256、1始まりの行範囲です。各ケースについて基準を適用した理由を記し、使わない参照配列は空にします。`both` は両スキルそれぞれの取得・適用を参照します。成果判断には `evidence`、非選択には `completeTrace` が必要です。参照の一致検査は意味判断の正しさを保証しません。

```json
{
  "evaluationSha256": "evaluation.jsonのSHA-256",
  "conclusion": "indeterminate",
  "reason": "観測した差と、判断できない理由",
  "nextDecision": "依頼者が次に判断すること。採用・マージは人が行う",
  "conditionDifferences": [],
  "trials": [{
    "trial": "before-storage-fields",
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

同条件比較と少数例の限界は[開発方針](../docs/wiki/development-policy.md#改善効果の比較)に従います。実アカウントでの推論互換性、固定モデルの利用可否、利用枠消費、指示の効果は未確認です。第1段階の具体的な実行指示では、利用する既存アカウント／workspace、普段の契約枠の使用、固定課題入力と共通コンテキストの送信範囲、ローカル保存先・summary共有先を確認します。第2段階・追加試行・別モデルへ自動移行しません。
