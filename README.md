# dotagents

合意した要求をGitHub Issueにまとめる`scoping`と、Issueを実装・検証して人のレビューへ渡す`implement`の共通ハーネスです。要求と完了条件は合意済みIssue、実行・検証・公開確認はホスト、承認とマージは人が担います。対象repoごとの技術構成、検証、必要媒体を設定します。

## 読む順序

- このREADMEの[共有入口と利用条件](#共有入口と利用条件): メンバーが依存する入口、必要な版、結果の参照先。
- [開発方針](docs/wiki/development-policy.md): 要求・公開範囲の合意、文書・テスト・独立評価、人のマージ判断とmain保護。
- [制御CLI](scripts/README.md): 対象設定、起動、上限、中断、公開。
- [実装開始の条件](docs/wiki/implementation-start.md): 現行の開始条件と適用範囲。根拠の引き継ぎと旧選択の扱いは[制御CLI](scripts/README.md#調査報告を指定した実装開始)。
- [調査成果](docs/research/README.md): 再利用する根拠、未採用の提案、Gitによる共有と引き継ぎ。

- [現在の知識](docs/wiki/README.md)・[判断記録](docs/decisions/README.md): このrepoの手順・構造と、その選択理由。Claude／Codex共通の[読む・残す方法](skills/references/documents.md)を使います。

## 共有入口と利用条件

メンバーが依存してよい入口は、次のスキル、対象設定、文書で案内するCLIと結果の参照方法です。変更時は[開発方針](docs/wiki/development-policy.md#変更に応じた確認)に従い、利用条件と観測できる結果を照合します。

| 入口 | 利用条件と参照先 |
| --- | --- |
| `scoping` | 要求・検証方法・合意を整理し、Issueまたは公開しない下書きへ渡します。[スキル](skills/scoping/SKILL.md)から必要な参照を辿ります |
| `implement` | 合意済みIssueを受け取り、信頼するスキル実体からCLIを解決して対象repoを指定します。[スキル](skills/implement/SKILL.md)と[通常起動](scripts/README.md#issueからpr作成)・[既存PR修正](scripts/README.md#既存prの修正)に従います |
| 対象repoの `.dotagents.json` | checkoutルートのコミット済み設定を使います。repo・remote・base branch、setup・check・CI・必要媒体を明示します。[設定形式と拒否条件](scripts/README.md#対象repoの設定)が正本です |
| 文書で案内するCLI・package script | 呼出し方と用途は[CLI手順](scripts/README.md)、導入・checkは[セットアップと検証](#セットアップと検証)で確認します。通常利用と担当者向けの単独試行を区別します |
| 指示変更のeval | 関連する改善作業で、版・ケース・モデル・有限上限を固定して比較します。[実行条件と報告](scripts/README.md#指示変更時の同条件eval)から手動で開始し、定期実行や全PRの必須ゲートにはしません |
| 実行結果 | developmentのrun保存先で `result.json` から理由・次の対応・証拠を辿ります。`report.html`は保存結果の表示です。[結果と再実行](scripts/README.md#結果と再実行)で下位state・生ログと生成できない条件を確認します |

共通登録されたスキルが信頼する同じハーネス実体を参照することが前提です。利用するハーネスのcommitと実体パスを確認し、その版の手順・lockfileを使います。ハーネスはBun 1.4.2、Git、gh、Codex CLIを使い、現在の対応環境はmacOSホストとgithub.comです。Git・gh・Codex CLIの共通の最低版は定めていません。必要な機能や既存認証は[CLI手順](scripts/README.md#issueからpr作成)で確認し、対象repoの言語・検証ツールは対象設定に従います。登録変更は[保全と登録変更の方針](docs/wiki/development-policy.md#旧資産の保全と登録変更)に従い、新しいタスクで実体・版・対象解決を確認します。

内部のTypeScript export、参照されているだけのファイル、fallowの`entry`全体を公開契約にはしません。静的な未使用判定は、上記の入口やrepo外の利用の互換性を証明しません。メンバーごとの環境と、repo外から内部exportを使う実例は未確認です。利用実態が見つかった場合は対象と必要な保証を明示し、合意する範囲を見直します。

## セットアップと検証

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Bun 1.4.2を使います。checkはlint、書式、Biomeの認知的複雑度15、型、fallowの未使用コード・循環依存検査、ハーネスの制御テストの順に実行します。fallow 3.27.0も版固定の開発依存として上記setupで導入します。Playwrightや商品アプリの依存は導入しません。対象repoではそのrepoの検証を指定してください。商品・既存媒体・旧App版コードと実測履歴は[trial repo](https://github.com/thkt/dotagents-workflow-trial/blob/d0134086ad9bdddb5ed2693327cb1ffb0859c4a2/README.md)に残っています。

[biome.json](biome.json)は、版固定したBiome 2.5.14の既定値（linterの有効化と認知的複雑度の上限15）を使い、`noExcessiveCognitiveComplexity`を`error`に指定しています。Biomeの版更新時は、この既定値と上限超過時のerrorによる拒否を再確認してください。

### 未使用コード検査とコードベース調査

`bun run check:unused`は、未使用ファイル・export・型・依存（dev・optionalを含む）と実行時importの循環の指摘を失敗にします。[実行入口](scripts/lint/fallow.ts)はfallowの終了失敗を引き継ぎ、終了0でもJSONの`workspace_diagnostics`に`degrades_analysis: true`があれば不合格にします。構文解析の中断や読取り不能などで不完全になった解析を、指摘なしの成功と扱わないためです。結果のJSONには指摘位置と診断が残ります。設定不正や起動失敗も成功に変換しません。CIの`checks`も同じ`bun run check`を使います。

[Issue #147](https://github.com/thkt/dotagents/issues/147)で合意した循環検出は、同じfallow実行の`--circular-deps`で行います。保証範囲はfallowが解析できる実行時importの循環に限ります。型のみの参照は循環として拒否せず、非循環の逆向き依存や全ての責務境界を検査するものではありません。これらは調査・レビューで判断し、実行時の権限・鮮度・停止・データ保全は既存の制御テストと独立評価で確認します。循環検査のための追加の適用除外は設けません。

[.fallowrc.json](.fallowrc.json)の`entry`には、外部から起動するCLIを自動発見への追加入口として指定します。固定版fallow 3.27.0では、`scripts/tests/**/*.test.ts`をBunプラグインが、Oxlintが読み込む[ローカルプラグイン](scripts/lint/local/index.ts)をOxlintプラグインが自動検出します。`includeEntryExports`で入口のexportも検査し、カスタム`framework`の`usedExports`と`enablers`では、Oxlint有効時の`default` exportの利用を宣言します。このexportの利用は通常lintの実行テストでも確認します。未使用ファイル・export・型・通常依存は既定の`error`を使い、既定が`warn`のdev・optional依存は明示的に`error`とします。他のexportやファイル・依存の未使用検査は維持します。fallowの版を更新する際は、既定重大度と自動入口検出を再確認してください。使用判定を調べる場合は`bunx --no-install fallow list`で入口を、`bunx --no-install fallow dead-code --trace scripts/shared/values.ts:isRecord`でexportの参照を確認してください。

整形は`bun run format`、書式確認は`bun run format:check`を使います。Oxfmtには`scripts`を渡し、[.oxfmtrc.json](.oxfmtrc.json)のignore指定で従来どおり`scripts/**/*.ts`だけを対象にします。package scriptにTSのglobを渡すと、fallowが整形対象を入口として追加し、未参照ファイルを見逃すためです。CLI・テストやformat設定を変えた際は、入口と検出条件も確認してください。

追加の調査は必要時に次を実行します。これらのコマンド自体は共通checkに含めません。循環検出は`check:unused`でも行います。

| コマンド | 読み方 |
| --- | --- |
| `bun run analyze:duplicates` | 重複グループの場所と範囲を確認します。既定ではテスト等が除外されるため、`--explain-skipped`で対象外を確認します。必要なら`--mode semantic`で変数名等が異なる類似コードも調べます |
| `bun run analyze:complexity` | 関数の循環的・認知的複雑度やCRAPを認知的複雑度順で確認します。`--report-only`により指摘は失敗条件にしません。Biomeの上限15の検査は継続します |
| `bun run analyze:cycles` | ファイル間の実行時importの循環経路を調べる入口です。循環の指摘があれば終了1になります。同じ循環検出を共通checkの`check:unused`にも含めます |

静的解析の参照や推定coverageは実行時の利用・テスト網羅を証明しません。CRAPの推定値や類似コードだけで自動削除・強制分割せず、呼出元、実際の利用条件、既存テストと照合して判断します。追加調査の指摘なしも、除外対象を含む全コードの健全性を保証しません。fallowの認知的複雑度とBiomeの判定が常に一致するとは扱いません。

採用範囲と条件付きの比較結果は[Issue #174](https://github.com/thkt/dotagents/issues/174)を参照してください。常に他ツールより速いことは保証しません。ツールの詳細は[公式設定](https://fallow.tools/docs/configuration/overview/)と[重複検査](https://docs.fallow.tools/analysis/duplication)を参照し、このrepoで使うオプションは導入済み3.27.0の`--help`でも確認してください。

[Issue #58の過去の検証報告](docs/research/harness-review-2026-09-14.md)は固定資料です。通常checkでは、この報告の形式検査やJSONとMarkdownの一致確認を行いません。runtimeの正常系・異常系の制御テスト、および共通checkとは別に行う[撮影の実検証](scripts/README.md#検証)は維持します。

## 要求整理とIssue作成

通常入口は共通登録済みの`scoping`と`implement`です。`scoping`は会話、既存のIssue下書き・Issue、必要なGit管理文書で要求・検証方法・合意を整理します。

[六つの問い](skills/scoping/references/sufficiency.md)で不足を判断し、判断を左右する不足や根拠変更があれば依存作業を止めます。専用セッションや評価保存CLIは使いません。Issueの記述と出典で足りる場合は報告を作らず、必要な根拠だけをdocs/research/へ直接保存・改訂します。

合意済みIssueは`implement`で実装します。CLIの絶対パスは信頼するスキル実体から解決し、実行対象repoのパスを渡します。操作は各[スキル](skills/scoping/SKILL.md)と[実装入口](skills/implement/SKILL.md)を参照してください。

共通環境の登録切替と新しいタスクでの移行受入は、2026-09-14に[Issue #54](https://github.com/thkt/dotagents/issues/54)で完了しました。採用版・受入結果・未計測範囲は同Issueを、今後の保全と登録変更は[開発方針](docs/wiki/development-policy.md#旧資産の保全と登録変更)を参照してください。日常作業では上記のスキルと制御CLIの手順を使い、移行手順を通常タスクの前提にはしません。scopingの切替と新しいタスクでの確認は[切替手順](scripts/README.md#scopingの切替と手順確認)を参照してください。

新規起動の旧research・think・issue・build・code・cleanup入口と旧workflow hookは採用しません。旧資産や旧runは保全し、削除・変換・自動再開しません。
