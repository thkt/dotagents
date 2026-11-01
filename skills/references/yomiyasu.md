# このrepoで日本語を確認する

このrepoの日本語ドキュメントの作成・更新とPR本文には、外部からインストールした`yomiyasu`を使う。README、操作説明、調査報告、Issue本文・下書き、AI向け指示も対象とする。適用範囲と確認の責任は[開発方針](../../docs/wiki/development-policy.md#pr本文人向け文書の日本語確認)に従う。通常の会話や無関係なrepoへの自動適用・共通登録の変更は行わない。履歴資料・引用・外部ソース・ライセンスの原文は一括推敲しない。

## 外部スキルを用意する

`yomiyasu`本体は各ホストで外部の配布元の手順に従ってインストールする。このrepoは本体を同梱せず、配布元・インストール方法・版を管理しない。[Issue #419](https://github.com/thkt/dotagents/issues/419)のPR修正で、ローカルに保持する本体をGit管理から外す方針に変更した。repo内に置く場合の`/skills/yomiyasu/`もGit管理から除外する。本体を追跡から外す際も、ローカルのファイルは削除しない。

利用ホストのスキル一覧・登録情報から、インストール済み`yomiyasu`の`SKILL.md`と実体ディレクトリを確認する。実際の配置先からスクリプトを解決し、対象checkout内の`skills/yomiyasu/`が存在するとは仮定しない。スキルが未導入なら、利用ホストへ導入してから実行する。配置・登録の変更は既存の[保全と登録変更の方針](../../docs/wiki/development-policy.md#旧資産の保全と登録変更)に従い、今回の文書更新だけで登録を切り替えない。

今回確認したローカル版は2.5.0で、Python 3標準ライブラリによるrun／verifyを使う。これは検証した版の記録であり、このrepoによる版固定ではない。この版は配布元[nanaism/yomiyasu](https://github.com/nanaism/yomiyasu)のタグ`v2.5.0`にある`skills/yomiyasu/`を取得して配置した。Pythonの最低バージョンは未確認である。版を更新した場合も、その版の`SKILL.md`とCLIを確認し、必要な機能と実行条件を照合する。外部スキルの動作はハーネスの共通checkの網羅対象ではない。

旧natural-japanese固定版quickの必須適用は終了する。[旧手順](natural-japanese.md)は過去の試行・evalの固定入力のためパスを残す。旧版を指定した比較依頼では指定を保持し、過去の研究・固定commit・fixture・eval実行契約は変更しない。今回、新しいモデル比較や性能実験は行わず、両スキルの優劣や一般的な効果は未確認とする。

## 対象を明示して実行する

1. インストールした`SKILL.md`を読み、利用版と文書の用件・読み手・立場を確認する。必要な文書型と参照資源を選び、意味を保って執筆・推敲する。新規作成では資料と最終稿を照合する。
2. 原文と最終稿を別ファイルで保管する。次の例は対象repoのルートから実行する。`yomi_skill`を確認したインストール先の絶対パスに置き換える。`yomi_source`と`yomi_final`には実際の対象の別パスを指定し、ディレクトリや拡張子から自動収集しない。

```sh
yomi_skill="/absolute/path/to/installed/yomiyasu"
yomi_check="$yomi_skill/scripts/yomiyasu_check.py"
yomi_source="$PWD/.yomiyasu/original/guide.md"
yomi_final="$PWD/docs/wiki/guide.md"
python3 "$yomi_check" run --source "$yomi_source" --final "$yomi_final" --stance 決まり --doc-type manual --reader informed --fact-gaps
python3 "$yomi_check" verify --final "$yomi_final"
```

この例のパスは例示であり、原文は編集前に別保存する。立場・文書型・読み手は対象に合わせる。PR本文には`--doc-type pr`を使う。原資料があれば`--material 資料パス`も渡す。新規作成では`--source`の代わりに`--material`を使う。`python3`がなければインストールしたスキルの案内に従い`python`か`py -3`を使い、実際の実行版を記録する。

3. runのlint・diff・資料照合の候補と全文差分を読み、原資料へ意味を照合する。候補は修正命令ではない。数値・否定・条件・範囲・権限・確度・参照・未確認事項を保つ。修正はスキル手順の1回にまとめ、修正したらrunを再実行する。
4. 提出直前に、本文を変えずverifyを実行する。verify後に本文を変更したらrun／verifyをやり直す。runの終了0は検査の実行、verifyの一致は記録した最終稿との一致を示す。意味の正しさ・読みやすさ・人の承認は保証しない。ハッシュ不一致や実行不能を成功扱いせず、理由と未完了の検査を既存の作業報告に残す。

Pythonを実行できない場合もスキルの目視確認は進めるが、run／verifyを実行したことにはしない。未導入・実体不明・機能不足の場合も理由を残し、別のスキルへの無断切替や権限変更で完了にしない。文書は既存の独立評価に含め、PR本文は[公開後確認](../../scripts/README.md#公開後確認とreadyへの切替)で最新本文を読み戻す。同じheadのCI成功、人の承認・マージの分担も維持する。

## ローカル記録とGit共有を分ける

確認した2.5.0のrunの記録には原文・最終稿の全文が入る。既定の保存先はGit最上位の`.yomiyasu/`で、環境変数や`--state-dir`で変わるため実際の保存先を確認する。このrepoでは`/skills/yomiyasu/`、`.yomiyasu/`、`__pycache__/`、Pythonのコンパイル済みキャッシュをGit管理から除外する。別の配置先・保存先はこの除外で守られるとは限らない。原文を別の場所に保存する場合も公開範囲を確認する。

ローカル保存をGit共有や公開済みの証拠と扱わない。Gitで共有するのはこのrepoの方針・利用手順と必要な根拠・確認結果であり、外部スキル本体、原文全文・秘密情報・生ログを一括追加しない。原文や検証証拠、既存run、他担当のファイルを上流の片付け指示だけで消さない。保存・共有・保全はこのハーネスの方針を優先する。

対象限定のrun／verifyと既存の意味確認を再利用する。文書全体の定期監査、共通check／CIへの日本語検査や新しい必須検査、外部スキルのhook登録は追加しない。
