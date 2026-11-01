# Bun内蔵の型検査を接続する

Bunを日常実行に使うrepoでは、固定したBunの`bun check --no-script`を反復中の型検査の候補にする。追加の型検査パッケージは導入しない。npm・Nodeだけで動くrepoにはBunを追加せず、既存の型検査を保つ。

## 既存範囲と採用条件を確認する

既存package scriptsと実際の準備処理・CIを読み、型検査が使うtsconfig、CLIの上書きオプション、生成物、project references、型テスト、補助スクリプトの検査を確認する。`files`・`include`・`exclude`・`extends`と参照先を維持し、テストからimportされないソースやassuranceも型検査から落とさない。関連テストの選択集合や変更ファイルの一覧を、型検査の対象に流用しない。

対象repoの固定Bunで`bun check --help`と`bun --no-env-file -p 'process.versions.typescript'`を確認する。Bun 1.4.4で確認した対応TypeScriptは7.0.2である。導入先でも同じとは仮定せず、既存TypeScriptの版・設定・診断へ照合する。機能がない版をこの作業だけで自動更新しない。

[公式仕様](https://bun.com/docs/runtime/check)の次の違いを導入版で確認する。

- `bun check`は同名のpackage scriptを優先する。内蔵型検査には必ず`--no-script`を付け、全体checkの再帰起動や意図しないテスト実行を避ける。
- `-p`で既存のtsconfigを指定する。既存が参照先も検査する`tsc -b`なら`-b`を使い、参照先の診断も確認する。複数の独立したtsconfigは、それぞれ実行する。
- 型検査だけを行い、JavaScript・`.d.ts`・`.tsbuildinfo`は生成しない。既存の型生成・build・codegen・framework専用検査を置き換えない。
- `bun test --check`やファイル指定は検査範囲が異なるため、プロジェクト単位の型検査の代わりにしない。

型エラーがないことだけで互換性を認定しない。設定・型定義・既知の型エラーの診断を比較し、差が未解決なら既存の型検査を使う。検査を通す目的でstrictnessを下げたり、対象や診断を除外したりしない。既存の全体check・CIの型検査は保ち、その置換は別の合意と検証で扱う。

## 既存の入口へ接続する

package scriptsで実行順序を表し、`.feedback-loop.json`の既存`prepare`を使う。共通runnerへ型検査専用の設定キーは追加しない。

準備処理がないrepoでは、例えば`typecheck:feedback`を`bun check --no-script -p tsconfig.json`とし、`check:feedback`から関連テストの前に一度呼ぶ。必要なcodegen等があるrepoでは、生成後に型検査が走る順序を保つ。

型検査を含む準備処理が既にあるrepoでは、反復用の準備入口で型検査部分だけをBunへ接続する。依存版の照合、環境変数、codegen、Python構文検査等の既存処理を保つ。通常checkが同じ準備関数を使う場合も、通常の呼出しは既存の型検査を使うようにする。`check:feedback`の直下と`prepare`の両方で同じ型検査を実行しない。

cantleで導入担当が用意する例は次のとおり。`--prepare-feedback`は既存の公開CLIにあるフラグではなく、対象repoへ追加して確認する入口である。

1. 反復用の準備入口で固定依存の版を照合し、`bun check --no-script -p tsconfig.type-tests.json`と、記録器を検査する`bun check --no-script -p tsconfig.feedback-loop.json`を実行する。既存の起動引数も維持する。
2. 既存のPython構文検査を一度実行し、準備だけで終了する。`tsconfig.feedback-loop.json`は実際の補助スクリプト検査用設定を確認して用意し、既存の型検査と同じ対象・条件を保つ。
3. `.feedback-loop.json`の`prepare`を`["bun", "--no-env-file", "scripts/test.ts", "--prepare-feedback"]`へ接続する。型検査のコマンドが複数でも、準備入口は一度だけ呼ぶ。
4. `test:affected`の前に準備を重ねず、`check:feedback`から既存の`test:affected`を呼ぶ。通常の準備入口と全体checkは既存の型検査・全テストを維持する。

この例のtsconfig名や準備フラグを別repoへ一律に作らない。実際の検査範囲と既存の接続に合わせる。検証接続の変更は独立テスト担当が扱い、生成物更新時には既存の衝突検出とローカル変更の保全に従う。

## 接続後に確認する

採用版と実際の`check:feedback`を使い、次を独立テストと導入先の確認へ含める。正常・失敗・復帰のログと、導入前後の検査対象を残す。

- 正常な入力で型検査・既存準備・関連qualityが完了する。各型検査の対象と実行回数を確認する。
- 既存範囲内で関連テストからimportされないファイルにも既知の型エラーを置き、診断と非ゼロ終了を確認する。複数設定や参照先がある場合は、それらの検査漏れを判定できる対照を選ぶ。型検査の失敗後にテスト本体へ進まないことも確認する。
- 型エラーだけを修正し、同じ入口が再び成功する。失敗を無視したり、型検査を外したりして復帰させない。
- 既存の`check`スクリプトがある状態で、内蔵型検査から全体checkを起動しない。設定不正や起動不能も非ゼロ終了として扱う。
- 検証のための違反を除去し、通常check・CIの型検査、型生成・build、準備処理と全テストの範囲が維持されていることを確認する。

型検査の速度とループ全体の速度は分ける。採用のために新しく測る場合だけ[性能測定の手順](../../references/performance-measurement.md)を使い、別のTypeScript版同士の比較や未検証の診断差を隠さない。固定の速度閾値は設けない。
