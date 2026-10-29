---
name: setup-feedback-loop
description: JavaScript／TypeScriptのrepoへ静的検査と関連qualityテストの反復コマンドを導入・設定する。通常のimplementによる修正や、テスト分類だけの依頼には使わない。
---

# 検査と修正の反復を導入する

対象repoの既存検証を保ち、不足するツールの固定依存、診断用コマンド、implement・全体check・CIへの接続を用意する。新しい修正エンジンや常駐監視は作らない。通常のimplementを未導入repoへの自動導入の契機にしない。

## 導入前に確認する

合意済みIssue、対象repoの指示・README・テスト方針、採用commit・設定・作業中差分を確認する。初版の対象はnpm・BunとVitest・Bunテストである。[呼出し仕様](../../docs/wiki/setup-feedback-loop-contract.md)からCLIの入力・出力・失敗条件を確認する。CLIは信頼するスキル実体から`../../scripts/feedback-loop/setup.ts`を解決し、固定Bunで起動する。

`.dotagents.json`の変更を含む導入はそのrepoのimplementを開始する前に完了する。実行中のrunがある場合は設定を変更せず、現行の停止・終了手順を使う。旧runの設定や保存入力を補完して再開しない。導入後の設定は新しいrunで固定する。#447の個別検証の例外を転用しない。

## 導入する

1. `inspect --repo /absolute/project`で既存構成を調べる。package manager・runtime・lockfile、lint・formatter・型検査・参照解析、通常テストの収集と準備、全体check・coverage・build・CIを実際のコードへ照合する。不明な項目は採用済みと推測しない。
2. [ツール選定](references/tools.md)で既存ツールを優先し、不足分だけを固定版で導入する。初期候補はOxlint・Oxfmt・fallowであり、一律の採用指定ではない。`install`に確認したバージョンを渡し、devDependenciesとlockfileの差分を確認する。
3. [分類とrunnerの接続](references/runners.md)で通常checkの収集集合を保ち、`.feedback-loop.json`、静的検査の専用設定、診断用package scriptsを用意する。テスト・fixture・検証接続の変更は独立テスト担当へ渡す。未確認・新規テストはqualityへ残す。
4. `apply`へ採用した診断用コマンドを渡す。生成物とpackage scripts、`.dotagents.json.feedbackCheck`の差分を確認する。既存の同名コマンドや生成物との衝突は上書きせず、未完了箇所として報告する。設定・補助ファイルの更新を再実行で自動採用しない。
5. 採用した必須検査を既存の全体checkとCIへ追加する。既存のcoverage・build・準備・全テストを保つ。`test:*`等の一括実行へ`test:affected`が混入しないよう、従来の明示集合に接続し直す。この変更も独立テスト経路で確認する。
6. `check:classification`、`test:affected`、`check:feedback`と全体checkを確認する。採用した各検査は正常例、小さい既知の違反、修正後の再検査で診断と非ゼロ終了を確かめ、違反を残さない。依存導入・配置を再実行し、クリーンなcheckoutから固定依存だけで再現することも確認する。

## 完了と引き継ぎ

失敗した検査・対象・診断・再実行方法を既存findingsとログへ残す。起動失敗・解析不完全・取消・未実行を成功へ読み替えない。必須検査と参考レポート、未対応を区別し、未対応を導入完了に含めない。

依頼されたrepoの採用版と差分を導入直前に再確認し、そのrepoで検証を完了する。今回のIssue #466の初回展開では、共有の独立検証用repo、cantle、kaiの順に確認する。cantleの固定Bun・型依存照合・型検査・Python構文検査・直下テスト収集と、kaiの既存npm・ESLint・Prettier・Vitest・環境変数・codegen・DB準備・coverageを保つ。この2repoへの展開順を、別repoへの導入依頼には適用しない。DB利用だけでassuranceへ除外しない。複数repoを扱うときは、未完了のrepoを導入完了と報告しない。

実装・修正・独立テスト担当への`feedbackCheck`伝達は既存implementを使う。模擬コマンドの接続成功と、実モデルがコマンドを選んだ観測を区別する。提出前・各修正後のホスト全体check、独立評価、人の承認・マージを維持する。通常check外の受入検証は[ホスト検証](../../scripts/README.md#ホスト検証後の再評価)へ渡す。

変更文書には[yomiyasuと意味確認](../references/yomiyasu.md)を適用し、同じ差分の独立評価に含める。採用ツール・必須／参考の検査・実行範囲・対象commit・残る制約を既存findings・PR説明へ残し、別の監査台帳を作らない。非公開コード・内部ログを公開Issueへ転記しない。
