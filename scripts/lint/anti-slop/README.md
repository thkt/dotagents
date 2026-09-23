# 累積コピーのlintルール

[Issue #178](https://github.com/thkt/dotagents/issues/178)の合意に従い、anti-slopの`no-reduce-accumulator-copy`だけを取り込みます。型の絞り込みと累積spreadにはOxlint標準ルールを使います。全ルールの登録や導入スキルの実行は行いません。適用範囲・修正例は[開発方針](../../../.codex/DEVELOPMENT.md#typescriptの書き方)を参照してください。

## 出典とローカル変更

原版は[dmmulroy/anti-slopのc44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b](https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b)です。

| 取り込むファイル | 固定した原版 |
| --- | --- |
| [rules/no-reduce-accumulator-copy.ts](rules/no-reduce-accumulator-copy.ts) | [src/rules/no-reduce-accumulator-copy.ts](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-reduce-accumulator-copy.ts) |
| [shared/array-method.ts](shared/array-method.ts) | [src/shared/array-method.ts](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/shared/array-method.ts) |
| [LICENSE](LICENSE) | [MITライセンス全文](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/LICENSE) |

著作権表示はCopyright (c) 2026 Dillon Mulroyです。ライセンス全文を同梱します。原版から既存の波括弧・Oxfmt規約に合わせ、複雑度上限15のために関数を分割し、蓄積変数への再代入時はコピー時点の値を判定するようにしました。診断文は維持します。[index.ts](index.ts)はこのrepoで追加した単一ルールの登録です。

独自ルールはreduce/reduceRightの直接指定callbackを調べ、蓄積変数とconstの別名を追跡します。Object.assignのオブジェクトリテラルへのコピー、Array.from、配列と認識できる初期値に対するconcat・slice・toSpliced・toSorted・toReversed・withが対象です。spreadは標準ルールが担当します。文字列concat、入力要素だけのコピー、新しく作った蓄積先への追加は許容します。名前付きcallback、別関数を介するコピー、認識できない初期値などは検出範囲外です。実際の値の増加や性能効果を測定するものではありません。

## 更新

更新時は上記commitと候補版の対象2ファイル・ライセンスを比較し、ローカルの関数分割と検出条件への影響を確認します。他ルールや新たな適用範囲は自動で取り込まず、要求が変わる場合は人の合意へ戻します。採用するcommit・ライセンス・ローカル変更の説明も同時に更新します。

Oxlintと`@oxlint/plugins`は1.80.0に揃え、package.jsonとbun.lockで固定します。API更新時は両方の版と型定義を照合し、インストールスクリプトを無効にしてlockfileを更新します。セットアップには既存の`bun install --frozen-lockfile --ignore-scripts`を使います。

[codebase-checks.test.ts](../../tests/codebase-checks.test.ts)は設定を一時checkoutのルートに置き、実際の`bun run lint`で許容例と違反例を検査します。違反例自体の型検査成功に加え、指定ルール・対象ファイル・error・終了1を照合するため、読込みだけの成功や無関係な型エラーを導入成功と扱いません。更新後は`bun run check`と変更文書を含む既存の独立評価へ進み、公開時は同じPR headの`checks`・`verify`を確認します。
