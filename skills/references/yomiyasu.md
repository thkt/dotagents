# このrepoで日本語を確認する

このrepoの日本語ドキュメントの作成・更新とPR本文には、同梱の[yomiyasu](../yomiyasu/SKILL.md)を使う。README、操作説明、調査報告、Issue本文・下書き、AI向け指示も対象とする。適用範囲と確認の責任は[開発方針](../../docs/wiki/development-policy.md#pr本文人向け文書の日本語確認)に従う。通常の会話や無関係なrepoへの自動適用・共通登録の変更は行わない。履歴資料・引用・外部ソース・ライセンスの原文は一括推敲しない。

## 同梱したソースと確認できた範囲

[Issue #419](https://github.com/thkt/dotagents/issues/419)で合意した、元checkoutにユーザーが保持していた未追跡の`skills/yomiyasu/`を共有する。frontmatterは2.1.1、[LICENSE](../yomiyasu/LICENSE)はMIT License、Copyright (c) 2026 nanaismである。[UNICODE-LICENSE.txt](../yomiyasu/UNICODE-LICENSE.txt)も保持する。上流の文章・Pythonコード・参照資源は変更せず、生成済み`__pycache__/`は含めない。外部の最新版へ置き換えない。

共有対象は38ファイル。相対パス順の`[path, mode & 0o777, sha256(contents)]`の配列をJSON（`ensure_ascii=False`、`separators=(",",":")`）にしたSHA-256は`5af0b0bd0fb1355e5f794226dda6b82ab834a102d1a759380b3c7d424e4d7c71`である。これはコピー元との同一性の基準であり、上流の公開元URL・commitや配布経路の証明ではない。それらの出典情報は未確認で、frontmatterの版だけから補わない。元checkoutの同ディレクトリは変更・削除しない。

旧natural-japanese固定版quickの必須適用は終了する。[旧手順](natural-japanese.md)は過去の試行・evalの固定入力のためパスを残す。旧版を指定した比較依頼では指定を保持し、過去の研究・固定commit・fixture・eval実行契約は変更しない。今回、新しいモデル比較や性能実験は行わず、両スキルの優劣や一般的な効果は未確認とする。

## 対象を明示して実行する

Python 3と標準ライブラリを使う。外部Pythonパッケージやuvは不要。Pythonの最低バージョンは同梱スキルに明記されていないため、利用環境で入口とrun／verifyを確認し、実行できない場合は理由を残す。ハーネスの共通checkは同梱Pythonの振る舞いを網羅しない。

1. 同梱の`SKILL.md`を読み、文書の用件・読み手・立場を確認する。必要な文書型と参照資源を選び、意味を保って執筆・推敲する。新規作成では資料と最終稿を照合する。
2. 原文と最終稿を別ファイルで保管する。次の例はrepoルートから実行する。`yomi_source`と`yomi_final`には実際の対象の別パスを指定し、ディレクトリや拡張子から自動収集しない。

```sh
yomi_check="$PWD/skills/yomiyasu/scripts/yomiyasu_check.py"
yomi_source="$PWD/.yomiyasu/original/guide.md"
yomi_final="$PWD/docs/wiki/guide.md"
python3 "$yomi_check" run --source "$yomi_source" --final "$yomi_final" --stance 決まり --doc-type manual --reader informed --fact-gaps
python3 "$yomi_check" verify --final "$yomi_final"
```

この例のパスは例示であり、原文は編集前に別保存する。立場・文書型・読み手は対象に合わせる。PR本文には`--doc-type pr`を使う。原資料があれば`--material 資料パス`も渡す。新規作成では`--source`の代わりに`--material`を使う。`python3`がなければ同梱の案内に従い`python`か`py -3`を使い、実際の実行版を記録する。

3. runのlint・diff・資料照合の候補と全文差分を読み、原資料へ意味を照合する。候補は修正命令ではない。数値・否定・条件・範囲・権限・確度・参照・未確認事項を保つ。修正は同梱手順の1回にまとめ、修正したらrunを再実行する。
4. 提出直前に、本文を変えずverifyを実行する。verify後に本文を変更したらrun／verifyをやり直す。runの終了0は検査の実行、verifyの一致は記録した最終稿との一致を示す。意味の正しさ・読みやすさ・人の承認は保証しない。ハッシュ不一致や実行不能を成功扱いせず、理由と未完了の検査を既存の作業報告に残す。

Pythonを実行できない場合も同梱の目視確認は進めるが、run／verifyを実行したことにはしない。別のスキルへの無断切替や権限変更で完了にしない。文書は既存の独立評価に含め、PR本文は[公開後確認](../../scripts/README.md#公開後確認とreadyへの切替)で最新本文を読み戻す。同じheadのCI成功、人の承認・マージの分担も維持する。

## ローカル記録とGit共有を分ける

runの記録には原文・最終稿の全文が入る。既定の保存先はGit最上位の`.yomiyasu/`で、環境変数や`--state-dir`で変わるため実際の保存先を確認する。このrepoでは`.yomiyasu/`、`__pycache__/`、Pythonのコンパイル済みキャッシュをGit管理から除外する。別の保存先はこの除外で守られるとは限らない。原文を別の場所に保存する場合も公開範囲を確認する。

ローカル保存をGit共有や公開済みの証拠と扱わない。Gitで共有するのは必要な根拠と確認結果であり、原文全文・秘密情報・生ログを一括追加しない。原文や検証証拠、既存run、他担当のファイルを上流の片付け指示だけで消さない。保存・共有・保全はこのハーネスの方針を優先する。

対象限定のrun／verifyと既存の意味確認を再利用する。文書全体の定期監査、共通check／CIへの日本語検査や新しい必須検査、同梱hookの登録は追加しない。
