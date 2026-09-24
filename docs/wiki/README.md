# 現在の知識

このリポジトリで現在使う手順・構造と適用条件を置きます。判断理由は[decisions](../decisions/README.md)、調査原本は[research](../research/README.md)を参照してください。

Claude／Codexとも[共通手順](../../skills/references/documents.md)で関連ページを選び、現行コードとIssueへ照合します。文書は作業対象のrepo内で管理します。

- [実装開始の目的・概念・規則](implementation-start.md): JSON正本から生成した説明です。仮説・提案はその状態を保ち、現行の必須条件へ読み替えません。更新は[CLI手順](../../scripts/README.md#共有知識の選択)から行います。
- [判断に使う根拠を同じ版で引き継ぐ](reference-handoff.md): 実装・修正・独立評価へ選んだ根拠を渡し、版と合意状態を確認するときに読みます。
- [検証結果を観測した範囲で使う](evidence-scope.md): 過去の実測や合成課題の結果を、今回の判断へ使う前に読みます。

新しいページは[wikiテンプレート](../../skills/references/wiki-template.md)を使います。生成した共有モデルの説明はnode ID・関係・状態を保つ専用の表示で、手修正せず同じ入口から読みます。
