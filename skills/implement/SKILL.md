---
name: implement
description: 合意済みGitHub Issueの実装依頼で、文書変更を含め検証・独立評価からPR作成・既存PRの修正まで進める。要求整理やレビューのみの依頼には使わない。
---

# Implement

合意済みIssueの要求を実装・検証し、独立評価とPR公開後の確認まで進める。

## 開始

依頼と会話から対象Issueを特定する。特定できなければ確認する。小さな変更や文書変更もIssueに紐づけ、今回に関係するリポジトリ指示・README・開発方針を読む。[対象repoの設定](../../scripts/README.md#対象repoの設定)でcheckout・Issue・remote・base branch・検証・必要媒体と実効ghユーザーの権限を照合する。不一致や権限不足では依存作業を止め、別の主体へ切り替えない。

[共通の文書利用手順](../references/documents.md#読む)で関連wiki・判断記録を選び、Issueと現行コードへ照合する。[調査成果の引き継ぎ](../scoping/references/session.md#調査成果の引き継ぎ)で必要な報告の内容・版・共有状態と合意範囲を確認する。判断を左右する事実不足は調べ、要求・権限の変更は人の合意へ戻す。

## 実装と検証

信頼するスキル実体から[実装CLI](../../scripts/implement/development.ts)を解決し、対象repoを指定する。対象repoにBunやPlaywrightの構成を推測で追加しない。

```sh
bun /absolute/path/to/trusted/scripts/implement/development.ts 99 --repo /absolute/path/to/target-checkout
```

報告が必要なら[CLIの引き継ぎ手順](../../scripts/README.md#調査報告を指定した実装開始)で同じpath・blob・開始commitを初回実装・修正・独立評価へ渡す。テストの不足を判断するときだけ[今回必要なテストの例](references/testing.md)を読み、既存検証が守る失敗条件を重ねてテストしない。差分が揃ったら[文書の更新手順](../references/documents.md#残す更新する)を確認し、変更文書を含めて[日本語確認の方針](../../.codex/DEVELOPMENT.md#pr本文人向け文書の日本語確認)と独立評価を適用する。

## 公開と引き継ぎ

明示的な開発依頼は、検証・独立評価と対象の再照合を経たdraft PR作成、その後の[公開後確認とreadyへの切替](../../scripts/README.md#公開後確認とreadyへの切替)までを含む。合意済みの作業ごとに許可を聞き直さない。スキルの自動選択だけを公開許可としない。「公開しない」指定は`--no-publish`へ渡し、独立評価後のローカル完了で止める。人のレビュー・承認・マージは代行しない。

人が採用した既存PRの修正は[既存PRの修正](../../scripts/README.md#既存prの修正)から同じCLIへ接続する。前回runと採用した指摘・期待する結果・許可範囲を渡し、PRコメントを自動採用せず、旧runを再開しない。停止した実行は[結果と再実行](../../scripts/README.md#結果と再実行)で理由と残る条件を確認し、停止条件や上限を緩めて続行しない。

公開後は最新本文・必要媒体・同じheadのCIを確認し、ready直前と切替後も対象を読み戻す。PR URL、確認した版と検証結果、残る人の判断、または停止理由と記録の場所を返す。
