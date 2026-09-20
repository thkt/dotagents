# dotagents

合意した要求をGitHub Issueにまとめる`scoping`と、Issueを実装・検証して人のレビューへ渡す`implement`の共通ハーネスです。対象repoごとの技術構成、検証、必要媒体を設定します。

## 読む順序

- [開発方針](.codex/DEVELOPMENT.md): 要求・公開範囲の合意、文書・テスト・独立評価、人のマージ判断とmain保護。
- [制御CLI](scripts/README.md): 対象設定、起動、上限、中断、公開。
- [実装開始の共有知識](docs/knowledge/implementation-start.md): JSON正本から生成した目的・概念・規則。選択・改訂の操作は[制御CLI](scripts/README.md#共有知識の選択)。
- [調査成果](research/README.md): 再利用する根拠、未採用の提案、Gitによる共有と引き継ぎ。

## セットアップと検証

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Bun 1.4.2を使います。checkはlint、書式、複雑度、型、共有知識の生成物照合、ハーネスの制御テストです。Playwrightや商品アプリの依存は導入しません。対象repoではそのrepoの検証を指定してください。商品・既存媒体・旧App版コードと実測履歴は[trial repo](https://github.com/thkt/dotagents-workflow-trial/blob/d0134086ad9bdddb5ed2693327cb1ffb0859c4a2/README.md)に残っています。

[Issue #58の過去の検証報告](docs/evidence/harness-review-2026-09-14.md)は固定資料です。通常checkでは、この報告の形式検査やJSONとMarkdownの一致確認を行いません。現行の共有知識を扱う`knowledge:check`、runtimeの正常系・異常系の制御テスト、および共通checkとは別に行う[撮影の実検証](scripts/README.md#検証)は維持します。

## 要求整理とIssue作成

通常入口は共通登録済みの`scoping`と`implement`です。`scoping`は会話、既存のIssue下書き・Issue、必要なGit管理文書で要求・検証方法・合意を整理します。

[六つの問い](skills/scoping/references/sufficiency.md)で不足を判断し、判断を左右する不足や根拠変更があれば依存作業を止めます。専用セッションや評価保存CLIは使いません。Issueの記述と出典で足りる場合は報告を作らず、必要な根拠だけをresearch/へ直接保存・改訂します。

合意済みIssueは`implement`で実装します。CLIの絶対パスは信頼するスキル実体から解決し、実行対象repoのパスを渡します。操作は各[スキル](skills/scoping/SKILL.md)と[実装入口](skills/implement/SKILL.md)を参照してください。

共通環境の登録切替と新しいタスクでの移行受入は、2026-09-14に[Issue #54](https://github.com/thkt/dotagents/issues/54)で完了しました。採用版・受入結果は同Issueを、今後の保全と登録変更は[開発方針](.codex/DEVELOPMENT.md#旧資産の保全と登録変更)を参照してください。日常作業では上記のスキルと制御CLIの手順を使います。scopingの切替と新しいタスクでの確認は[切替手順](scripts/README.md#scopingの切替と手順確認)を参照してください。

新規起動の旧research・think・issue・build・code・cleanup入口と旧workflow hookは採用しません。旧資産や旧runは保全し、削除・変換・自動再開しません。
