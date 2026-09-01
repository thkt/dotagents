---
name: build
description: issueワークフローが公開したreceipt 1件を、検証済みの実装単位ごとにコミットし、明示的な許可がある場合は下書きPRまで作成する。Issue公開後の実装を最初から最後まで進める明示的な依頼に使用する。
---

# Build

`codex-flow describe --workflow build`で現在のワークフロー契約と Plan 契約を確認する。shell ゲートの証拠を選ぶときは、[shell ゲートの証拠](../../workflows/flow/references/shell-gate.md)を読む。

## 入力

- issue が生成した公開済み receipt を使用する。存在しない場合は、引き渡し不足として停止する。
- GitHub の title や本文から Plan を再構成したり補ったりしない。

## 権限

- tested unit の Plan file が workflow 開始時点で存在しない場合、その file は Red actor と Green actor の双方の allowed files に含める。既存 file の Red/Green 分割は許可する。
- このワークフローは、宣言したローカルブランチの作成と、検証済み実装単位のコミットを許可する。
- push と下書き PR 作成をユーザーが両方とも明示的に許可した場合だけ`Ship`を含める。
- PR の title と人が読む説明には Codex で設定された言語を使用する。GitHub keyword、識別子、path、command、テスト名は変更しない。
- 追加 Issue の候補は報告するだけで、作成しない。

## エスカレーション

契約外の設計不足は `think` に戻し、事実・証拠不足は `research` に戻す。機械的な実装・テスト失敗はローカルで修正する。

## 報告

終了状態、実行定義のハッシュ、ブランチと基準コミット、検証済みの実装単位とコミット、ゲートの証拠、修正回数、`Ship`の状態、存在する場合は検証済み PR URL を報告する。PR URL は`Ship`の検証が成功した後だけ報告する。
