# 累積コピーlintのconst初期値取得だけを共有し、判定の意味を維持する

## 目的と現在の根拠

累積コピーlintのAST解析で同じ宣言形状を判定する部分だけを共有し、今後の修正箇所を減らす。調査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。

[referencesAccumulator](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/lint/anti-slop/rules/no-reduce-accumulator-copy.ts#L102)と[isKnownArrayExpression](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/lint/anti-slop/shared/array-method.ts#L114)は、VariableDeclarator・Identifier・初期値あり・constという同じ条件で初期値を取得する。一方、前者は蓄積変数をコピーする時点の値を追い、後者は配列の根拠を調べるため、再代入や型注釈の判定は同じではない。

## 範囲と受入条件

- [ ] constの通常のIdentifier宣言から初期値を取り出す同一処理だけを、既存shared内の小さい補助関数へ集約する。該当しない宣言の扱いを維持する。
- [ ] 蓄積変数そのものの参照、コピー前の再代入、自己代入右辺の扱いはreferencesAccumulatorに残す。配列の型注釈と配列と認識できる初期値の判定はisKnownArrayExpressionに残す。
- [ ] 循環防止、scopeに基づくbinding解決、const alias、shadowing、再代入、配列と文字列の区別、許容例・禁止例の診断を維持する。
- [ ] [取り込み元と更新手順](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/lint/anti-slop/README.md#L7)に従い、固定upstream・MITライセンス・著作権表示を維持し、ローカル差分の説明を必要な範囲で更新する。

再帰全体の統合、callbackやmodeを持つ汎用AST走査器、検出範囲の拡大・緩和、他のanti-slopルール導入、新しい台帳は対象外。fallowの重複数をゼロにすることは完了条件にしない。

## 検証

既存codebase-checksの許容例・違反例で、const alias、事前再代入、自己代入右辺、shadowing、配列concatと文字列concatを確認する。移動によって不足する現実的な境界がある場合だけ、最小の回帰確認を補う。原版との差分と日本語説明も独立評価する。対象は`thkt/dotagents`。実装時は`bun install --frozen-lockfile --ignore-scripts`で準備し、影響する既存テストと提出前の`bun run check`、差分の独立評価を行う。PR公開時は同じheadの`checks`・`verify`を確認し、人がレビューとマージを判断する。画面変更はなく、媒体は不要（既存の`capture: null`を維持）。

## 関連と合意

完了済み[#178](https://github.com/thkt/dotagents/issues/178)は限定したlintの導入を扱った。本Issueは採用済みルールのconst初期値取得だけの整理であり、規則を追加しない。完了済み[#174](https://github.com/thkt/dotagents/issues/174)の「類似コードだけで統合しない」方針に従い、意味の異なる判定は残す。削減効果が小さい限定候補として扱う。

根拠は本Issueと固定リンクに含め、今回の必須調査報告は追加しない。未commitのローカル下書きは実装開始の前提にせず、着手時に最新の採用版へ適用性を再確認する。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
