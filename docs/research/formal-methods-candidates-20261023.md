# 形式手法の既存活用を広げた9候補の限定比較

dotagentsでは、2026-09-21の[TLA+試行](formal-state-trial-20260921.md)で実行予約・中断・再起動を限定的に調べた。注入した欠陥は既存テストでも検出でき、追加の検出力は確認できなかった。2026-09-29の[Quint試行](quint-publication-trial-20260929.md)では検証後・送信前のブランチ変更による未検証commitの送信を再現し、検証済みSHA固定が[Issue #323](https://github.com/thkt/dotagents/issues/323)・[PR #324](https://github.com/thkt/dotagents/pull/324)で採用された。限定試行と採用済みの改善を区別し、どちらも今回の新発見として数えない。

今回はこの既存活用を広げ、守る性質を仕様として明文化し、有限状態・有限入力の組合せを実コードと照合する範囲を9候補へ広げた。2026-10-23時点で、復帰オプションの字句境界と経路共通の使用量の内数制約について、実コードの誤受入と修正による改善を確認し、2点の局所修正を実装した。残る7候補は、既存保証と採用済み成果を踏まえて追加の置換価値を確認できず、既存方式を維持した。

[Issue #429](https://github.com/thkt/dotagents/issues/429)（本文更新日時: 2026-10-23T03:30:38Z）が要求・合意の正本である。初回runの容量不足による停止と新規実行の合意を保持し、開始版 `6e470b33eddc303a35728df9854fd0a7cb41da33` のコードを修正した。新しい独立テストのRedと修正後のGreenを確認した。以下に残す全体check・変更文書を含む独立評価・PR公開・同じheadのCIの未完了表記は、初回の実装担当提出時点の記録である。今回の説明修正は公開commit `8aa4faaeb275fd83bd24c9c0eeaea3f2062b4e1c` から始めており、初回提出後のホスト検証・独立評価・公開・CIと、説明修正後に必要な検証を区別する。今回の結果を、形式検証の常設やハーネス全体の正しさの証明とは扱わない。

## 対象と判断方法

基点は `bd7a013a60a26a6389b962f789fe6c450d3dbc8c`、実行環境はmacOSとBun 1.4.4。基点のpackageManager宣言はBun 1.4.3であり、宣言版と実行版の差を残す。過去のTLA+・Quint試行を踏まえ、今回は9候補で形式仕様・有限探索を調査補助として使う価値と、既存方式を置き換える価値を比較した。比較には有限状態の幅優先探索、有限入力の全列挙、実コードの呼出し、一時コピーの不具合注入と修正案を使った。TLA+・Quint・Z3の新規実行は行っていない。

採否は守る性質、既存の保証との差、実装で成立する反例、正常対照の保持、追加の実行・保守負担で判断する。探索件数、コードの短さ、モデルの成功だけで改善としない。定理証明、実装とモデルの機械的な対応証明、有限範囲を超える網羅性は確認していない。

形式仕様・有限探索は今回の調査補助であり、改善した条件を守る恒久的な通常ガード・回帰テストとは分けて扱う。既存の厳密な検証全般を形式手法由来と呼び直すものではない。

## 候補一覧

| 候補と対象 | 守る性質・比較する置換案 | 結果と採否 |
| --- | --- | --- |
| 実行予約・中断：`scripts/implement/correction.ts`、`scripts/shared/process.ts` | 不確かな実行を再起動せず、終端保存まで排他を保つ。個別の順序確認を状態モデルへ置き換える案 | 前回試行と現行の起動前予約・終端保存までのlock保持を照合。新しい実コード反例は未確認。既存方式を維持し、復旧方式を変更するときの補助候補に留める |
| 公開結果の不確実さ：`orchestrator.ts`、`publish.ts`、`execution-history.ts` | 応答を失った後、実状態を照合するまで書込みを再試行しない。送信・外部効果・観測を分けたモデルで判断する案 | 13状態の抽象モデルは未照合の再送なし。自動再送を許す対照には反例。保存・実APIとの対応証明は未実施で、置換効果は未確認。設計確認の補助に留める |
| 復帰時の権限：`host-handoff.ts`、`review-recovery.ts` | 復帰を重ねても直前の公開制限を広げない。権限の順序関係として検査する案 | 復帰3回までの7状態で違反なし。最初の権限だけを見る対照には制限を飛び越す反例。現行の権限判定12入力は不一致なし。現行方式を維持。全履歴を含む実コードの証明ではない |
| 対象版と送信：`correction.ts`、`orchestrator.ts`、`scripts/shared/target.ts` | 検証したcommitと送信元を一致させる。照合の反復を送信元の固定で担保する案 | 2版・12状態のSHA固定モデルは反例なし。ブランチ送信の対照では照合後の変更で違反。現行push引数のSHA固定を確認。#323で採用済みの保証を維持し、新規変更は行わない |
| 証拠・独立テスト保護：`record-observation.ts`、`host-records.ts`、`test-author.ts` | 同じ読取り結果でも各参照の期待hashを照合し、新しい境界では再観測する。保護ファイルと応答の制約をまとめる案 | 期待hash・新しい境界の3条件と、保護ファイル・応答hashの2×2条件を実コードで確認して不一致なし。暗号学的性質、symlink競合、電源断は対象外。置換は見送る |
| 復帰プロセス識別：`interrupted-processes.ts` | 正規オプションと別名中の部分文字列を区別する。部分文字列検索をオプション境界の判定へ置き換える案 | 72入力中18件を誤受入。`verifyInterruptedProcesses`でも別オプションを正規復帰として除外する反例を再現。局所修正を採用した。psから元argvを完全に復元できるとは扱わない |
| CI判定：`ci.ts` | 必要な全checkの存在とSUCCESS、同名checkの全件成功、他checkの失敗・保留なし。有限仕様による集合の判定へ置き換える案 | 24,700組、符号化8条件、不正7条件、取得9系列は不一致なし。重複pendingを隠す変異は既存テストも検出した。追加の検出成果とは数えず、既存の分岐とテストを維持 |
| PR同一性：`pr-identity.ts` | 対象・主体・本文・draftを厳密に照合し、欠落に成功の既定値を補わない。制約の全列挙へ置き換える案 | GraphQLの対象270・公開256、RESTの対象324・公開256条件は不一致なし。Issue参照のMarkdown解釈は保証外。既存方式を維持 |
| 使用量の状態と制約：`usage-events.ts`、`scripts/shared/token-usage.ts`、`review-probe.ts` | 順序が曖昧になった後は計上せず、各turnの値を非負の安全な整数、かつcacheをinputの内数とする。状態表への置換と制約の共有を比較 | 長さ5までのイベント111,111列、数値表現2,744・加算15,625条件を比較。通常集計だけが持つ内数検査を共有parserへ移す案は正常75条件を保持し、不正50条件を追加拒否した。内数制約の共有を採用し、イベント処理の置換は見送る |

表中の `scripts/` 以下でディレクトリを省いたファイルは `scripts/implement/` を指す。件数は今回選んだ有限範囲であり、検出率や保証の強さの指標ではない。7候補の現状維持は、既存保証や採用済み成果に対する追加の置換価値が確認できなかった判断であり、形式手法の初導入を見送ったという意味ではない。他の入力・操作順序にも欠陥がないという意味でもない。

## 実コードで確認した反例

### 復帰オプションの部分一致

調査基点と開始版の `cliArgument` は `--other--interrupted-run=OLD` を `--interrupted-run=OLD` として受理した。同様に `--other--run-dir=NEW` も `--run-dir=NEW` として受理した。

停止後の時刻を持つプロセス観測に、これらの別オプションを付けたcommandを渡すと、OLDを参照するプロセスでも `verifyInterruptedProcesses` は正規復帰の除外対象として受け入れた。正常な `--interrupted-run=OLD --run-dir=NEW` も受け入れたため、単に全件を拒否している比較ではない。

有限入力はオプション名の接頭辞4種、値との区切り2種、引用符3種、path接尾辞3種の72通り。誤受入18件は別名の接頭辞3種と区切り・引用符の組合せで生じた。これは字句上の境界の不足を示すもので、任意のshell式やpsの曖昧さ全体の解決ではない。

### 使用量の経路による不一致

調査基点と開始版では、`{input_tokens:0,cached_input_tokens:1,output_tokens:0}` を共有 `parseTokenUsage` が受理し、`readReviewerUsage` は完了turnの合計へ加算した。同じ値をthread開始・turn開始・完了の順に通常集計へ渡すと、`readUsageEvents` は不正使用量として拒否した。[CLIガイド](../../scripts/README.md#選択したimplement-runの使用量集計)の「キャッシュ入力は入力の内数」という既存の契約に照らした反例である。

一時コピーで内数制約を共有parserへ移す案を比較した。安全な整数5境界値から作った125入力で正常75件を保持し、不正50件を追加拒否した。同じ125入力を1turnの通常集計へ渡した結果は、変更前後で全文一致した。レビュー試行経路は反例を拒否し、`(input,cache,output)=(2,1,0)` と `(2,2,0)` を受理した。

この2件は単純な境界値検査や呼出経路の調査でも発見可能である。有限仕様が調査の助けになったことと、形式手法が他の方法より優れることは区別する。

## 独立テストと実装の状態

調査時の関連テスト79件の成功は今回の反例を検出する保証ではなかった。新しい独立テスト担当は旧資産をIssueと修正前仕様へ照合して2ファイルを採用し、開始版で正常対照30件成功・狙った8件失敗を確認した。別オプションによる誤除外6件と、レビュー試行のcache超過受入2件がRedであり、環境失敗とは区別する。

修正は `cliArgument` のオプション直前を文字列先頭または空白に限定し、内数制約を `parseTokenUsage` へ集約した。通常集計側の重複条件だけを除き、イベントの状態遷移・診断・計上済みturnの保持、レビュー試行の例外終了は維持した。同じhelperを使う `--review-run` にも境界判定が適用される。任意の引用・shell構文やpsからの元argv復元は保証しない。

修正後、独立回帰2ファイル38件と、既存の `usage.test.ts`、`review-probe.test.ts`、`check-timeout-processes.test.ts` の19件、合計57件がBun 1.4.4で成功した。元の72入力も開始版と修正後で比較し、誤受入は18件から0件、正規復帰の受理は維持された。証拠hash3条件、保護成果物4条件、権限12条件、SHA固定の結果に変化はなかった。[修正前](formal-methods-candidates-20261023/baseline-controls.json)と[修正後](formal-methods-candidates-20261023/implemented-controls.json)に結果を保存した。

回帰テストは実装担当が変更していない。オプション名の境界と経路間の内数制約は既存ケースで見逃していた条件であり、独立テストを維持する価値がある。正常値、cache=input、安全整数上限、不正表現、先行正常turnによる超過相殺も区別する。小さな一時ファイルと模擬観測で検証でき、実ps・外部モデルを回帰テストへ追加する必要はない。既存の順序・overflow・復帰時刻のテストは異なる保証を担うため削除・統合しない。失う検出条件はなく、OS観測の成功と任意のイベント列は未確認である。

旧runは独立テスト工程の `Selected model is at capacity` で終端停止した。旧記録は変更・再開していない。依頼者は同じモデルでの新規実行を許可し、旧branchを保全して最新mainから開始することに合意した。新しい独立テストの記録はホストが保持する `test-1.json` を参照する。旧停止を現在の成功や採用へ読み替えない。

修正前の独立テスト環境の全体checkでは、静的検査は成功したが、新規8件に加えて既存16件がps起動のEPERMと後続成果物の欠落で失敗した。旧ホストでの既存1件の成功はこの環境差の切り分けに限る。調査基点での過去のホストcheck（制御883件・eval189件成功）も修正後の成功ではない。この実装セッションでは指定に従い全体checkをホストへ任せる。設定済み `bun run check` は新規2ファイルを含むため接続変更は不要であり、独立評価には本報告と添付資料も渡す。

## 原資料の照合と再実行

開始版の関連 `scripts/implement/`・`scripts/shared/` は調査基点から差分がなかった。ローカル報告案はGit未共有だったため、過去の比較を原資料へ照合して本報告へ取り込み、未完了状態を更新した。[出典と修正対象のhash](formal-methods-candidates-20261023/source-manifest.json)で原スクリプトと修正後ソースを識別する。

[controls.ts.txt](formal-methods-candidates-20261023/controls.ts.txt)、[trial.ts.txt](formal-methods-candidates-20261023/trial.ts.txt)、[compare-proposal.ts.txt](formal-methods-candidates-20261023/compare-proposal.ts.txt)、[state-models.py](formal-methods-candidates-20261023/state-models.py)はIssueにある比較コードを移植した。TypeScriptは手動再実行用のコード資料として `.ts.txt` に保存し、実行時だけ一時領域へ展開する。通常ハーネスの起動入口には加えない。参照先・出力先・版表示だけを引数または環境変数へ変え、入力、比較式、判定条件は変えていない。通常テスト・fixture・検証接続定義へ追加していない。生成される変異コードと既存CIテストのコピーは指定出力先だけに置く。

開始版のソースを別ディレクトリへ展開し、同じBun 1.4.4で再実行した。[有限比較結果](formal-methods-candidates-20261023/baseline-results.json)の5対象ファイルのhashと全suites、および[比較案結果](formal-methods-candidates-20261023/proposal-results.json)は調査原資料と一致した。[状態モデル結果](formal-methods-candidates-20261023/state-results.json)も原資料と一致した。CI変異の検出は既存テストでも成立し、trial単体の既存被覆に関する仮説はcompare-proposalの実行で補正される。新たな検出力には数えない。

125入力の比較は開始版と一時修正案の比較であり、追跡修正後の全列挙を意味しない。追跡修正後の確認には上記57件の実行を使う。両者を合わせ、共有parserで内数を検査し通常集計側の重複条件を除く選択を採った。型だけでは外部JSONの値を制約できず、呼出側に注意を残す案では経路間の不一致が再発する。新しい状態機械・常設依存・必須検査を追加する価値は確認できない。

別cloneでは、Bun 1.4.4の実体をPATH先頭に置き、以下をrepoルートで実行する。Python 3標準ライブラリも使う。`comparison` は新しい一時ディレクトリを指す。開始版の展開先に現在のlockfileでsetup済みのnode_modulesを参照させるが、依存の追加・変更はしない。

```sh
comparison=$(mktemp -d)
mkdir "$comparison/base" "$comparison/before" "$comparison/after"
for source in controls trial compare-proposal; do
  cp "docs/research/formal-methods-candidates-20261023/$source.ts.txt" "$comparison/$source.ts"
done
git archive 6e470b33eddc303a35728df9854fd0a7cb41da33 scripts | tar -x -C "$comparison/base"
ln -s "$PWD/node_modules" "$comparison/base/node_modules"
DOTAGENTS_ROOT="$comparison/base" DOTAGENTS_OUT="$comparison/before" \
  bun "$comparison/controls.ts"
DOTAGENTS_ROOT="$PWD" DOTAGENTS_OUT="$comparison/after" \
  bun "$comparison/controls.ts"
DOTAGENTS_ROOT="$comparison/base" DOTAGENTS_OUT="$comparison/before" \
  DOTAGENTS_COMMIT=6e470b33eddc303a35728df9854fd0a7cb41da33 \
  bun "$comparison/trial.ts"
DOTAGENTS_ROOT="$comparison/base" DOTAGENTS_OUT="$comparison/before" \
  bun "$comparison/compare-proposal.ts"
python3 docs/research/formal-methods-candidates-20261023/state-models.py "$comparison/state-results.json"
bun test scripts/tests/implement/recovery-option-boundaries.test.ts scripts/tests/implement/usage-contract.test.ts scripts/tests/implement/usage.test.ts scripts/tests/implement/review-probe.test.ts scripts/tests/implement/check-timeout-processes.test.ts
```

trialとcompare-proposalは修正前仕様との差を調べる資料なので開始版を指定する。修正後へ指定し直すと、旧parserがcache超過を受理するという観測のassertが失敗する。これは回帰テストの失敗とは区別する。`DOTAGENTS_COMMIT` は展開元の表示であり、機械的なGit同一性の証明ではない。ソースhashと併せて照合する。

共有結果では出力先を `$OUTPUT` へ置換し、一時トレースの保存先と経過時間を省いた。秘密情報・生ログ・ホスト固有パス・外部スキル本体は共有しない。原記録はホストに保全し、性能比較や総費用削減を主張しない。モデル作成・失敗・意味照合・将来の保守費用、対話モデルの総使用量は未計測である。

抽象モデルは保存失敗・実APIとの対応、権限履歴の全経路、OSの全状態を含まない。実GitHubの書込み、電源断、symlink競合、暗号学的性質、AI評価の意味の正しさ、終了性は保証しない。公開結果不明の扱いと権限制限を維持する現在の理由は既存の停止契約であり、過去の作者の意図をこの比較から補作しない。既存の形式手法活用を広げた今回の限定比較では、2件の追加改善を通常ガード・回帰テストへ反映した。残る7候補の現状維持は無欠陥の証明ではなく、既存保証と採用済み成果を踏まえて追加の置換効果を確認できなかったという判断である。
