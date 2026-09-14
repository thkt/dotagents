# Issue #58の検証記録

対象は[Issue #58](https://github.com/thkt/dotagents/issues/58)と[PR #60](https://github.com/thkt/dotagents/pull/60)です。操作手順は[scripts/README.md](../../scripts/README.md)を参照してください。

## 対象版と結果

[機械可読の検証結果](harness-review-2026-09-14.json)に、検証したソースのSHA-256、コマンド、環境、シナリオ別の結果、媒体のサイズとSHA-256を記録しています。`base_commit`は今回の修正前の版、`source_sha256`は修正後に検証したファイルです。コミット前の差分も含むため、結果を再利用するときはファイルのSHA-256を照合します。ログから抽出した結果を掲載し、ホスト固有の絶対パスは`<fixture>`へ置き換えています。

| 確認 | 対象と結果 | JSON内の参照先 |
| --- | --- | --- |
| 撮影CLIの制御テスト | 修正後の12件が成功。CLI経由でも、有効媒体があるskipと指定spec未実行を拒否 | `control`、`source_sha256` |
| 実Playwright撮影 | Bun 1.4.2、Playwright 1.63.0、Chromiumで7シナリオ成功。相対testDir、探索範囲外のspec、依存project、webServer.cwd、checkout不変、0件・skip・失敗・不正媒体・起動不能を確認 | `capture`、`environment` |
| 不具合を入れた一時コピー | `capturePassed`の呼び出しを外すと、制御テストのskip・指定spec未実行の2件が失敗。実Chromiumのfixtureもskipの誤受入で停止 | `mutation` |
| 修正前の共通check・撮影・独立評価・日本語確認・CI | `c6a2100a450842fefc2f236c2efc99abbad01a4f`時点の記録。共通checkは199件成功、撮影7シナリオとexpect／相対CSS確認は成功。評価対象は保存manifestへ結び付け、今回の修正の評価には流用しない | `prior_commit` |

修正後の共通check、日本語確認、独立評価、公開後の同一headでのCIは、[PR #60](https://github.com/thkt/dotagents/pull/60)に対象commitとともに記載します。

## 回帰確認で守る条件

- 削除やrenameは実際のGitとcorrection入口を通し、検証後のstageやcommitによって成功記録と消費予算が変わらないこと、受入完了後の復元やモード変更を拒否することを確認します。要求、文書、必要な媒体の変更は既存テストでも検出します。
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

## 過去の実行と未確認範囲

旧実行における197件の成功、独立評価途中の`execution_limit`、初回の撮影失敗、Gemini確認の中断・スキップは[修正前の記録](https://github.com/thkt/dotagents/blob/c6a2100a450842fefc2f236c2efc99abbad01a4f/docs/evidence/harness-review-2026-09-14.md)に残しています。別セッションへの引き継ぎ時には撮影処理3ファイルのSHA-256を照合し、その後のexpect継承・相対CSS・macOS起動権限エラーの修正を再検証しました。過去の状態・消費予算・失敗記録は書き換えていません。

継続実行の最初の共通checkは終了コード137で中断しました。空PIDを読み込んで誤ったprocess groupを終了し得るfixtureを修正しましたが、中断原因は未確定です。旧版の0件・skip fixtureは実行判定の欠落を独立には検出できなかったため、今回修正しています。

修正前の文書に関するGemini確認はHTTP 429の利用枠超過、PR本文はtimeoutのため未実施でした。候補が存在しないため、候補の意味照合も未実施です。これらを今回の確認成功としては扱いません。

Firefox・WebKitの実撮影と、通常の実装から公開までを通す実モデルE2Eは未実施です。媒体の検査は形式識別であり、完全なデコードや表示品質は保証しません。人間が差分をレビューしてマージを判断します。
