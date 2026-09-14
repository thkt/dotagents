# dotagents

合意した要求をGitHub Issueにまとめる`scoping`と、Issueを実装・検証して人のレビューへ渡す`implement`の共通ハーネスです。対象repoごとの技術構成、検証、必要媒体を設定します。

## 読む順序

- [開発方針](DEVELOPMENT.md): 要求の合意、文書・テスト・独立評価、人の承認。
- [制御CLI](scripts/README.md): 対象設定、起動、上限、中断、公開。
- [移行と受入](docs/migration-54.md): 取り込み版、保全・復帰、登録切替の未完了事項。

## セットアップと検証

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Bun 1.4.2を使います。checkはlint、書式、複雑度、型、ハーネスの制御テストです。Playwrightや商品アプリの依存は導入しません。対象repoではそのrepoの検証を指定してください。商品・既存媒体・実測履歴は[trial repo](https://github.com/thkt/dotagents-workflow-trial/blob/93b38f0bc690373b4b1f68e37a42f721929d6386/README.md)に残っています。

## 要求整理とIssue作成

共通登録後は`scoping`で要求・検証方法・合意を整理し、対象repoのIssueへ反映します。合意済みIssueは`implement`で実装します。CLIの絶対パスは信頼するスキル実体から解決し、実行対象repoのパスを渡します。操作は各[スキル](skills/scoping/SKILL.md)と[実装入口](skills/implement/SKILL.md)を参照してください。

新規起動の旧research・think・issue・build・code・cleanup入口とhookは採用しません。旧資産や旧runを削除・変換・自動再開する意味ではありません。現在のホスト登録は取り込みPRと別に確認・切替します。
