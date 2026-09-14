# dotagents

合意した要求をGitHub Issueにまとめる`scoping`と、Issueを実装・検証して人のレビューへ渡す`implement`の共通ハーネスです。対象repoごとの技術構成、検証、必要媒体を設定します。

## 読む順序

- [開発方針](DEVELOPMENT.md): 要求・公開範囲の合意、文書・テスト・独立評価、人のマージ判断とmain保護。
- [制御CLI](scripts/README.md): 対象設定、起動、上限、中断、公開。
- [調査成果](research/README.md): 再利用する根拠、未採用の提案、Gitによる共有と引き継ぎ。
- [移行と受入](docs/migration-54.md): 採用版、完了した登録切替・受入の結果と未実施範囲、保全・復帰条件。

## セットアップと検証

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Bun 1.4.2を使います。checkはlint、書式、複雑度、型、ハーネスの制御テストです。Playwrightや商品アプリの依存は導入しません。対象repoではそのrepoの検証を指定してください。商品・既存媒体・旧App版コードと実測履歴は[trial repo](https://github.com/thkt/dotagents-workflow-trial/blob/d0134086ad9bdddb5ed2693327cb1ffb0859c4a2/README.md)に残っています。

## 要求整理とIssue作成

通常入口は共通登録済みの`scoping`と`implement`です。`scoping`で要求・検証方法・合意を整理し、対象repoのIssueへ反映します。合意済みIssueは`implement`で実装します。CLIの絶対パスは信頼するスキル実体から解決し、実行対象repoのパスを渡します。操作は各[スキル](skills/scoping/SKILL.md)と[実装入口](skills/implement/SKILL.md)を参照してください。

共通環境の登録切替と新しいタスクでの移行受入は、2026-09-14に[Issue #54](https://github.com/thkt/dotagents/issues/54)で完了しました。実施時の手順・結果は[移行と受入](docs/migration-54.md)に保持しています。日常作業では上記のスキルと制御CLIの手順を使います。

新規起動の旧research・think・issue・build・code・cleanup入口と旧workflow hookは採用しません。旧資産や旧runは保全し、削除・変換・自動再開しません。
