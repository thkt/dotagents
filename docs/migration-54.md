# 共通環境への取り込みと登録切替

[Issue #54](https://github.com/thkt/dotagents/issues/54)を段階的に実施します。この取り込みPRは登録切替の準備です。マージだけでIssue全体を完了にせず、実登録と新しいタスクでの受入を残します。

## 採用版と範囲

依存[Issue #108](https://github.com/thkt/dotagents-workflow-trial/issues/108)は[PR #109](https://github.com/thkt/dotagents-workflow-trial/pull/109)でマージ済みです。取り込み元は`93b38f0bc690373b4b1f68e37a42f721929d6386`。scriptsの制御コード・テストを引き継ぎ、skillsと運用文書を共通環境の配置へ合わせます。package・lock・CIはハーネス検証に限定します。

旧版`5aafabc944bf78e6d0b7b224ae3ae207eca475fb`の追跡実装はGit履歴とホストの保全コピーから参照できます。旧未追跡資料・ignored資産・別worktree・保存庫は取り込み先へ混ぜず保全し、削除しません。旧OUTCOMEと旧hookを新方式の有効な指示として残しません。researchの既存資料は履歴資料として保持します。

## 保全と復帰

ホスト担当は旧checkout、別worktree、依存、保存庫、登録設定を棚卸しします。ファイルのハッシュ・モード・symlinkをコピー前後で照合し、変更中なら切替を止めます。SQLiteはオンラインbackupとintegrity_checkを別に行い、稼働中のDBやGitの部分コピーを整合した保全とは扱いません。個人情報を含むバックアップ・実行ログはホスト側に保持し、公開repoへ取り込みません。

隔離した復元先でGitのworktree参照だけを復元先へ結び直し、HEAD・作業差分・履歴、SQLite整合性、旧依存とCLIリンクを確認します。実切替直前にもプロセス・所有者・ファイルの変化を再確認し、初回保全後の変更があれば追加保全と復元確認を行います。

復帰時は新側の差分・状態・公開結果を先に保全し、旧commit・依存・登録設定の対応へ戻します。別worktreeと旧runは保全時の所有関係を維持し、新runtimeでは再開しません。公開済みIssue・PRはファイル復元で取り消さず、GitHub上の実状態を照合します。

## マージ後の登録差分

1. 新規タスクと旧writerの起動を止め、`~/.agents`の追跡内容を人が承認した採用commitへ進めます。未追跡・ignored資産を上書きしないことと旧依存の保全を先に確認します。新lockで `bun install --frozen-lockfile --ignore-scripts` と `bun run check` を実行し、成功するまで新入口を利用しません。失敗時は保全した旧commit・依存・登録へ戻します。
2. `~/.agents/skills`でscoping・implementだけを新規入口として検出できる状態にします。旧入口の登録と、対象repo内の同名コピーは保全したうえで新規検出から外します。他のスキルやhookを一括削除しません。
3. PATH上の旧codex-research・codex-think・codex-issue・codex-workflow-hook・codex-post-edit、および残存する旧build・code・cleanup等の登録を棚卸しと照合して外します。復帰に必要なsymlinkの対応はホストの登録記録へ残します。新CLIはスキル実体のパスから呼び、旧bin互換を追加しません。
4. グローバル・repo・別worktreeのhookを確認します。旧workflow hookだけを対象とし、無関係なhookと保全中の別worktreeは変更しません。

## 受入と停止条件

取り込みPRではハーネスcheck、独立評価、ユーザー認証の公開権限・作者、同commitのCIを確認します。登録変更は人のマージ後です。

その後、新しいタスクから共通スキルとCLIの採用版、trialとBun/Playwrightに依存しない別repoの対象解決を確認します。実際に変更・公開するrepoとIssueは実行前にIssue #54または試行Issueへ明記し、既存の許可範囲と照合します。未指定repoで公開しません。合意したIssueで要求整理・実装・検証・独立評価・ユーザー認証のPR・CI・人への引き渡しを確認します。必要媒体がある場合は公開後の表示・再生も確認します。

制御テストは、実モデル・登録・復元・公開の代わりではありません。対象や主体の不一致、資産の衝突・欠落、未達があれば新規実行を停止し、上記の復帰手順へ戻します。未実施項目を残したままIssue #54を完了にしません。
