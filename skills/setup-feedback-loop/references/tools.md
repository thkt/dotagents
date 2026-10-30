# ツールの選定と静的検査

導入版の公開CLI・設定schema・必要機能を確認してから採用する。固定版の例は[呼出し仕様](../../../docs/wiki/setup-feedback-loop-contract.md)にあるが、全repoへの採用指定ではない。

| 既存構成 | 選び方 |
| --- | --- |
| ESLint・Prettier | 設定・プラグインを再利用する。型情報やimportを使うlintはプロジェクト全体の情報を保つ |
| Biome | 既存のformatter・lint対象と規則を確認し、同じ対象へOxlint・Oxfmtを重ねない |
| Bunの整形 | 固定runtimeの書込みなし検査を利用する。対象版の機能を確認する |
| 未導入のJS／TS | Oxlint・Oxfmtを候補にし、必要な規則・対象拡張子と互換性を確認する |
| 型検査 | 既存tsconfig・生成物・プロジェクト単位を保つ。Bunでは[内蔵型検査](typecheck.md)の機能・互換性を確認して接続する。準備に含まれる型検査をfeedbackで重ねない |
| fallow | entry・framework・生成物・動的利用を専用設定へ反映する。未使用コード・依存・循環の採否と解析完了を確認する |

依存は対象repoのdevDependenciesへ固定版で置く。共有ハーネスのnode_modules、グローバルツール、毎回取得する最新版に日常実行を依存させない。runtime付属機能にはruntimeの固定を使う。npmは既存package-lock、Bunは既存Bun lockを更新し、通常の固定依存インストールから起動を確認する。

formatは対応する変更ファイルへ書込みなしで実行する。`git diff --name-only --no-renames -z`と`git ls-files --others --exclude-standard -z`等を使い、分岐点以降のcommit・staged・unstaged・未追跡を含める。削除ファイルは整形対象に渡さず、改名後の既存パスを検査する。空白・非ASCIIのパスはargvで渡し、空集合をformatterの全件指定と誤認しない。

lintのファイル内規則だけを変更ファイルへ限定する。型・importの検査、型検査、fallowの参照関係は、変更ファイルだけへ狭めない。安全な限定を確認できなければ全件のまま接続する。fallowの重複・複雑度等の追加レポートは個別に採否を決め、全機能を必須化しない。

`check:feedback`は診断だけを行う。formatterの`--check`、lintの修正なしの操作を使い、自動修正は`format`・`lint:fix`等へ分ける。fallow候補からコードを自動削除しない。解析不完全を終了0へ補正しない。初回の既存違反や整形差分が大きい場合は量と影響を示し、合意範囲へ照合する。大量のignoreで通さない。必須検査を省く必要や大規模移行は人へ判断を戻す。

公式の機能参照は[Oxlint](https://oxc.rs/docs/guide/usage/linter)、[Oxfmt](https://oxc.rs/docs/guide/usage/formatter)、[fallow](https://fallow.tools/docs/)を使う。Webの現行説明と導入版が一致するとは限らないため、ローカルの版・help・schemaへ照合する。
