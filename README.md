# dotagents

合意した要求を GitHub Issue にまとめる`scoping`と、Issue を実装・検証して人のレビューに渡す`implement`の共通ハーネスです。要求と完了条件は合意済みの Issue が、実行・検証・公開の確認はホストが、承認とマージは人が担います。対象 repo ごとに、技術構成、検証、必要な媒体を設定します。

## 読む順序

qww
- [開発方針](docs/wiki/development-policy.md)には、要求と公開範囲の合意、文書・テスト・独立評価、人によるマージ判断と main の保護があります。
- [制御CLI](scripts/README.md)には、対象の設定、起動、上限、中断、公開があります。
- [実装開始の条件](docs/wiki/implementation-start.md)には、現在の開始条件と適用範囲があります。根拠の引き継ぎと旧選択の扱いは、[制御CLI](scripts/README.md#調査報告を指定した実装開始)にあります。
- [調査成果](docs/research/README.md)には、再利用する根拠、未採用の提案、Git での共有と引き継ぎがあります。
- [現在の知識](docs/wiki/README.md)と[判断記録](docs/decisions/README.md)には、この repo の手順・構造と、その選択理由があります。Claude／Codex 共通の[読む・残す方法](skills/references/documents.md)に従います。

## 共有入口と利用条件

メンバーが依存してよい入口は、次のスキル、対象設定、文書で案内する CLI と、結果の参照方法です。変更するときは[開発方針](docs/wiki/development-policy.md#変更に応じた確認)に従い、利用条件と観測できる結果を突き合わせます。

| 入口 | 利用条件と参照先 |
| --- | --- |
| `scoping` | 要求・検証方法・合意を整理し、Issueまたは公開しない下書きに渡します。必要な参照は[スキル](skills/scoping/SKILL.md)から辿ります |
| `implement` | 合意済みIssueを受け取ります。信頼するスキル実体からCLIを解決し、対象repoを指定します。[スキル](skills/implement/SKILL.md)、[通常起動](scripts/README.md#issueからpr作成)、[既存PR修正](scripts/README.md#既存prの修正)に従います |
| 対象repoの `.dotagents.json` | checkoutルートにコミット済みの設定を使います。repo・remote・base branch、setup・check・CI、必要な媒体を明示します。[設定形式と拒否条件](scripts/README.md#対象repoの設定)が正本です |
| 文書で案内するCLI・package script | 呼び出し方と用途は[CLI手順](scripts/README.md)、導入とcheckは[セットアップと検証](#セットアップと検証)で確認します。通常の開発と、担当者向けの1回レビュー試行は区別します。旧単独修正CLIの移行先は[実行方式と旧設定](scripts/README.md#実行方式と旧設定)で確認します |
| 指示変更のeval | 関連する改善作業で、バージョン・ケース・モデル・有限の上限を固定して比較します。[実行条件と報告](scripts/README.md#指示変更時の同条件eval)から手動で開始します。定期実行や全PRの必須ゲートにはしません |
| 実行結果 | developmentのrun保存先にある `result.json` から、理由・次の対応・証拠を辿ります。`report.html`は保存結果の表示です。下位state・生ログと、生成できない条件は[結果と再実行](scripts/README.md#結果と再実行)で確認します |

共通登録されたスキルが、信頼する同じハーネス実体を参照することが前提です。利用するハーネスの commit と実体パスを確認し、そのバージョンの手順と lockfile を使います。ハーネスが使うのは Bun 1.4.2、Git、gh、Codex CLI で、現在の対応環境は macOS ホストと github.com です。Git・gh・Codex CLI に共通の最低バージョンは定めていません。必要な機能と既存の認証は[CLI手順](scripts/README.md#issueからpr作成)で確認し、対象 repo の言語・検証ツールは対象設定に従います。登録を変更するときは[保全と登録変更の方針](docs/wiki/development-policy.md#旧資産の保全と登録変更)に従い、新しいタスクで実体・バージョン・対象の解決を確認します。

内部の TypeScript export、参照されているだけのファイル、fallow の`entry`全体は、公開契約にしません。静的な未使用判定では、上記の入口や repo 外での利用の互換性は証明できません。メンバーごとの環境と、repo 外から内部 export を使う実例は未確認です。利用実態が見つかったら、対象と必要な保証を明示し、合意する範囲を見直します。

## セットアップと検証

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Bun 1.4.2 を使います。check は、lint、書式、Biome の認知的複雑度 15、型、fallow の未使用コード・循環依存の検査、ハーネスの制御テストの順に実行します。fallow 3.28.0 もバージョンを固定した開発依存で、上記の setup で導入します。Playwright や商品アプリの依存は導入しません。対象 repo では、その repo の検証を指定してください。商品・既存媒体・旧 App 版のコードと実測履歴は、[trial repo](https://github.com/thkt/dotagents-workflow-trial/blob/d0134086ad9bdddb5ed2693327cb1ffb0859c4a2/README.md)に残っています。

[biome.json](biome.json)は、バージョンを固定した Biome 2.5.14 の既定値（linter の有効化と認知的複雑度の上限 15）を使い、`noExcessiveCognitiveComplexity`を`error`にしています。Biome のバージョンを更新するときは、この既定値と、上限を超えたときに error で拒否されることを再確認してください。

### 未使用コード検査とコードベース調査

`bun run check:unused`は、未使用のファイル・export・型・依存（dev・optional を含む）と、実行時 import の循環が指摘されると失敗します。[実行入口](scripts/lint/fallow.ts)は、fallow の終了時の失敗を引き継ぎます。終了コードが 0 でも、JSON の`workspace_diagnostics`に`degrades_analysis: true`があれば不合格にします。構文解析の中断や読み取り不能などで不完全になった解析を、指摘なしの成功として扱わないためです。結果の JSON には、指摘の位置と診断が残ります。設定の不正や起動の失敗も、成功に変換しません。CI の`checks`も同じ`bun run check`を使います。

[Issue #147](https://github.com/thkt/dotagents/issues/147)で合意した循環の検出は、同じ fallow 実行の`--circular-deps`で行います。保証するのは、fallow が解析できる実行時 import の循環に限ります。型のみの参照は循環として拒否しません。循環していない逆向きの依存や、責務境界のすべては検査しません。これらは調査とレビューで判断します。実行時の権限・鮮度・停止・データ保全は、既存の制御テストと独立評価で確認します。循環検査のために追加する適用除外は設けません。

[.fallowrc.json](.fallowrc.json)の`entry`には、外部から起動する CLI を、自動発見への追加の入口として指定します。バージョンを固定した fallow 3.28.0 では、`scripts/tests/**/*.test.ts`を Bun プラグインが、Oxlint が読み込む[ローカルプラグイン](scripts/lint/local/index.ts)を Oxlint プラグインが自動で検出します。`includeEntryExports`で入口の export も検査します。カスタム`framework`の`usedExports`と`enablers`では、Oxlint が有効なときの`default` export の利用を宣言します。この export の利用は、通常の lint の実行テストでも確認します。未使用のファイル・export・型と通常の依存には既定の`error`を使い、既定が`warn`の dev・optional 依存は明示的に`error`にします。他の export と、ファイル・依存の未使用検査も維持します。fallow のバージョンを更新するときは、既定の重大度と入口の自動検出を再確認してください。使用判定を調べるには、入口を`bunx --no-install fallow list`で、export の参照を`bunx --no-install fallow dead-code --trace scripts/shared/values.ts:isRecord`で確認してください。

整形は`bun run format`、書式の確認は`bun run format:check`を使います。Oxfmt には`scripts`を渡し、[.oxfmtrc.json](.oxfmtrc.json)の ignore 指定で、従来どおり`scripts/**/*.ts`だけを対象にします。package script に TS の glob を渡すと、fallow が整形対象を入口として追加し、未参照のファイルを見逃すためです。CLI・テストや format 設定を変えたときは、入口と検出条件も確認してください。

追加の調査は、必要なときに次を実行します。これらのコマンド自体は共通 check に含めません。循環の検出は`check:unused`でも行います。

| コマンド | 読み方 |
| --- | --- |
| `bun run analyze:duplicates` | 重複グループの場所と範囲を確認します。既定ではテストなどが除外されるので、`--explain-skipped`で対象外を確認します。変数名などが異なる類似コードも調べるときは、`--mode semantic`を使います |
| `bun run analyze:complexity` | 関数の循環的複雑度・認知的複雑度・CRAPを、認知的複雑度の順に確認します。`--report-only`により、指摘は失敗条件にしません。Biomeの上限15の検査は続きます |
| `bun run analyze:cycles` | ファイル間の実行時importの循環経路を調べる入口です。循環が指摘されると終了コード1になります。同じ循環検出は、共通checkの`check:unused`にも含まれます |

静的解析の参照と推定 coverage は、実行時の利用やテストの網羅を証明しません。CRAP の推定値や類似コードだけで、自動削除や強制分割はしません。呼び出し元、実際の利用条件、既存のテストと突き合わせて判断します。追加調査で指摘がなくても、除外対象を含む全コードの健全性は保証されません。fallow の認知的複雑度と Biome の判定が常に一致するとは扱いません。

採用範囲と条件付きの比較結果は[Issue #174](https://github.com/thkt/dotagents/issues/174)を参照してください。他のツールより常に速いことは保証しません。ツールの詳細は[公式設定](https://fallow.tools/docs/configuration/overview/)と[重複検査](https://docs.fallow.tools/analysis/duplication)を参照してください。この repo で使うオプションは、導入済みの 3.28.0 の`--help`でも確認してください。

[Issue #58の過去の検証報告](docs/research/harness-review-2026-09-14.md)は固定された資料です。通常の check では、この報告の形式検査や、JSON と Markdown の一致確認を行いません。runtime の正常系・異常系の制御テストと、共通 check とは別に行う[撮影の実検証](scripts/README.md#検証)は維持します。

## 要求整理とIssue作成

通常の入口は、共通登録済みの`scoping`と`implement`です。`scoping`は、会話、既存の Issue 下書きと Issue、必要な Git 管理文書から、要求・検証方法・合意を整理します。

[六つの問い](skills/scoping/references/sufficiency.md)で不足を判断します。判断を左右する不足や根拠の変更があれば、それに依存する作業を止めます。専用セッションと評価保存 CLI は使いません。Issue の記述と出典で足りるときは報告を作らず、必要な根拠だけを docs/research/に直接保存・改訂します。

合意済みの Issue は`implement`で実装します。CLI の絶対パスは信頼するスキル実体から解決し、実行対象 repo のパスを渡します。操作は各[スキル](skills/scoping/SKILL.md)と[実装入口](skills/implement/SKILL.md)を参照してください。

共通環境の登録切替と、新しいタスクでの移行受け入れは、2026-09-14 に[Issue #54](https://github.com/thkt/dotagents/issues/54)で完了しました。採用したバージョン・受け入れ結果・未計測の範囲は同 Issue を、今後の保全と登録変更は[開発方針](docs/wiki/development-policy.md#旧資産の保全と登録変更)を参照してください。日常の作業では上記のスキルと制御 CLI の手順を使い、移行手順を通常タスクの前提にはしません。scoping の切替と、新しいタスクでの確認は[切替手順](scripts/README.md#scopingの切替と手順確認)を参照してください。

新規起動での旧 research・think・issue・build・code・cleanup の入口と、旧 workflow hook は採用しません。旧資産と旧 run は保全し、削除・変換・自動再開はしません。
