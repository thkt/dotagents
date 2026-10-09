# dotagents

合意した要求を GitHub Issue にまとめる`scoping`と、Issue を実装・検証して人のレビューに渡す`implement`の共通ハーネスです。要求と完了条件は合意済みの Issue が、実行・検証・公開の確認はホストが、承認とマージは人が担います。対象 repo ごとに、技術構成、検証、必要な媒体を設定します。

## 読む順序

- このREADMEの[共有入口と利用条件](#共有入口と利用条件)には、メンバーが依存する入口、必要なバージョン、結果の参照先があります。
- [開発方針](docs/wiki/development-policy.md)には、要求と公開範囲の合意、文書・テスト・独立評価、人によるマージ判断と main の保護があります。
- [制御CLI](scripts/README.md)には、対象の設定、起動、上限、中断、公開があります。
- [実装開始の条件](docs/wiki/implementation-start.md)には、現在の開始条件と適用範囲があります。根拠の引き継ぎは、[制御CLI](scripts/README.md#調査報告を指定した実装開始)にあります。
- [調査成果](docs/research/README.md)には、再利用する根拠、未採用の提案、Git での共有と引き継ぎがあります。
- [現在の知識](docs/wiki/README.md)と[判断記録](docs/decisions/README.md)には、この repo の手順・構造と、その選択理由があります。Claude／Codex 共通の[読む・残す方法](skills/references/documents.md)に従います。

## 共有入口と利用条件

メンバーが依存してよい入口は、次のスキル、対象設定、文書で案内する CLI と、結果の参照方法です。変更するときは[開発方針](docs/wiki/development-policy.md#変更に応じた確認)に従い、利用条件と観測できる結果を突き合わせます。

| 入口 | 利用条件と参照先 |
| --- | --- |
| `scoping` | 要求・検証方法・合意を整理し、Issueまたは公開しない下書きに渡します。必要な参照は[スキル](skills/scoping/SKILL.md)から辿ります |
| `implement` | 合意済みIssueを受け取り、テスト作成と実装を別セッションで扱います。方針は[開発方針](docs/wiki/development-policy.md#実装とテストの整理)に従います。信頼するスキル実体からCLIを解決し、対象repoを指定します。[スキル](skills/implement/SKILL.md)、[通常起動](scripts/README.md#issueからpr作成)、[既存PR修正](scripts/README.md#既存prの修正)に従います |
| 対象repoの `.dotagents.json` | checkoutルートの設定は必須です。commit・pushは任意で、リポジトリへの登録による共有を推奨します。repo・remote・base branch、setup・check・CI、必要な媒体を明示します。[設定形式と拒否条件](scripts/README.md#対象repoの設定)が正本です |
| 文書で案内するCLI・package script | 呼び出し方と用途は[CLI手順](scripts/README.md)、導入とcheckは[セットアップと検証](#セットアップと検証)で確認します。通常の開発と、担当者向けの1回レビュー試行は区別します |
| 指示変更のeval | 関連する改善作業で、バージョン・ケース・モデル・有限の上限を固定して比較します。[実行条件と報告](scripts/README.md#指示変更時の同条件eval)から手動で開始します。定期実行や全PRの必須ゲートにはしません |
| 実行結果 | developmentのrun保存先にある `result.json` から、理由・次の対応・証拠を辿ります。`report.html`は保存結果の表示です。下位state・生ログと、生成できない条件は[結果と再実行](scripts/README.md#結果と再実行)で確認します |

共通登録されたスキルが、信頼する同じハーネス実体を参照することが前提です。利用するハーネスの commit と実体パスを確認し、そのバージョンの手順と lockfile を使います。必要なのは Bun 1.4.2、Git、gh、Codex CLI で、対応環境は macOS ホストと github.com です。Git・gh・Codex CLI の最低バージョンは定めていません。必要な機能と既存の認証は[CLI手順](scripts/README.md#issueからpr作成)で確認します。登録を変更するときは[保全と登録変更の方針](docs/wiki/development-policy.md#旧資産の保全と登録変更)に従います。

内部の TypeScript export、参照されているだけのファイル、fallow の`entry`全体は、公開契約にしません。repo 外から内部 export を使う実例は未確認です。利用が見つかったら、対象と必要な保証を明示し、合意する範囲を見直します。

## セットアップと検証

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Bun 1.4.2 を使います。check は次の順に実行します。ツールごとに検査する対象を分けています。fallow 3.31.0 もバージョンを固定した開発依存で、上記の setup で導入します。

| 順 | package script | ツール | 検査する対象 |
| --- | --- | --- | --- |
| 1 | `lint` | oxlint | 型情報を使う正しさの検査と、[ローカルプラグイン](scripts/lint/local/index.ts)の規則。警告も失敗にします |
| 2 | `format:check` | oxfmt | `scripts/**/*.ts`の書式だけ |
| 3 | `complexity` | Biome | 認知的複雑度の上限 15 だけ。formatter と他の規則は無効です |
| 4 | `typecheck` | tsc | 型の整合 |
| 5 | `check:unused` | fallow | 未使用のファイル・export・型・依存と、実行時 import の循環 |
| 6 | `test:control` | Bun | ハーネスの制御テスト |
対象 repo では、その repo の検証を指定してください。

[biome.json](biome.json)は、バージョンを固定した Biome 2.5.15 の既定値（linter の有効化と認知的複雑度の上限 15）を使い、`noExcessiveCognitiveComplexity`を`error`にしています。Biome のバージョンを更新するときは、この既定値と、上限を超えたときに error で拒否されることを再確認してください。

### 未使用コード検査とコードベース調査

`bun run check:unused`は、未使用のファイル・export・型・依存と、実行時 import の循環を検査します。fallow の解析が不完全なときは不合格にします。設定と保証範囲は[CLI手順](scripts/README.md#未使用コード検査とコードベース調査)を参照してください。

追加の調査は、必要なときに次を実行します。これらのコマンド自体は共通 check に含めません。循環の検出は`check:unused`でも行います。

| コマンド | 読み方 |
| --- | --- |
| `bun run analyze:duplicates` | 重複グループの場所と範囲を確認します。既定ではテストなどが除外されるので、`--explain-skipped`で対象外を確認します。変数名などが異なる類似コードも調べるときは、`--mode semantic`を使います |
| `bun run analyze:complexity` | 関数の循環的複雑度・認知的複雑度・CRAPを、認知的複雑度の順に確認します。`--report-only`により、指摘は失敗条件にしません。Biomeの上限15の検査は続きます |
| `bun run analyze:cycles` | ファイル間の実行時importの循環経路を調べる入口です。循環が指摘されると終了コード1になります。同じ循環検出は、共通checkの`check:unused`にも含まれます |

## 要求整理とIssue作成

通常の入口は、共通登録済みの`scoping`と`implement`です。`scoping`は、会話、既存の Issue 下書きと Issue、必要な Git 管理文書から、要求・検証方法・合意を整理します。

[六つの問い](skills/scoping/references/sufficiency.md)で不足を判断します。判断を左右する不足や根拠の変更があれば、それに依存する作業を止めます。Issue の記述と出典で足りるときは報告を作らず、必要な根拠だけを docs/research/に直接保存・改訂します。

合意済みの Issue は`implement`で実装します。CLI の絶対パスは信頼するスキル実体から解決し、実行対象 repo のパスを渡します。操作は各[スキル](skills/scoping/SKILL.md)と[実装入口](skills/implement/SKILL.md)を参照してください。

scoping の切替と、新しいタスクでの確認は[切替手順](scripts/README.md#scopingの切替と手順確認)を参照してください。今後の保全と登録変更は[開発方針](docs/wiki/development-policy.md#旧資産の保全と登録変更)に従います。
