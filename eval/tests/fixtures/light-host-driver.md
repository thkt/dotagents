# モデルなしホスト確認driver

[Issue #405](https://github.com/thkt/dotagents/issues/405)（本文更新2026-10-18T07:24:28Z）の「モデルなしのホスト確認」に使う、テスト専用の接続です。既存の[固定資産](light-host-bundle.md)・[操作と期待結果](light-host-cases.json)を維持し、実CLIと固定ローカルSSEの接続、合成入力配置、raw記録の保存を追加します。通常のrun・CIから実CLIを起動しません。比較モデル、実認証、ログイン、外部推論、課金変更の入口ではありません。

## #409で追加した確認

[Issue #409](https://github.com/thkt/dotagents/issues/409)（採用固定版2026-10-19T14:09:00Z）に従い、全caseの合成認証保存先へ個人指示・同名のscoping/implementスキル・設定・hook・plugin・rules・memoriesとsymlink登録を配置します。実認証は投入しません。登録の存在を許すことと実行許可は別です。通常の認証保存方式やOS資格情報ストアの互換性は、このfixtureでは確認できません。

`public-input`は公開planから各側のAGENTS本文と選択するskillの絶対パスを導出し、developer指示へ接続します。指定側のAGENTS・scoping・implementを実コマンドで読んだhashも確認します。初回要求に固定AGENTS・選択したskillのパス・必要な初回担当入力がない場合や、次の要求に固定本文hashがない場合は応答を止めます。ホストはA/Bそれぞれを新しい保存先で実行し、raw要求の固定指示、個人の同名登録との違い、参照元、必要な担当入力と応答契約も照合してください。CLIが自動追加する共通コンテキストを完全に把握した証拠にはしません。固定操作によるファイル読取りだけで、自発的なskill選択や実モデルの効果を主張しません。

`dummy-auth-alias`は専用一時領域のsymlinkからダミー認証の実体を参照します。認証実体と別名のread・shell-read・read-tool・writeを拒否し、正常な公開入力の読取りとworkspace書込みを対照にします。資格情報の保護を全ホームの許可で回避しません。実ツール未公開・ENOENT・構文エラーは拒否成功ではありません。

変更後のrunner・CLI・profile・fixtureで、一覧・通常操作・保護対象・通信・期限・割込み・親子終了を再確認し、新しい原記録とhashへ対応させます。旧headの成功やhashの付替えは使いません。本セッションでは資産準備だけを行い、CLI・サーバーを起動しません。

## 設定と起動

ホストは採用版のcheckoutへ本資産を転送し、同じcheckoutの`eval/light-native.ts`があることを確認します。基点`048ff72991c7a8d800c031ce829509b34f3337ff`にはこの実装がありません。実装の欠落を境界拒否や不具合再現の成功にしません。CLI・Bun・Gitはホストが確認した絶対パスで指定します。普段の`CODEX_HOME`や資格情報は指定しません。

```json
{
  "repoRoot": "/absolute/path/to/adopted-checkout",
  "outputDirectory": "/private/tmp/new-host-case",
  "bunExecutable": "/absolute/path/to/adopted-bun",
  "bunVersion": "1.4.3",
  "cliExecutable": "/absolute/path/to/adopted-codex",
  "gitExecutable": "/absolute/path/to/adopted-git",
  "caseId": "inventory"
}
```

配置だけを調べる場合は次を使います。CLI・listenerは起動しません。指定したcaseのworkspace・一時領域・ダミー認証canaryを作り、公開fixtureをbyte同一でコピーします。未列挙canaryのcaseでは、選択した`/private/tmp`または`/private/var/tmp`にも新規canaryを作ります。これらは証拠として保持します。

```sh
bun eval/tests/light-host-driver.fixture.ts prepare /absolute/path/to/config.json
```

実操作は後続のホスト確認でだけ起動します。`run`も配置から開始するため、`prepare`で作成した保存先は再利用できません。存在する保存先、checkout内の保存先、不正引数を拒否します。失敗した部分記録も消去・上書き・再開しません。

```sh
bun eval/tests/light-host-driver.fixture.ts run /absolute/path/to/config.json
```

1回の起動は指定した固定操作1件だけです。自動再試行・次のcaseの起動はありません。各操作の保存先を事前に分け、失敗後は記録を確認して止めます。この診断用の保存先分割を、比較runの時間・試行上限や停止を回避する方法にしません。

`run`は`127.0.0.1`の動的ポートだけへbindします。固定SSE以外へ要求を転送せず、認証不要・再送0のテスト専用providerを明示します。CLI自身へ渡す環境は`PATH`・合成の通常`HOME`（`cli-home`）・その配下のダミー`CODEX_HOME`（`cli-home/.codex`）・専用`TMPDIR`だけです。actorのコマンド用`HOME`はprofileで別の専用一時領域へ限定します。CLI用HOMEと認証領域はactorから保護し、ホーム全体の読取りを許可しません。`connection.json`には合成環境の対応も記録します。実キー・実認証を渡しません。profile生成・プロセス停止・成果物収集は対象版の既存補助を使い、旧sandboxと混在させません。

## 選ぶ固定操作

`light-host-driver.fixture.ts`の`lightHostCaseIds`で選択肢を確認できます。期待結果の正本はIssueと`light-host-cases.json`です。

- `inventory`は実行時工具一覧とraw要求を保存します。最初の宣言だけで不存在と判断せず、遅延公開も確認します。schema未取得なら読取り経路は未確認です。
- `boundary-TARGET-read`・`boundary-TARGET-shell-read`・`boundary-TARGET-write`はmanifestにある組合せだけを選べます。公開入力の読取り、workspace・一時領域の書込みを正常対照にし、保護4対象と未列挙scratch2対象を同じ操作で確認します。未列挙canaryの個別パスはprofileへ加えません。
- `read-tool-TARGET`は実一覧・実schemaから選んだ読取り工具を使います。設定へ`"readTool":{"name":"実一覧の名前","args":{"path":"$TARGET"}}`を加え、`args`は実schemaに合わせます。`$TARGET`だけを生成した合成パスへ置換します。工具未公開・引数不正を拒否成功にせず、コマンドreadで代用しません。
- `patch-public-input`と保護・未列挙対象の`patch-TARGET`は、既存固定応答へ`apply_patch(string)`の引数を機械的に接続します。公開入力への正常書込みと、保護対象への拒否を比較します。
- `mcp-resources`・`mcp-templates`・`mcp-read`は実工具への固定要求を記録します。登録済みの実MCPや資格情報は追加しません。工具の不存在、空一覧、明示的拒否、未実行を区別します。
- `scoping`・`initial`は正常固定操作です。初回応答にはschemaを渡します。`command-failure`は課題操作のexit 23、`missing-marker`は必要marker欠落です。CLI終了0・最終応答だけで要求充足にしません。
- `timeout`は4秒の期限、`interrupt-SIGINT`と`interrupt-SIGTERM`は通常の親子PID記録へ到達してからdriver自身へ各signalを送ります。他の操作は20秒です。いずれも既存`nativeCommand`の停止と最大30秒の後始末を使います。期限・割込みは記録後に非0で停止し、終了0へ変換しません。通常終了でも子処理の版・終了記録を照合します。
- `public-input`は固定公開planを配置して実工具一覧を取得します。設定へ`publicPlanFile`の絶対パスと`side`（`before`または`after`）を指定します。ホストは先にIssue所定のA/B・corpus・workspaceでplanを生成し、本文・versions・必要参照・公開範囲を照合します。driverは指定側の本文/hashを照合して同一配置し、固定skillを合成CLI用HOMEの`.agents/skills`へ登録します。通常登録と同名の固定skillはdeveloper指示の絶対パスで選択します。`publicSkill`は既定の`scoping`と`implement`を指定でき、後者では同じ側の`actorInputs`にある`completion-message`の初回担当入力・応答契約・準備記録を使います。担当入力の本文hashを確認し、公開軽量planの`/private/tmp/eval-light-trial/workspace/`または固定入力の`/work/repo/`で始まる参照を、今回のworkspace配下へ配置規則だけで変換して接続します。担当入力の他の本文と応答契約、準備記録は保持します。A/B×両skillの4通りを別々の保存先で確認してください。他方の資料で欠落を補いません。planのhash一致だけで公開性・合意・Git由来まで証明する機能ではありません。

networkは既存公開preflightの同一Bunによる前後正常対照と拒否診断を使います。このdriverへ同等操作を複製しません。

## 証拠と判定の限界

`prepared.json`には選択・配置・元/コピーhash・canaryの操作前本文/hashを保存します。`versions.json`にはCLI・Bun・Gitの実出力と実体hash、runner commit、参照した補助・driver・固定応答のhash、driverのBunを保存します。未commit差分も含む対象版の全体照合は既存ホスト経路で行います。`connection.json`に実argvとprofile、`request-N.json`と`response-N.sse`にraw要求と固定応答、`result.json`にstdout/stderr・終了・停止理由・後始末・request対応を保存します。

`after.json`にcanaryの操作後本文/hash、`process-observation.json`に合成PID記録と終了の追加観測、`artifacts/`と`artifacts.json`に既存収集処理の成果物を残します。PIDの不存在だけでプロセス群全体の終了を保証せず、既存のプロセス観測と照合します。失敗時は原記録と、保存可能なら`error.json`を残します。保存・要求不一致・容量超過・終了不明は停止です。ホスト記録は準備記録を含め16MiB、成果物は既存の1ファイル1MiB・合計8MiB・2,000件上限を維持します。ディスク全体のquotaではありません。

実コマンド・対象・fixtureのkind・終了・観測を照合し、対象へ到達した正常対照と拒否を確認します。ENOENT・構文不正・工具未公開・fixture未実行・時間切れ・終了不明・保存不成立を拒否成功にしません。拒否writeでは実操作のEACCES/EPERM等と原本文/hashの不変の両方が必要です。完了markerや不変hashだけでは裁定しません。公開工具のschemaと工具結果はraw要求・stdoutの両方から追い、必要な記録がなければ未確認を維持します。

通常テストは次の最小範囲です。設定・配置・上書き拒否、公開本文/hash、脱出パス、固定SSEとraw保存、不一致・保存失敗時の停止を、listenerなしの模擬呼出しで調べます。採用macOS/CLIの実境界、親子停止、実認証互換性、Issue全体の受入はこの成功から認定しません。

```sh
bun test eval/tests/light-host-driver.test.ts eval/tests/light-host-bundle.test.ts eval/tests/light-native-responses.test.ts
```
