# 日本語の調査報告とPR本文を推敲する

適用範囲と意味の保存、確認の責任は[日本語確認の方針](../../docs/wiki/development-policy.md#pr本文人向け文書の日本語確認)に従う。日本語の調査報告を保存する前と、PRの最新本文を確認・編集するときに読む。README・操作説明・Issue本文・AI向け指示には自動適用しない。

## 試行した版を使う

使用するのは [coji/natural-japanese のcommit 9a78a42964096da509b8f3e011f0085a5f080151](https://github.com/coji/natural-japanese/tree/9a78a42964096da509b8f3e011f0085a5f080151)。細かな推敲規則はこの版の `skills/natural-japanese/SKILL.md` と必要な参照先から読む。可変のmainや別版のインストール済みスキルへ黙って切り替えない。

ホストの書込み可能な一時領域で取得する。Gitとuvを使い、取得済みの同じ版を再利用する場合もHEADと作業ツリーに変更がないことを確認する。

```sh
nj_checkout=$(mktemp -d "${TMPDIR:-/tmp}/dotagents-natural-japanese.XXXXXX")
git clone https://github.com/coji/natural-japanese.git "$nj_checkout" &&
git -C "$nj_checkout" checkout --detach 9a78a42964096da509b8f3e011f0085a5f080151 &&
test "$(git -C "$nj_checkout" rev-parse HEAD)" = 9a78a42964096da509b8f3e011f0085a5f080151 &&
test -z "$(git -C "$nj_checkout" status --porcelain)"
```

すべて成功してから `nj_skill="$nj_checkout/skills/natural-japanese"` として、この版の `SKILL.md` を読む。調査報告は `references/doctypes/report.md` も読み、PRは専用の文書型がないため共通観点を使う。スキルは共通登録せず、この用途から明示的に参照する。

取得や版の確認に失敗した場合は固定版の適用を未完了と記す。uvや依存取得が使えない場合は、同じ版の `references/manual-checklist.md` で確認できる範囲を確認し、lintは未実行と記す。既存の意味確認を続け、実行失敗を指摘0件やクイック手順の完了に読み替えない。利用できない操作のために独立評価のread-only権限を変更しない。

## クイック手順を既存の作業内で使う

1. 読者が判断する内容と主旨を確認し、固定版のクイック手順で執筆・推敲する。フルへの自動昇格はせず、人が明示的に依頼したときだけフルを使う。
2. 調査報告またはPR本文を保存したファイルのパスを `nj_document` に指定し、次を実行する。対象を拡張子やディレクトリから自動収集しない。

```sh
uv run "$nj_skill/scripts/lint.py" "$nj_document" --genre tech --reading-load
```

3. 指摘は文脈で採否を判断する。修正した箇所と残した理由を既存の作業報告に簡潔に記し、修正後は同じ条件で再検査する。文書の構成と段落の先頭文も通読する。文を短くするために条件を落とさず、見出しの結論化や箇条書き化を一律に行わない。
4. 原資料と数値・条件・断定の強さなどを再照合する。調査報告は既存の独立評価へ渡す。PR本文は[公開後確認](../../scripts/README.md#公開後確認とreadyへの切替)に従い、編集前の最新本文・head・draft状態と権限を確認し、編集後に実際の本文を読み戻す。

lintの終了0は指摘なしや意味の一致を保証しない。指摘件数・自然度スコアを公開やreadyの合格基準にはしない。uvが解決するPython依存は上流スクリプトの範囲指定に従うため、この固定はスキルのソース版を保証するもので、依存環境全体の固定ではない。

上流の一般的な片付け指示で、今回の比較原文、合意した検証根拠、既存runや他担当のファイルを削除しない。保存・公開・権限・証拠の保全はこのハーネスの既存方針を優先する。外部スキルの版を更新する際は、対象2種類で意味の保存と検出の変化を確認してから、この固定版を変更する。
