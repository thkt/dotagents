---
name: setup-feedback-loop
description: JavaScript／TypeScriptのrepoへ静的検査と関連qualityテストの反復コマンド（check:feedback・test:affected・check:classification）を導入・設定する。通常の修正や、テスト分類だけの依頼には使わない。
---

# 検査と修正の反復を導入する

対象repoの既存検証を保ち、不足するツールの固定依存、診断用コマンド、全体check・CIへの接続と、Claude Codeが反復中に`check:feedback`を使う指示を用意する。新しい修正エンジンや常駐監視は作らない。

## 導入前に確認する

依頼の範囲、対象repoの指示・README・テスト方針、採用commit・設定・作業中差分を確認する。対象はnpm・BunとVitest・Bunテストである。[呼出し仕様](references/contract.md)からCLIの入力・出力・失敗条件を確認する。

CLIはスキルに同梱した`${CLAUDE_SKILL_DIR}/scripts/setup.mjs`である。Bun 1.4.4で`bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs inspect --repo /absolute/project`のように起動する。Bunが1.4.4でなければ導入を止め、利用者にBun 1.4.4の用意を依頼する。このCLIは対象repoの`.dotagents.json`を読まず書かない。`scripts/`の生成物は直接編集しない。

## 導入する

1. `inspect --repo /absolute/project`で既存構成を調べる。package manager・runtime・lockfile、lint・formatter・型検査・参照解析、通常テストの収集と準備、全体check・coverage・build・CIを実際のコードへ照合する。不明な項目は採用済みと推測しない。
2. [ツール選定](references/tools.md)で既存ツールを優先し、不足分だけを固定版で導入する。初期候補はOxlint・Oxfmt・fallowであり、一律の採用指定ではない。`install`に確認したバージョンを渡し、devDependenciesとlockfileの差分を確認する。Bunプロジェクトの型検査は[内蔵型検査の接続手順](references/typecheck.md)で`bun check --no-script`を候補にし、固定版の機能・既存範囲・互換性を確認して採用する。
3. [分類とrunnerの接続](references/runners.md)で通常checkの収集集合を保ち、`.feedback-loop.json`、静的検査の専用設定、診断用package scriptsを用意する。
4. `apply`へ採用した診断用コマンドを渡す。生成物とpackage scriptsの差分を確認する。既存の同名コマンドや生成物との衝突は上書きせず、未完了箇所として報告する。設定・補助ファイルの更新を再実行で自動採用しない。
5. 収集集合の全テストファイルを読み、[全テストの分類と確認記録](references/runners.md#全テストの分類と確認記録)でquality／assuranceを判断する。ファイル名・件数・キーワードの一致だけで確認済みとしない。assuranceは`.feedback-loop.json`へ理由付きで指定し、全ファイルの分類・根拠・確認したファイル内容のSHA-256を`.feedback-loop-review.json`へ記録する。`check:classification -- --complete`の成功は記録が揃ったことだけを示す。分類の意味は[分類の独立評価](references/runners.md#分類の独立評価)で、分類に関わっていないsubagentか新しいセッションに照合させる。そのacceptと`--complete`の成功の両方を全件分類の完了条件とする。
6. 採用した必須検査を既存の全体checkとCIへ追加する。既存のcoverage・build・準備・全テストを保つ。`test:*`等の一括実行へ`test:affected`が混入しないよう、従来の明示集合に接続し直す。
7. `check:classification`、`test:affected`、`check:feedback`と全体checkを確認する。設定変更の影響を除いた通常のソース変更で、必要なqualityが実行され、無関係なqualityとassuranceが除外されることを確認する。Bunでは標準の一括選択と補完依存、`--isolate`と採用した並列数での全qualityの互換性を検証し、[ファイル別の完了・失敗・取消の条件](references/runners.md)も確認する。採用した各検査は正常例、小さい既知の違反、修正後の再検査で診断と非ゼロ終了を確かめ、違反を残さない。型検査は[検査範囲と失敗・復帰の確認](references/typecheck.md#接続後に確認する)も行う。依存導入・配置を再実行し、クリーンなcheckoutから固定依存だけで再現することも確認する。
8. [Claude Codeとの接続](references/claude-code.md)で、反復中に`check:feedback`を使う指示を対象repoのCLAUDE.mdかhookへ用意する。

## 完了と引き継ぎ

失敗した検査・対象・診断・再実行方法を報告に残す。起動失敗・解析不完全・取消・未実行を成功へ読み替えない。必須検査と参考レポート、未対応を区別し、未対応を導入完了に含めない。

`check:classification -- --complete`が失敗する間と、分類の独立評価がacceptになるまでは、導入時の全件分類を完了と報告しない。導入後の日常実行では、未確認・古い記録のテストもqualityとして実行し、全体checkとCIを止めない。日常の`check:classification`は該当する件数とpathを表示する。

`src/**`等を一括で`globalChanges`へ指定し、通常変更でも常に全qualityを実行する状態は、関連テストの絞り込みを確認したことにならない。全件実行が必要な共通入力と、内容を確認した`dependencies`を分ける。対応が不明な入力の全件実行は保ち、絞り込みが未確認の範囲を報告する。

CLAUDE.mdやhookへの接続を確認したことと、Claude Codeが反復中に実際に`check:feedback`を実行した観測は区別して報告する。採用ツール・必須／参考の検査・実行範囲・対象commit・残る制約は、対象repoのPR説明か既存の記録先へ残し、別の監査台帳を作らない。非公開コード・内部ログを公開Issueへ転記しない。
