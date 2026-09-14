# 共通環境への取り込みと登録切替

[Issue #54](https://github.com/thkt/dotagents/issues/54)の共通環境への取り込み・登録切替・新しいタスクでの移行受入は、2026-09-14に完了しました。この文書は公開済みIssue・PRに基づく採用版と結果、実施時の手順、保全・復帰条件を保持します。日常作業は[README](../README.md#要求整理とissue作成)と[制御CLI](../scripts/README.md)に従い、移行手順を毎回の確認には使いません。

## 採用版と範囲

依存[Issue #108](https://github.com/thkt/dotagents-workflow-trial/issues/108)は[PR #109](https://github.com/thkt/dotagents-workflow-trial/pull/109)でマージ済みです。取り込み元はtrialの`93b38f0bc690373b4b1f68e37a42f721929d6386`、共通環境の受入採用版は[PR #55](https://github.com/thkt/dotagents/pull/55)マージ後の`a2159d50501afe58eec7048029db7bd11febbb7c`です。scriptsの制御コード・テストを引き継ぎ、skillsと運用文書を共通環境の配置へ合わせました。package・lock・CIはハーネス検証に限定しています。

trialの[PR #111](https://github.com/thkt/dotagents-workflow-trial/pull/111)・[PR #112](https://github.com/thkt/dotagents-workflow-trial/pull/112)の差分を共有採用版と照合しました。ユーザー認証、`ciChecks`の`checks`・`verify`、`scripts/tests/discovery.test.ts`と`scripts/tests/support/correction.ts`のfixture実パス化は共有版に適用済みです。共通の運用は[開発方針](../DEVELOPMENT.md)と[撮影手順](../scripts/README.md#ホストによるブラウザー検証と撮影)に記載しています。trialの商品・旧App版コード・媒体・履歴はtrialに保持します。

旧版`5aafabc944bf78e6d0b7b224ae3ae207eca475fb`の追跡実装はGit履歴とホストの保全コピーから参照できます。旧未追跡資料・ignored資産・別worktree・保存庫は取り込み先へ混ぜず保全し、削除しません。旧OUTCOMEと旧hookを新方式の有効な指示として残しません。移行前のresearch資料は履歴資料として保持します。現行の調査成果の保存・共有は[researchの入口](../research/README.md)を参照してください。

## 2026-09-14の受入結果と未実施範囲

以下は[Issue #54の移行受入完了記録](https://github.com/thkt/dotagents/issues/54)に基づく過去の結果です。後続変更の検証成功を示すものではありません。

- 共有採用版の導入checkは制御183件が成功しました。新しいCodexタスクから共通スキル・CLIの採用版と、trialおよびBun/Playwrightに依存しない別repoの入口・対象解決を確認しました。共通スキルの実体、旧CLI・packageの6リンクとtrial側の重複スキルリンクの不在、対象・認証・公開権限の照合も確認しました。
- trial Issue #110の修正実測は通常のdevelopment入口からsetup、実モデルによる実装、独立した内容確認、撮影、check、独立評価、本人のgh認証によるPR #111作成とCI確認まで成功しました。対象headは`284c10973b39205cb163fad390947e88ed323aca`です。制御157件・runner契約5件・商品E2E45件、撮影4件・8媒体が成功し、同headの`checks`・`verify`、公開画像4枚の表示・配置と動画4本の最後までの再生を確認しました。
- 依頼者がPR #111・#112をマージし、trial mainを`d0134086ad9bdddb5ed2693327cb1ffb0859c4a2`へ同期しました。PR #112の検証済みheadとのtree一致、最新の[checks](https://github.com/thkt/dotagents-workflow-trial/actions/runs/34814299399/job/103881654425)・[verify](https://github.com/thkt/dotagents-workflow-trial/actions/runs/34814299399/job/103881883180)成功、`ciChecks`の反映と元の未追跡資料の保持を確認し、移行受入を完了しました。

別repoで確認したのは読取専用の入口・対象解決であり、今回新たな実装・公開は行っていません。修正実測に追加修正がなかったため、同一run内のMarkdown修正後の媒体再利用を実モデルで通過したとは扱いません。Geminiは依頼者の指定で省略し、独立した内容確認を用いました。Gemini確認済みとは扱いません。

旧環境への復帰、旧stateの変換・新形式での再開は実行していません。過去の失敗run・消費量・原記録、新旧環境の保全コピー・別worktreeは保持しています。受入完了は旧資産の削除許可ではありません。

## 実施時の保全・復元確認

以下の保全・登録切替・受入手順は、Issue #54の実施時に用いたものです。保全資産を維持し、復帰が必要になった場合は[復帰と停止条件](#復帰と停止条件)に従います。

ホスト担当は旧checkout、別worktree、依存、保存庫、登録設定を棚卸しします。ファイルのハッシュ・モード・symlinkをコピー前後で照合し、変更中なら切替を止めます。SQLiteはオンラインbackupとintegrity_checkを別に行い、稼働中のDBやGitの部分コピーを整合した保全とは扱いません。個人情報を含むバックアップ・実行ログはホスト側に保持し、公開repoへ取り込みません。

隔離した復元先でGitのworktree参照だけを復元先へ結び直し、HEAD・作業差分・履歴、SQLite整合性、旧依存とCLIリンクを確認します。実切替直前にもプロセス・所有者・ファイルの変化を再確認し、初回保全後の変更があれば追加保全と復元確認を行います。

## 実施時のマージ後の登録手順

1. 新規タスクと旧writerの起動を止め、`~/.agents`の追跡内容を人が承認した採用commitへ進めます。未追跡・ignored資産を上書きしないことと旧依存の保全を先に確認します。新lockで `bun install --frozen-lockfile --ignore-scripts` と `bun run check` を実行し、成功するまで新入口を利用しません。失敗時は保全した旧commit・依存・登録へ戻します。
2. `~/.agents/skills`でscoping・implementだけを新規入口として検出できる状態にします。旧入口の登録と、対象repo内の同名コピーは保全したうえで新規検出から外します。他のスキルやhookを一括削除しません。
3. PATH上の旧codex-research・codex-think・codex-issue・codex-workflow-hook・codex-post-edit、および残存する旧build・code・cleanup等の登録を棚卸しと照合して外します。復帰に必要なsymlinkの対応はホストの登録記録へ残します。新CLIはスキル実体のパスから呼び、旧bin互換を追加しません。
4. グローバル・repo・別worktreeのhookを確認します。旧workflow hookだけを対象とし、無関係なhookと保全中の別worktreeは変更しません。

## 実施時の受入手順

取り込みPRではハーネスcheck、独立評価、ユーザー認証の公開権限・作者、同commitのCIを確認します。登録変更は人のマージ後です。

その後、新しいタスクから共通スキルとCLIの採用版、trialとBun/Playwrightに依存しない別repoの対象解決を確認します。実際に変更・公開するrepoとIssueは実行前にIssue #54または試行Issueへ明記し、既存の許可範囲と照合します。未指定repoで公開しません。合意したIssueで要求整理・実装・検証・独立評価・ユーザー認証のPR・CI・人への引き渡しを確認します。必要媒体がある場合は公開後の表示・再生も確認します。

制御テストは、実モデル・登録・復元・公開の代わりではありません。合意した受入の未達があれば完了にせず、停止理由と残作業を記録する条件で実施しました。最終結果と実測で通過していない範囲は[上記の受入記録](#2026-09-14の受入結果と未実施範囲)に区別しています。

## 復帰と停止条件

対象や主体の不一致、資産の衝突・欠落、合意した受入の未達があれば新規実行を停止し、復帰手順へ戻します。Issue #54の媒体記録不一致による実測停止では、依頼者の指示で共有版を保持して修正し、復帰は実行しませんでした。この個別判断を他の停止条件の免除には使いません。

復帰時は新側の差分・状態・公開結果を先に保全し、旧commit・依存・登録設定の対応へ戻します。別worktreeと旧runは保全時の所有関係を維持し、新runtimeでは再開しません。公開済みIssue・PRはファイル復元で取り消さず、GitHub上の実状態を照合します。
