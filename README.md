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

Bun 1.4.2を使います。checkはlint、書式、Biomeの認知的複雑度15、型、fallowの未使用コード検査、共有知識の生成物照合、ハーネスの制御テストの順に実行します。fallow 3.27.0も版固定の開発依存として上記setupで導入します。Playwrightや商品アプリの依存は導入しません。対象repoではそのrepoの検証を指定してください。商品・既存媒体・旧App版コードと実測履歴は[trial repo](https://github.com/thkt/dotagents-workflow-trial/blob/d0134086ad9bdddb5ed2693327cb1ffb0859c4a2/README.md)に残っています。

### 未使用コード検査とコードベース調査

`bun run check:unused`は、未使用ファイル・export・型・依存（dev・optionalを含む）の指摘を失敗にします。[実行入口](scripts/check-unused.ts)はfallowの終了失敗を引き継ぎ、終了0でもJSONの`workspace_diagnostics`に`degrades_analysis: true`があれば不合格にします。構文解析の中断や読取り不能などで不完全になった解析を、指摘なしの成功と扱わないためです。結果のJSONには指摘位置と診断が残ります。設定不正や起動失敗も成功に変換しません。CIの`checks`も同じ`bun run check`を使います。

[.fallowrc.json](.fallowrc.json)の`entry`には、外部から起動するCLIと`scripts/tests/**/*.test.ts`を指定し、`includeEntryExports`で入口のexportも検査します。`entry`は自動発見への追加指定です。`framework`ではOxlintが読み込む[ローカルプラグイン](scripts/lint/anti-slop/index.ts)の入口と`default` exportの利用を宣言します。このexportの利用は通常lintの実行テストでも確認します。他のexportやファイル・依存の未使用検査は維持します。使用判定を調べる場合は`bunx --no-install fallow list`で入口を、`bunx --no-install fallow dead-code --trace scripts/values.ts:isRecord`でexportの参照を確認してください。

整形は`bun run format`、書式確認は`bun run format:check`を使います。Oxfmtには`scripts`を渡し、[.oxfmtrc.json](.oxfmtrc.json)のignore指定で従来どおり`scripts/**/*.ts`だけを対象にします。package scriptにTSのglobを渡すと、fallowが整形対象を入口として追加し、未参照ファイルを見逃すためです。CLI・テストやformat設定を変えた際は、入口と検出条件も確認してください。

追加の調査は必要時に次を実行します。これらは共通checkに含めません。

| コマンド | 読み方 |
| --- | --- |
| `bun run analyze:duplicates` | 重複グループの場所と範囲を確認します。既定ではテスト等が除外されるため、`--explain-skipped`で対象外を確認します。必要なら`--mode semantic`で変数名等が異なる類似コードも調べます |
| `bun run analyze:complexity` | 関数の循環的・認知的複雑度やCRAPを認知的複雑度順で確認します。`--report-only`により指摘は失敗条件にしません。Biomeの上限15の検査は継続します |
| `bun run analyze:cycles` | ファイル間の循環経路を確認します。循環の指摘があれば終了1になりますが、共通checkには影響しません |

静的解析の参照や推定coverageは実行時の利用・テスト網羅を証明しません。CRAPの推定値や類似コードだけで自動削除・強制分割せず、呼出元、実際の利用条件、既存テストと照合して判断します。追加調査の指摘なしも、除外対象を含む全コードの健全性を保証しません。fallowの認知的複雑度とBiomeの判定が常に一致するとは扱いません。

採用範囲と条件付きの比較結果は[Issue #174](https://github.com/thkt/dotagents/issues/174)を参照してください。常に他ツールより速いことは保証しません。ツールの詳細は[公式設定](https://fallow.tools/docs/configuration/overview/)と[重複検査](https://docs.fallow.tools/analysis/duplication)を参照し、このrepoで使うオプションは導入済み3.27.0の`--help`でも確認してください。

[Issue #58の過去の検証報告](docs/evidence/harness-review-2026-09-14.md)は固定資料です。通常checkでは、この報告の形式検査やJSONとMarkdownの一致確認を行いません。現行の共有知識を扱う`knowledge:check`、runtimeの正常系・異常系の制御テスト、および共通checkとは別に行う[撮影の実検証](scripts/README.md#検証)は維持します。

## 要求整理とIssue作成

通常入口は共通登録済みの`scoping`と`implement`です。`scoping`は会話、既存のIssue下書き・Issue、必要なGit管理文書で要求・検証方法・合意を整理します。

[六つの問い](skills/scoping/references/sufficiency.md)で不足を判断し、判断を左右する不足や根拠変更があれば依存作業を止めます。専用セッションや評価保存CLIは使いません。Issueの記述と出典で足りる場合は報告を作らず、必要な根拠だけをresearch/へ直接保存・改訂します。

合意済みIssueは`implement`で実装します。CLIの絶対パスは信頼するスキル実体から解決し、実行対象repoのパスを渡します。操作は各[スキル](skills/scoping/SKILL.md)と[実装入口](skills/implement/SKILL.md)を参照してください。

共通環境の登録切替と新しいタスクでの移行受入は、2026-09-14に[Issue #54](https://github.com/thkt/dotagents/issues/54)で完了しました。採用版・受入結果は同Issueを、今後の保全と登録変更は[開発方針](.codex/DEVELOPMENT.md#旧資産の保全と登録変更)を参照してください。日常作業では上記のスキルと制御CLIの手順を使います。scopingの切替と新しいタスクでの確認は[切替手順](scripts/README.md#scopingの切替と手順確認)を参照してください。

新規起動の旧research・think・issue・build・code・cleanup入口と旧workflow hookは採用しません。旧資産や旧runは保全し、削除・変換・自動再開しません。
