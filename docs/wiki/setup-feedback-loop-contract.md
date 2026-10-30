# setup-feedback-loopの呼出し仕様

[Issue #466](https://github.com/thkt/dotagents/issues/466)の導入操作を、実装と独立テストで照合するための公開仕様です。実装済み・導入済みを示す文書ではありません。内部のファイル分割や依存記録の保存形式は固定しません。

## 利用例と担当

cantleの導入担当は、通常checkが収集する`test/*.test.ts`と`evaluation/test/*.test.ts`を維持し、不足する静的検査を導入します。まず構成を調べ、固定版の依存をインストールし、設定とpackage scriptsを用意してから導入を確定します。通常の全体checkは、既存の型検査・Python構文検査・全テストに採用した静的検査を加えたものです。

既存のESLint・Prettier・Vitestを使うnpmプロジェクトでは、既存ツールと準備処理を利用します。新たなformatterを併設せず、不足するfallow等だけを導入します。`test:*`の一括実行があれば、新しい部分実行コマンドが全体テストへ混入しない接続を先に用意します。

導入担当がツールの選択、設定の意味、通常check・CIへの接続を判断します。スクリプトは構成の取得、固定依存の導入、必要な補助ファイルの配置とコマンドの接続を担います。package scriptsで表せる実行順序はそのまま使い、独自のタスクグラフや修正ループを追加しません。テスト・fixture・検証接続の作成と変更は独立テスト担当が行います。

以下のコマンドは、信頼する共有ハーネスの`/absolute/harness/scripts/feedback-loop/setup.ts`を固定Bunで呼びます。`--repo`は対象Git checkoutの絶対パスです。対象repoの日常実行に、この共有ハーネスのパスやBunの追加導入を要求しません。

## 構成の調査

```sh
bun /absolute/harness/scripts/feedback-loop/setup.ts inspect --repo /absolute/project
```

ファイルや依存を変更せず、package manager、runtimeの指定、package scripts、既存のlint・formatter・型検査・fallow・test runner、`.dotagents.json`、CI定義の所在をJSONで標準出力へ返します。未導入・不明な項目を区別し、不明なツールを採用済みと推測しません。取得不能や不正なpackage設定は非ゼロ終了と診断で返します。JSONの付加情報は拡張できますが、`packageManager`、`scripts`、`devDependencies`、`configFiles`を公開項目とします。

```json
{"packageManager":"bun","scripts":{"check":"bun run scripts/check.ts"},"devDependencies":{},"configFiles":["mise.toml",".dotagents.json"]}
```

`packageManager`は`"bun"`・`"npm"`・`null`のいずれかです。競合する指定や判定材料不足は`null`と診断で示し、install・applyは選択不能として止めます。`scripts`と`devDependencies`は名前と文字列値のオブジェクトで、未定義なら空オブジェクトです。`configFiles`は実在するrepo相対パスの文字列配列で、該当なしなら空配列です。

## 不足依存のインストール

```sh
bun /absolute/harness/scripts/feedback-loop/setup.ts install --repo /absolute/project --package oxlint@1.89.0 --package oxfmt@0.74.0 --package fallow@3.34.1
```

版は呼出し側が対応機能と配布元を確認して指定します。例は操作の形を示すもので、全repoへの採用指定ではありません。初版の自動導入対象は`oxlint`・`oxfmt`・`fallow`とし、既存ツールのプラグインや型検査の追加は、スキルから対象repoの通常の依存管理で行います。

導入済みの同じ固定版は変更せず、不足分を対象package managerでdevDependenciesとlockfileへ追加します。既存と異なる版、範囲指定、`latest`等は自動で置換しません。無条件の依存更新やpackage managerの変更は行いません。パッケージ取得やlockfile更新の失敗は非ゼロ終了とし、成功した範囲と未完了箇所を表示します。失敗時にローカル差分を一括で巻き戻しません。

## 導入設定

導入担当は内容を確認した`.feedback-loop.json`を対象repoに用意します。この設定は分類と関連選択だけを扱います。静的検査の順序はpackage scripts、ツールごとの規則は既存の専用設定に置きます。

```json
{
  "version": 1,
  "runner": "bun",
  "allowSkipped": true,
  "base": "origin/main",
  "collect": ["bun", "--no-env-file", "scripts/test.ts", "--list"],
  "testGlobs": ["test/*.test.ts", "evaluation/test/*.test.ts"],
  "assurance": [],
  "fullCheck": ["bun", "run", "check"],
  "prepare": ["bun", "--no-env-file", "scripts/test.ts", "--prepare"],
  "bunArgs": ["--no-env-file"],
  "bunWorkers": 4,
  "testArgs": ["--timeout", "15000"],
  "globalChanges": ["package.json", "bun.lock", "mise.toml", "scripts/**", "evaluation/**/*.py"],
  "dependencies": []
}
```

`testGlobs`は通常checkの収集集合です。パスはrepo相対とし、`*`はその階層、`**`は下位階層にも対応するglobです。既存のfixture等を通常checkへ追加する指定にはしません。qualityは収集集合からassuranceを除いた集合です。assuranceの各要素は`{"path":"test/example.test.ts","reason":"内容を確認した指定理由"}`の形とし、実在するテストファイルを指定します。重複や集合外の指定、空の理由を拒否します。新規テストはglobに合えばqualityへ入ります。

`collect`は、通常checkと同じ収集処理からテスト一覧を得るargv配列です。対象repoのcwdで実行し、標準出力へrepo相対パスのJSON文字列配列を返し、診断は標準エラーへ出します。cantleでは既存の`testFiles()`を一覧表示の入口と通常checkで共有する接続を用意します。例の`--list`はその接続案であり、導入前のコマンドにはありません。Vitestでは導入版CLIの収集結果を同じ形に整える対象repoの入口を使います。収集の失敗、不正な出力、重複、存在しないパス、`testGlobs`との集合の差は非ゼロ終了とします。

`runner`は`bun`または`vitest`です。Bunは固定した実行系と`bunArgs`を使い、テストオプションには`testArgs`を渡します。Vitestは対象repoのローカル依存を使い、既存の設定・global setup・環境変数を引き継ぎます。Vitestでは`bunArgs`を指定しません。`prepare`はテスト前に必要な既存コマンドのargv配列で、不要なら空配列です。同じ呼出しで準備処理や型検査を重複実行しないようpackage scriptsと照合します。

`bunArgs`に`--no-env-file`がある場合は、生成する`test:affected`と`check:classification`のpackage scriptsにもこの引数を維持します。テスト本体だけでなく、補助ファイルを起動する外側のBunも`.env`を先に読み込まないようにします。

`allowSkipped`は任意のbooleanで、省略時は`true`です。対象repoの既存checkがskip・todoを許容する場合は`true`、許容しない場合は`false`を指定します。boolean以外は入力不正として拒否します。この設定はBunとVitestの両runnerへ適用し、dotagents自身の既存runnerの厳格な判定は変更しません。

cantleでは、開始版`3f256f0c904e4a0b06ba401b218645ccf80bd64d`の`scripts/test.ts`にある`prepareTests()`へ、上例の`--prepare`を接続します。この入口は準備処理だけを実行して終了し、テスト本体を起動しません。既存の固定Bunと起動引数、`typescript`・`@types/node`の指定版と導入版の照合、`tsconfig.type-tests.json`による型検査、`evaluation`配下の既存収集処理によるPython構文検査を保ちます。単独の型検査への置換では、依存の照合とPython構文検査を満たしません。

一覧用の`--list`は通常checkと同じ`testFiles()`の結果を返し、準備処理とテスト本体を実行しません。通常checkは既存の準備処理と全テストを保ちます。`test:affected`は選択したテストを実行する前に`prepare`を一度だけ完了させ、失敗時には診断と非ゼロ終了を返してテスト本体へ進みません。修正後の再実行では準備処理から確認します。`check:classification`は収集と分類の検査であり、準備処理を実行しません。`--prepare`と`--list`は導入時に対象repoへ用意する接続で、開始版にはありません。

`fullCheck`は、担当AIがassuranceへの影響を判断できない場合等に直接実行する既存コマンドです。`test:affected`から自動では実行しません。`globalChanges`はquality全件へ広げる入力、`dependencies`は通常のファイル読み込み等を補う対応です。ある変更を対応付けできても、別の変更の影響が不明なら全qualityへ広げます。`package.json`、使用するlockfile、分類設定、関連選択器自体は、指定漏れでも部分実行の根拠にしません。

cantleのPython変更は本体側の`test/runtime.test.ts`にも関係するため、この例では全qualityへ広げます。`dependencies`を指定する場合は、`{"inputs":["data/*.json"],"tests":["test/example.test.ts"]}`の形で、内容を確認した対応を追加します。

## ファイルの配置と接続

```sh
bun /absolute/harness/scripts/feedback-loop/setup.ts apply --repo /absolute/project --feedback-command 'bun run lint:feedback && bun run format:feedback && bun run check:unused && bun run test:affected'
```

`apply`は`.feedback-loop.json`と既存の`.dotagents.json`を読み、対象repoで実行できる補助ファイルを`scripts/feedback-loop/`へ配置します。必要なBun記録器は共有実装を再利用して配置します。導入元のrepo・版と配置ファイルを確認できる情報を添えます。保存場所や記録形式を利用者が管理する仕組みにはしません。

`package.json`へ`test:affected`、`check:classification`、`check:feedback`を接続し、`.dotagents.json.feedbackCheck`を対象package managerの`check:feedback`呼出しへ設定します。`check:feedback`の値は`--feedback-command`で指定した診断用コマンドです。自動修正用の`format`・`lint:fix`は別の明示操作として用意します。全体checkとCIは導入担当が既存構成へ接続し、このコマンドが任意のCI定義を推測で書き換えることはしません。

上例では、型検査は`test:affected`の`prepare`に含まれます。`check:feedback`へ同じ型検査を別途追加しません。準備処理が不要なrepoでは`prepare: []`を使い、必要な型検査はそのrepoの既存構成に合わせて接続します。

Bun内蔵の型検査を採用する場合は、[接続手順](../../skills/setup-feedback-loop/references/typecheck.md)に従い、固定Bunの機能・対応TypeScript版と既存の検査範囲を確認します。`bun run check`は全体check、`bun check --no-script -p tsconfig.json`は指定プロジェクトの型検査です。同名のpackage scriptを起動しないよう、内蔵型検査には`--no-script`を付けます。変更ファイルや関連テストの集合へ型検査を狭めません。

cantleでBun型検査を使う反復用の準備入口を用意した場合は、`prepare`を`["bun", "--no-env-file", "scripts/test.ts", "--prepare-feedback"]`へ切り替えます。このフラグは導入先へ追加する接続例です。依存版の照合・既存tsconfigの型検査・Python構文検査を一度だけ実行し、通常checkの準備入口と既存の型検査は保ちます。複数のtsconfig、参照先、型生成・codegen等を含め、接続前後の範囲を確認します。型エラーでテスト開始前に失敗し、修正後に同じ入口から復帰することを導入完了条件とします。

初回導入時から、書き換える既存ファイルの内容と差分を確認できるようにします。同じ設定・同じ生成元で再実行した場合は内容を変えません。既存の同名コマンドや生成物が指定内容と食い違う場合は、上書き前に対象と理由を示して非ゼロ終了します。無関係なローカル変更は保持します。入力不正と既知の衝突はファイルの配置前に検出します。OS・インストール障害を含む操作全体の原子性は要求せず、途中失敗した内容を明示します。

## 導入後の呼出しと完了条件

```sh
bun run check:classification
bun run test:affected
bun run check:feedback
bun run check
```

npmプロジェクトでは同じscript名を`npm run`で呼びます。`check:classification`は、`collect`と`testGlobs`の集合の一致、qualityとassuranceの重複・未登録・存在しない指定を機械検査します。通常checkと`collect`が同じ収集処理へ接続されることも、導入前後の一覧と独立テストで照合します。意味の分類を機械判定したとは扱いません。

`test:affected`はGitの変更と設定された関連選択からqualityを実行します。変更なし・候補0件・選択不能・実行失敗・実行成功を区別し、候補数・選択数・全件へ広げた理由を表示します。比較元が取得できない等の選択不能を、実行成功へ読み替えません。担当AIは変更したassuranceや影響先が明らかなassuranceを直接実行し、影響を判断できなければ全体checkへ広げます。部分実行の成功は全体checkの成功ではありません。

Bunではquality全候補を一度の`bun test --changed=<baseとの分岐点> --isolate`へ渡します。実行時記録と明示した`dependencies`が選んだ未実行ファイルを、補完対象として追加実行します。同じファイルが両方へ含まれても重複実行しません。通常importの標準選択を、子Bun・動的読込み・ファイル読込み等の補完と置き換えず、和集合にします。準備処理と既存の起動引数を保ち、候補数と実際に選択されたファイル数を区別します。

`bunWorkers`はBunの並列worker数で、省略時は4です。正の安全な整数を指定し、1なら直列に実行します。Bun標準による選択・補完・全qualityへのfallbackに同じ設定を使い、各ファイルのglobalとmodule cacheを`--isolate`で分離します。workerのPIDは再利用されるため、ファイルごとの別OSプロセスは保証しません。Vitestではこのキーを指定しません。`bunArgs`・`testArgs`には`--isolate`・`--no-isolate`・`--parallel`・`--no-parallel`を重ねず、並列数はこのキーで指定します。

一括実行の成功はJUnitにあるファイル別の結果と記録されたownerを照合して判定します。読み込まれたファイルの結果欠落、0件、件数の不一致、対象外ファイル、失敗を成功扱いしません。補完や全件実行では指定した全ファイルの結果を要求します。許可された一部skipを保ち、和集合全体がskipなら非ゼロ終了にします。失敗・取消では起動した処理の終了を待ち、成功記録を部分採用しません。終了や結果を確定できない一括実行の候補は、旧記録を保持したうえで利用中の依存記録から無効にします。

起動するBunには`--no-orphans`を付けます。直接の取消だけでなく、ホストが親を強制終了した場合もleader・workerと出力用pipeを解放します。実行開始時に未完了を示すファイルを作り、結果と記録の確定後に削除します。強制終了でこのファイルが残った場合は原記録を保全して全qualityを再実行し、正常完了後は通常の関連選択へ戻ります。Vitestも、選択した全ファイルの結果がJSONレポートに揃わない場合は非ゼロ終了にします。

標準CLIの選択集合だけでは、複数の変更がすべて対応付けできたとは判断しません。各変更の届き先が実行記録や明示対応等で確認できない場合は、全qualityへ広げます。Bun 1.4.4は関連0件で終了0を返すため、選択診断と未読込み、結果レポートの有無から、選択対象外と実行結果の欠落を区別します。補完を含めた実行がゼロなら非ゼロ終了とします。

実行したテストが成功し、対象repoのskip等の扱いを満たした場合だけ終了0にします。`allowSkipped: true`でも、選択したテストがすべてskip・todo等で実行されなければ、未実行として診断を示し非ゼロ終了します。`false`では一部でもskip・todoがあれば非ゼロ終了します。変更なし、候補0件、選択不能、起動・解析・実行の失敗、取消も非ゼロとし、診断で区別します。

実行時の依存記録を使う場合、記録なし・破損・runnerや記録器の変更・関連選択設定の変更、採用コードとの整合を確認できない記録では全qualityへ広げます。たとえば記録取得後に依存構造の変更をcommitし、その変更が現在の差分へ出なくなった場合も、古い記録から一部だけを選びません。記録取得時のソース基準と現在の差分の対応を確認できる条件を実装で明示します。失敗・取消を成功した記録更新へ変換せず、既存の原記録を保持します。保存形式を変更する場合も、旧記録の保全と新しい記録の採用を分けます。

基点の照合対象は現在のquality候補です。削除済み・分類変更済みのテストの原記録は保持し、その古い基点だけで現行quality全体を無効にしません。現行qualityを正常に再実行した後、既知のソース変更で関連選択へ戻れることを確認します。

導入操作では、formatter・lint・型検査・fallow・テストの正常例と小さい違反を`check:feedback`から確認し、違反を残さず再検査します。再インストール、再セットアップ、分類集合、選択漏れへのfallback、通常check・CIへの接続も確認します。共有の検証用repoで成立させた後、cantle、次にkaiへ適用します。実導入結果と未完了箇所は既存のfindings・PR説明に記録します。

関連選択の導入確認では、設定変更と通常ソース変更を分けます。隔離したcheckoutで導入後の版を比較元にし、通常ソースだけの変更に必要なqualityが実行され、無関係なqualityとassuranceが除外されることを確認します。標準importと補完依存の両方を確かめ、記録なし・古い記録・未知の入力では全qualityへ広がることも維持します。`src/**`等の一括指定で常に全qualityを実行するだけでは、絞り込みの導入完了とは扱いません。

`.dotagents.json`の更新を含む導入は、対象repoのimplementを開始する前に行います。実行中のrunが使う設定・旧run・保護規則を変更せず、更新後の設定を新しいrunで固定します。導入作業の独立テスト・独立評価は省略しません。実装担当へコマンドが渡る接続確認と、実モデルが実際にそのコマンドを使った観測は区別します。
