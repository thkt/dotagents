# Issue #58の検証記録

[Issue](https://github.com/thkt/dotagents/issues/58) / [PR](https://github.com/thkt/dotagents/pull/60) / [操作手順](../../scripts/README.md)

検証結果と判断の正本はJSONです。Markdownはそこから生成します。文章確認で修正する場合もJSONに反映して再生成してください。AIも同じJSONを参照します。 [正本JSON](harness-review-2026-09-14.json)

再生成: `bun run evidence:generate`。一致確認: `bun run evidence:check`（`bun run check`にも含まれます）。

生成結果の一致確認では、表示に必要な項目とMarkdownの一致を確認します。記録内容の正しさや要求の達成は、出典との照合と独立評価で確認します。

## 対象版と実測

対象版: [`1babf0de087b49dcb89f61bde8e2cae6c54a759a`](https://github.com/thkt/dotagents/tree/1babf0de087b49dcb89f61bde8e2cae6c54a759a)。修正前: `c6a2100a450842fefc2f236c2efc99abbad01a4f`。

対象版のソースのSHA-256、コマンド、環境、シナリオ別の結果、媒体のサイズとSHA-256をJSONに記録しています。結果を再利用する際は、対象ファイルのSHA-256を照合してください。

レポートの集計と診断は保存した実行ログから抽出し、終了コードとcheckoutの不変性は完了した検証実行で確認しました。ホスト固有の絶対パスは`<fixture>`へ置き換え、元のログは実行ホストに保持しています。

この文書整理に対する共通check、日本語確認、独立評価、公開後の同一headでのCIは、PRに対象commitとともに記録します。下記の実測は、現在の変更全体への評価としては扱いません。

制御テスト: 12件成功、0件失敗、終了コード0。コマンド: `bun test scripts/tests/capture.test.ts scripts/tests/capture-browser-errors.test.ts`。

有効媒体があるskipと指定spec未実行を、CLI経由で拒否することを確認しています。

環境: Bun 1.4.2 / Playwright 1.63.0 / chromium / PLAYWRIGHT_BROWSERS_PATH=0。dotagents-workflow-trialの既存の依存を使用し、依存の追加インストールは行っていません。

相対testDir、探索範囲外のspec、依存project、webServer.cwd、checkoutの不変性、ならびに0件・skip・失敗・不正媒体・起動不能を確認しています。

コマンド: `PLAYWRIGHT_BROWSERS_PATH=0 bun scripts/verify-capture.ts TARGET_REPO chromium`

TARGET_REPO: Playwright 1.63.0とそのChromiumが導入済みのrepoへの絶対パス

実撮影の検証: passed（7シナリオ）。集計は依存projectを含みます。

| シナリオ | 期待終了コード | 終了コード照合 | checkout不変 | expected / skipped / unexpected / flaky |
| --- | --- | --- | --- | --- |
| normal | 0 | passed | passed | 2 / 0 / 0 / 0 |
| outside | 0 | passed | passed | 2 / 0 / 0 / 0 |
| skipped | 1 | passed | passed | 1 / 1 / 0 / 0 |
| zero | 1 | passed | passed | 1 / 0 / 0 / 0 |
| failed | 1 | passed | passed | 1 / 0 / 1 / 0 |
| invalid-media | 1 | passed | passed | 2 / 0 / 0 / 0 |
| unavailable | 78 | passed | passed | 1 / 0 / 1 / 0 |

## 不具合注入による検出確認

対象: `scripts/capture.ts`。範囲: 一時コピーのみ。

`code === 0 && capturePassed(value, spec),` を `code === 0,` に置き換えました。

制御テスト: 10件成功、2件失敗、終了コード1。コマンド: `bun test scripts/tests/capture.test.ts scripts/tests/capture-browser-errors.test.ts`。

| 検出ケース | 期待するadapter終了コード | 実際のadapter終了コード |
| --- | --- | --- |
| skipped | 1 | 0 |
| missing_spec | 1 | 0 |

実撮影: `PLAYWRIGHT_BROWSERS_PATH=0 bun scripts/verify-capture.ts TARGET_REPO chromium` は終了コード1となり、`skipped` で停止しました。診断: `AssertionError: skipped: expected 1`。

不具合を入れた実撮影では、0件のシナリオには到達していません。指定spec未実行の拒否は制御テストで確認しています。

## 回帰確認で守る条件

- 削除やrenameは実際のGitとcorrection入口を通します。検証後のstageやcommitによって成功記録と消費予算が変わらないこと、受入完了後の復元やモード変更を拒否することを確認します。要求、文書、必要な媒体の変更は既存テストでも検出します。
- 撮影の0件およびskipのケースでは、依存projectが有効なPNGを生成します。空媒体による失敗で実行判定の欠落を見逃さないよう、媒体の有効性と実行判定による停止理由を確認します。指定specの未実行とskipは共通テストでも個別に検出します。
- Markdown保護では、インデント付きfence、リスト内コード、インデントコード、参照形式の相対リンクや画像、ならびにそれらの順序と個数を確認します。frontmatter、コード表記、URL、hash、Issue参照の保護と、独立した意味評価も維持します。
- checkoutは公式v5.0.0の完全SHA `08c6903cd8c0fde910a37f88322edcfb5dd907a8` へ固定しています。[該当commit](https://github.com/actions/checkout/commit/08c6903cd8c0fde910a37f88322edcfb5dd907a8)でNode 24対応を確認し、最小権限、`persist-credentials: false`、依存固定、凍結lockfile、およびinstall scriptsの無効化を維持しています。

## テスト整理の判断

| 整理した対象 | 省いた検出条件・負担 | 残した検証 |
| --- | --- | --- |
| developmentのfixture | trial固有のBunコマンド列と、各Bun呼び出しに成功を返す分岐を除去。商品固有のコマンド文字列はこのfixtureでは確認しない | 共通の対象設定で実shell setupを実行。媒体あり・なし、対象repo・remote・Issueの不一致、権限変更、branch/HEAD変更、二重実行、公開前後の停止と原checkout保全を維持。設定されたcheckも媒体なしのケースで実行 |
| 文章確認のparserだけのprocessケース3件 | 不正JSON・モデル違い・未知statusごとのCLI起動と、同一の失敗内容の重複確認を省略。これらの各入力とOSプロセス異常の全組み合わせは確認しない | parser入口で各不正応答を拒否。実processでは成功応答後の非zero終了、原因不明の失敗、サービス障害、逐次ログ、正常終了を維持 |
| 文章確認のtimeoutケース2件 | init行だけで止まる専用ケースを削除し、不完全なresult行で止まるケースへ統合 | モデルtimeoutの分類、原文保全、未完了stdout・stderrの保存、子プロセス終了を同時に確認。ホストtimeoutの別境界も維持 |
| CI待機 | 実時間の1秒待機と短い締め切りに依存するテストを除去。OSタイマーの実精度は測定しない | 本番と同じ待機ループへ時計とsleepを注入し、必須checkの登録待ち・締め切り・未完了・失敗・同一head・中断を確認。本番の既定値は単調時計と標準timer |
| 公開失敗 | `list_failed`専用の例外伝播ケースを削除。一覧取得固有の通信失敗を独立ケースでは確認しない | `create_failed`で公開API失敗の伝播、一覧取得中の中断による後続公開の抑止を確認。既存PRの再利用、本文・作者・主体・権限の一致、意図しない対象・refへの公開防止は維持 |

プロセス検証のfixtureでは、作成直後の空PIDファイルを読み終えたと誤認しないよう待機し、正の有効なPIDのみを終了対象にします。中断、二重実行、子プロセス終了、ログ保全の検証条件は変えていません。

Issue不一致をdevelopment入口で拒否するケースは残しました。parser単独の確認だけでは、入口が照合を呼び出さなくなる不具合を検出できないためです。件数の維持自体は判断基準にしていません。

## プロセス実装を維持した理由

ホストの`command`はdetached process group、中断時の予約保全、timeout後の終了通知を補うpoll、終了時の残存子プロセス処理を担います。`runWritingCommand`はホストのgroupを継承し、モデルの途中出力を逐次保存して、親の終了後に残るpipeを解放します。責務とgroupの所有者が異なり、同一のspawn記述へまとめても条件分岐が増加します。Bun標準APIへの置換のみでは、固定Bun版における終了通知・pipe drain・子孫終了が同等であると確認できていないため、今回は両方の実装を保持しました。中断、timeout、子プロセス、UTF-8、ログに関する既存のprocessテストは残しています。

## 修正前の検証と過去の実行

対象: [`c6a2100a450842fefc2f236c2efc99abbad01a4f`](https://github.com/thkt/dotagents/tree/c6a2100a450842fefc2f236c2efc99abbad01a4f)。この版の評価を別の版へ流用しません。

| 確認 | 記録 |
| --- | --- |
| 共通check | `bun run check`: 199件成功、0件失敗 |
| 実撮影 | Playwright 1.63.0 / chromium: 7シナリオ成功 |
| 独立評価 | accepted |
| 文書の日本語確認 | 未実施: service_unavailable（HTTP 429） |
| PR本文の日本語確認 | 未実施: timeout |
| 候補の意味照合 | 未実施: Gemini候補がないため |
| CI checks | [SUCCESS](https://github.com/thkt/dotagents/actions/runs/34846507947/job/103983649925) |
| CI verify | [SUCCESS](https://github.com/thkt/dotagents/actions/runs/34846507947/job/103983843373) |

修正前のfixtureでは、capturePassedの呼び出しを外した不具合を独立には検出できませんでした。

旧実行における197件の成功、独立評価途中の`execution_limit`、初回の撮影失敗、Gemini確認の中断・スキップは[修正前の記録](https://github.com/thkt/dotagents/blob/c6a2100a450842fefc2f236c2efc99abbad01a4f/docs/evidence/harness-review-2026-09-14.md)に残しています。別セッションへの引き継ぎ時には撮影処理3ファイルのSHA-256を照合し、その後のexpect継承・相対CSS・macOS起動権限エラーの修正を再検証しました。過去の状態・消費予算・失敗記録は書き換えていません。

継続実行の最初の共通checkは終了コード137で中断しました。空PIDを読み込んで誤ったprocess groupを終了し得るfixtureを修正しましたが、中断原因は未確定です。旧版の0件・skip fixtureは実行判定の欠落を独立には検出できなかったため、今回修正しています。

## 未確認範囲

- Firefox・WebKitの実撮影
- 通常の実装から公開までを通す実モデルE2E
- 媒体の完全なデコードと表示品質（媒体検査は形式識別のみ）

人間が差分をレビューしてマージを判断します。
