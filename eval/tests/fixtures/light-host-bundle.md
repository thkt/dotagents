# モデルなし確認の接続資産

[Issue #405](https://github.com/thkt/dotagents/issues/405)（本文更新2026-10-18T07:24:28Z）の固定操作を、新しい保存先へ再生成します。CLI・provider・サーバー・実認証・比較モデルは起動しません。生成成功は実効境界やChatGPT認証成功の証拠ではありません。

接続設定JSONには、ホストが確認した採用Bunの絶対パス・版、合成workspace、合成canaryと操作、実際に公開される読取りツールのnameとschemaに従う引数を指定します。一覧未取得なら`readTools`を空配列にし、未確認を維持します。

```json
{
  "bunExecutable": "/absolute/path/to/bun",
  "bunVersion": "1.4.3",
  "workspace": "/private/tmp/new-synthetic-workspace",
  "targets": [
    { "kind": "read", "path": "/private/tmp/new-public-input.txt" },
    { "kind": "shell-read", "path": "/private/tmp/new-dummy-auth.txt" },
    { "kind": "write", "path": "/private/tmp/new-private-canary.txt" }
  ],
  "readTools": []
}
```

```sh
bun eval/tests/light-host-bundle.fixture.ts /private/tmp/new-host-bundle /absolute/path/to/synthetic-connection.json
```

保存先は存在しないディレクトリを指定します。失敗時も部分記録を保持し、上書き・再開しません。`manifest.json`に設定と各生成物のSHA-256を保存します。指定パスをprofileへ自動追加しません。固定応答は既存の`nativeFixedResponses`・`nativeBoundaryResponses`・`nativeToolInventoryResponses`・`nativeReadToolResponses`を再利用し、steps/SSE形式を維持します。

生成した境界fixtureだけを許可workspaceへbyte同一で配置し、元・生成物・配置後のhashを照合します。manifest・期待値・採点情報を比較actorへ渡しません。固定応答の接続先はテスト専用のローカルproviderとし、外部推論先や実アカウントへ接続しません。providerの起動はこの生成処理の範囲外です。

既存の`light-host-cases.json`に従い、通常読取り・書込み・課題検証の正常対照と、合成canaryの実拒否を確認します。未存在・引数不正・未到達・時間切れを拒否成功にしません。公開読取りツールとコマンドを別々に確認します。期限・SIGINT・SIGTERMは親子到達後に観測し、通常の子処理を含む終了、後始末30秒以内、原記録保全、後続起動0を確認します。採用CLI・Bun・Git・runner・profile・fixtureの版とhashを同じ観測へ結び付けます。

## 保存・計時・証拠の対応を調べるテスト

```sh
bun test eval/tests/light-observation.test.ts eval/tests/light-evidence.test.ts
```

`light-observation.test.ts`は公開`eval/light.ts run CONFIG`を子プロセスで呼びます。入力準備・版・認証確認・境界判定・`nativeCommand`は合成に置換し、回収・保存と試行列は実処理を使います。実CLI・実sandbox・親子停止の保証は既存の別検証で確認します。モックと論理時計は子プロセス内だけに適用します。共通checkへ実モデルや外部通信を接続しません。

正常な4試行と容量枠内の大きいログを対照に、起動時の出力枠内でも回収manifestを加えると合計16MiBを超える入力、終了JSONの保存で初めて超える入力を検査します。各成果物は1byte、件数も上限内です。保存ファイルの合計と後続起動を観測し、actor出力単体の検査では代用しません。

回収の実読取り完了、保存の実書込み完了で論理時計を進め、準備から記録完了までの操作枠100ms超過を検査します。操作10msと終了観測200msの正常対照では、別枠30秒を維持します。壁時計の速さを合否の閾値にしません。前回案のcallback全体79ms／81msだけの検査は採用しません。別枠の後始末を失敗扱いする可能性と、実際の回収・保存へ未接続という限界があるためです。

`light-evidence.test.ts`は安定した合成境界証拠と、最初の本文取得後に同じ参照先を不合格本文へ置換する入力を比較します。検査済みsnapshotの本文とhashの対応、または置換後の不合格版の拒否を要求し、内部読取り回数は固定しません。合成のpassed証拠を実効境界の成立とは扱いません。

基点048ff72991c7a8d800c031ce829509b34f3337ffには軽量入口と補助がありません。接続不能を狙ったRedに数えず、転送後は修正前の提示版70cc98c3と現在版を区別して、同じ正常対照・違反入力を実行してください。実アカウントでの互換性、採用macOS/CLIの境界、Issue全体の受入は別途未確認です。
