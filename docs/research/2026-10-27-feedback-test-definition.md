# Research: feedback-test-definition

Generated: 2026-10-27（同日の初版を拡充）
Session: 95938cd9-a80d-41ac-bbaf-054ac15a623c
Intent: Understanding
Domain: General
Prior research: feedback-test-definition（この報告の初版。`find-prior-research.ts`で一致 3 語）

## 目的

dotagents の制御テストの`feedback`階層を、開発中に lint・型検査と一緒に回し、変更中のコードの機能の不具合を見つけるテストとして定義し直すための根拠を集めます。採否は後続の`/think`で決め、この報告では決めません。

利用者と合意済みの前提は次の 3 点です。

- `feedback`は、開発中に oxlint・oxfmt・biome・fallow・型検査と一緒に回し、実行すると変更中のコードの機能の不具合を見つけるテストです。判定の基準は不具合の発見への貢献で、ミューテーション（変異）の検出で測る想定です。
- `quality`は、合意した要求と公開契約を入口から守るテストです。
- `assurance`は、まれな事故や環境要因に備える保険です。

対象版は main の`4466983`（#448 のマージ後）です。初版は`af9be79`で、制御テストの内容は同じです。

## 初版からの変更

初版は 4 件の文献から「外部文献の主流は速さと決定性で分ける」と書きました。そのうち原文で確かめたのは Software Engineering at Google（以下 SWE book）11 章だけでした。今回の改訂では文献を 33 件に広げ、読んだ範囲を文献ごとに記録しました。件数を述べる所見には分母と文献 ID を付け、「主流」「多く」は使いません。

文献の一覧と読んだ範囲は[literature-sources.txt](2026-10-27-feedback-test-definition/literature-sources.txt)にあります。本文中の`L1`〜`L33`はこの一覧の ID です。道具を試した記録は[tool-probes.txt](2026-10-27-feedback-test-definition/tool-probes.txt)にあります。

## Key Findings

優先度の高は問いへの直接の答え、中は定義や道具の選択を左右する条件、低は背景です。状態の列は、初版の所見を再検証したか、置き換えたか、この版で加えたかを示します。

| Priority | 状態 | Finding | Source | Next Action |
| --- | --- | --- | --- | --- |
| 高 | 置換 | 全文を読んだテスト分類・性質の文献は23件（L1〜L17、L19〜L24）です。開発中や早い段階に回すテストについて、速さを条件か性質として挙げるのは14件です（L3、L4、L5、L7、L8、L10、L11、L12、L13、L14、L19、L20、L21、L24）。決定性や結果の信頼性を挙げるのは11件です（L7、L8、L10、L11、L12、L13、L14、L17、L20、L21、L24）。初版の「主流」の記述はこの件数に置き換えます | 文献ごとの対応表、literature-sources.txt | 問いへの答え。新定義は、速さと決定性を挙げる文献と異なる基準を採ると定義文の根拠に明記します |
| 高 | 新規 | 23件のうち、不具合の検出力（振る舞いの変化で結果が変わること）を、テストの階層や段階を分ける基準にした文献は0件です。振る舞いの変化への反応を、開発中に回すテストの定義の一部に入れるのは2件です（L7の開発者のテスト、L8のunit test）。テスト一般に望む性質として書くのは2件です（L6、L17）。開発中や早い段階のテストの目的や効果として不具合の発見を書くのは9件です（L3、L4、L5、L10、L11、L15、L17、L19、L20）。この9件は、本文がそのテストや段階で不具合を見つける・捕まえることを述べている文献です。23件の取得本文に`mutation`・`mutant`の語は0件でした（Disconfirmation Checkに出力） | 文献ごとの対応表、Disconfirmation Checkの検索出力 | 問いへの答え。検出力を階層の基準にする先行例は見つかっていないと定義文の根拠に書きます |
| 高 | 新規 | ミューテーションを開発の流れで使う8件（L26〜L33）は、変異を変更差分やレビューの単位で作ります。テストを階層へ分ける用途の例はありません。Googleは、コード全体の変異スコアは具体的でも行動可能でもないとして、生き残った変異を1件ずつレビューで示す方式を採りました（L27 §II冒頭、§II-D） | L27 §II、§II-A、§II-D、L31〜L33 | 問いへの答え。「階層全体を変異スコアで測る」案と「変更差分の変異で測る」案を`/think`で分けて検討します |
| 高 | 新規 | Googleの調査では、高優先度の不具合1502件のうち70%に結合する変異がありました。残る30%から抜き出した50件のうち23件は、対応しうる変異演算子がない不具合でした。論文はその例として、設定や環境の微妙な変更と、上位の仕様・プロトコルの不具合を挙げています。論文は、変異は実装が正しいかを確かめるのに向き、正しい仕様を実装したかは確かめないと述べます | L28 §IV-C1、§IV-C2 | 問いへの答え。変異で測れる範囲は`feedback`に、仕様は`quality`に、環境は`assurance`に当たります。3階層の分け方との対応として引用し、証明としては扱いません |
| 高 | 新規 | 開発中に回すテストの集合をFowlerは「compile suite」と呼びます。作業中の部分を対象にしたテストを変更のたびに回し、壊したらすぐ知るための集合です。速さは、回すのをためらわない程度と書き、絶対値を決めていません（L3 § Speed）。Beckは開発者のテストを、コードの判断ごとにフィードバックを返す予言者と表現します。待ち時間の境目として1秒未満、10秒、1分を挙げます（L7 § Programmer Tests） | L3 § Speed、L7 § Programmer Tests | 問いへの答え。新定義の「開発中に一緒に回す」は、この2件の使い方の定義に対応します |
| 高 | 再検証 | Test Desiderataは`Fast`と`Behavioral`を並べ、予測力を上げると遅くなるという性質同士の干渉を書いています（L6）。Beckのunit testの設定では、成功しても全体が動く確信は弱く、失敗すれば動いていない確信が強いとしています（L8 Predictive）。速さを基準から外しても、毎回回すための待ち時間の上限は別に必要です | L6、L8 | 問いへの答え。`/think`で「基準」と「階層に入れる上限条件」を分けて書きます |
| 高 | 再検証 | 決定性は判定の基準から外せますが、変異で測る前提条件として残ります。初版の限定試行では、変異と無関係な失敗が2回起き、除外しました。M5の`quality`実行での`correction-process.test.ts`の1件は、単独で変異なし・変異ありを各3回実行してすべて成功しました。M9の`assurance`実行での`process-cleanup.test.ts`の1件は、製品コードをimportしないファイルでした。このrepoには、lockの残存による断続的な失敗（`b29284f`）や、時間切れが後続のstack overflowに連鎖した失敗（`97d5104`）の修正履歴もあります。和田は自己検証と繰り返し可能性を自動テストに必須の性質としています（L20）。DeFlakerは、変更行を実行せずに失敗したテストを不安定と判定します。変異でも、変異行を実行しない失敗を検出に数えない手順に使えます | 初版の[followup-result.jsonl.txt](2026-10-27-feedback-test-definition/followup-result.jsonl.txt)（再実行していない）、`git log --oneline`の`b29284f`・`97d5104`、L20 § 自動テストに必須の性質、<http://www.deflaker.org/> | 問いへの答え。`/think`で、検出を数える前に基準の実行を複数回通す手順か、変異行を実行したかで失敗を絞る手順を検証方法に含めます |
| 高 | 新規 | 開発方針は、検出力の判断に一時コピーでの範囲を絞った不具合注入を認め、全テストへの不具合注入は求めないと定めています。`testing.md`にも、全テストへの毎回の不具合注入はしないとあります。合意した前提の「ミューテーション検出で測る」を階層全体へ広げると、この記述と衝突します | `docs/wiki/development-policy.md:172`、`skills/implement/references/testing.md:223` | 問いへの答え。測る範囲（変更差分か階層全体か）を利用者に確認します。方針の変更が要るかはその答えで決まります |
| 中 | 再検証 | 開発方針は、テスト評価のための専用の帳票・評価スコア・監査CLIを追加しないと定めます。改善効果の比較でも、専用の台帳・採点基盤・定期監査を設けません。Strykerを常設の依存や必須検査にする案は、この方針の変更を要します | `docs/wiki/development-policy.md:178`、`docs/wiki/development-policy.md:204` | 問いへの答え。Constraintsに記録します |
| 高 | 再検証 | 現行の`feedback`の定義は「変更直後に壊れたかが分かる、速くて結果が決まった検査」です。判断順の1番目も「同じ入力で同じ結果」「待ち時間にならない」を条件にしています。新しい基準はどちらの文書にもまだありません | `docs/wiki/development-policy.md:188`、`docs/wiki/development-policy.md:194`、`skills/implement/references/testing.md:57` | 問いへの答え。正本の`development-policy.md`から改訂案を作り、`testing.md`へ写します |
| 中 | 新規 | Bun 1.4.4の`bun test --changed`は、変更ファイルから静的なimportをたどってテストを選びます。`orchestrator.ts`経由でだけ届く`local-publication.ts`の変更で`premise-reference.test.ts`を選びました。一方、`orchestrator.ts`を一時ファイルに写して動的importする`allocation.test.ts`は選びませんでした。子プロセスで実CLIを起動するテストにも届かないと推定します | tool-probes.txt § 4、`scripts/tests/feedback/implement/allocation.test.ts:18-27`。子プロセスについては`inferred from`動的importを選ばなかった結果 | 問いへの答え。変更差分で選ぶ場合の漏れとして`/think`へ渡します |
| 中 | 新規 | Bun 1.4.4は`--rerun-each`、`--randomize`、`--seed`、`--retry`、`--timeout`を備え、不安定さの検出と時間上限を新しい依存なしで扱えます。ただし`scripts/tests/runner.ts`は`--parallel`、`--timings`、`--update-timings`以外の引数を拒否します | `bun test --help`の出力、tool-probes.txt § 5、`scripts/tests/runner.ts:104-112` | 問いへの答え。使う場合はrunnerの変更範囲を`/think`で決めます |
| 中 | 新規 | oxlint 1.87.0のjest・vitest規則（`expect-expect`、`no-disabled-tests`）は、`bun:test`からimportしたファイルでは何も報告しませんでした。同じ内容をvitestやグローバルの`test`で書くと報告します。biome 2.5.15の`noSkippedTests`・`noFocusedTests`は`bun:test`でも報告します | tool-probes.txt § 2、§ 3 | record only |
| 中 | 置換 | 初版の「litmusが`premise-reference.test.ts:15`と`:71`をassertionなしと報告」は誤検知でした。2件が呼ぶ補助関数は、`node:assert`の`assert`で検証しています。assertionの有無を静的に調べる道具は、補助関数の中の検証を数えない場合があります。調査中にホストの hook が実行した litmus も、`assert`だけで検証する`local-publication-bypass.test.ts:137`を「only weak: assert, assert」と報告しました | `scripts/tests/support/premise-reference.ts:51-59`、`scripts/tests/support/caller-first.ts:5-10` | record only。静的なスメル検出の結果は、補助関数の実装と照合してから使います |
| 中 | 再検証 | StrykerJS 10.1.1にBun用の公式runnerはありません。非公式の`@hughescr/stryker-bun-runner` 1.6.0はpeerが`typescript <7`です。READMEはTypeScript 7を試験的に使う手順も示しますが、TypeScript 6以下を並べて入れる必要があります。もう1つの`stryker-mutator-bun-runner` 0.4.0はcore 9にしか対応しません | `npm view`の出力（2026-10-27）、`package.json:38`、hughescr README § TypeScript 7's native checker (experimental)（`scout repo-read`、実行は未確認） | 問いへの答え。現状の依存のままでは導入できません |
| 低 | 再検証 | Strykerは既定で変異を実行時に切り替えます（mutant schemata）。dotagentsのテストの多くは実CLIを子プロセスで起動するため、有効な変異が子プロセスへ届くかは確認できていません。stryker-jsには、`node:vm`の文脈から変異へ届かないという未解決のissueがあります | `unknown, requires`子プロセスを起動するテスト1件でのStrykerの試行。stryker-js#6238（初版の`gh search issues`の題名、再検索していない） | record only |
| 中 | 再検証 | `feedback`の在プロセスの行カバレッジは全体で54%です。`correction.ts`（1513 行）2.19%、`publish.ts` 7.61%、`revision.ts` 6.87%、`orchestrator.ts`（1883行）56.41%で、主要な流れを担うモジュールほど低い値でした。`run-report.ts`、`usage-events.ts`、`shared/target.ts`は94%以上です。子プロセスで実行した行は数えていません | 初版の`bun test --coverage --coverage-reporter=text scripts/tests/feedback`の出力（`af9be79`、再実行していない） | 問いへの答え。「変更したモジュールに`feedback`が届くか」を`/think`の入力にします |
| 高 | 再検証 | 初版の手作業の変異9件では、`feedback`は高カバレッジ帯の3件をすべて検出し、中・低帯の6件をどれも検出しませんでした。通過した6件のうち、`quality`が2件、`assurance`の入力検査テストが1件を検出しました。M4の変異行は`feedback`が実行する行でしたが、変異は通過しました | 「限定試行」節、[mutants-result.jsonl.txt](2026-10-27-feedback-test-definition/mutants-result.jsonl.txt)（再実行していない） | 問いへの答え。検証方法の実例として`/think`へ渡します |
| 中 | 再検証 | `feedback`には、製品コードでなくテスト基盤や配置規則を確かめるファイルがあります。`test-runner.test.ts`、`test-runner-selection.test.ts`、`test-tiers.test.ts`、`checks/premise-reference.test.ts`、`actor-records.test.ts`です | 初版のimport文の照合（再実行していない） | 問いへの答え。`/think`で置き場所を決めます |
| 中 | 新規 | Fowlerは、上位のテストで見つかった不具合は下位のテストの欠落を意味し、下位で再現してから直すよう勧めます（L2）。Vockeも、上位のテストだけが失敗したら下位のテストを書くとしています（L5 § Avoid Test Duplication）。現行方針の「見逃した失敗を検出したテストの階層を見直す」は、テストを移す読み方と、`feedback`に足りないテストを足す読み方の両方を許します | L2本文末尾、L5規則1、`docs/wiki/development-policy.md:200` | 問いへの答え。`/think`で方針文の読み方を1つに決めます |
| 低 | 再検証 | このrepoは手作業の変異で検出力を判断した前例があります。テスト精査の課題では、別コピーの`slice`を変異させ、弱いテストは見逃し、適切なテストだけが失敗することを確かめました | `docs/research/test-review-scenario-20260928.md:11`、`docs/research/gpt-6-1-sol-medium-comparison-20260930.md:41` | record only |
| 低 | 再検証 | 現行の`feedback`は25ファイル236件で、1回の観測では2workerで4.2秒でした。最も長いファイルは`test-runner-selection.test.ts`の2.75秒です | 初版の`--timings`出力、[feedback-times.json.txt](2026-10-27-feedback-test-definition/feedback-times.json.txt) | record only |
| 中 | 再検証 | `.claude/OUTCOME.md`がありません。subagentとして実行したため、対話の`/outcome`でstubを作れませんでした | `bfs . -name 'OUTCOME*'`の出力が0件 | 利用者が`/outcome`で作成します |

## 文献ごとの対応表

列の意味は次のとおりです。「分類の軸」は文献がテストを分ける基準、「フィードバック用テスト」は開発中や早い段階に回すテストの扱い、「検出力」は不具合の発見や検出力への言及です。

| ID | 読んだ範囲 | 分類の軸 | フィードバック用テスト | 検出力 |
| --- | --- | --- | --- | --- |
| L1 Cohn | 全文（ブログ。書籍は未読） | 自動化する層（unit・service・UI）。UIを減らす理由は費用と壊れやすさ | unit testは不具合の行を示す具体的な情報を開発者に返す | 不具合の位置の絞り込みに触れる。検出力は扱わない |
| L2 Fowler TestPyramid | 全文 | 粒度（unit対broad-stack）。end-to-end・UI・customer-facingは直交すると明記 | 定義しない | 上位で見つかった不具合は下位テストの欠落。下位で再現する |
| L3 Fowler UnitTest | 全文 | unit testの共通要素は狭い範囲、開発者自身が書く、速い。実行の時点でcompile suiteとcommit suiteに分ける | compile suite。作業中の部分のテストを変更のたびに回す | 壊したらすぐ知りたい、直前の変更なら探す範囲が狭い。検出力は測らない |
| L4 Fowler DeploymentPipeline | 全文 | 段階。速さと確信度を交換する | 早い段階が速いフィードバックを返す | 早い段階でほとんどの問題を見つける |
| L5 Vocke | 全文 | 粒度。パイプラインの段階は種類でなく速さと範囲で決めると明記 | 速いテストを早い段階に置く | 上位だけが失敗したら下位のテストを書く |
| L6 Test Desiderata | 全文（性質の一覧。Medium原論文は未読） | 分類しない。12性質の組合せ | 定義しない | `Behavioral`。振る舞いが変われば結果が変わる |
| L7 Beck Programmer Test Principles | 全文 | 開発者のテストを性質で定義 | コードの判断ごとのフィードバック。速い、決定的、予測的 | 振る舞いの変化に反応し、構造の変化に反応しない |
| L8 Beck Desirable Unit Tests | 全文 | unit testを12性質の設定で表す | `Fast`、`Deterministic`を満たす | 振る舞いが意図せず変われば失敗する。失敗は「動かない」確信を与える |
| L9 Google Test Sizes | 全文 | 資源（ネットワーク、DB、ファイル、外部、スレッド、sleep）と時間上限 | 定義しない | 触れない |
| L10 Google Just Say No | 全文 | unit・integration・E2E（70/20/10を目安） | feedback loopの条件は速い、信頼できる、失敗箇所を絞れる | 不具合を見つける力だけでなく、直す力と防ぐ力で評価する |
| L11 SWE book 11章 | 全文 | size（資源。速さと決定性が最重要）とscope | unit testは早く高い確信を与える | 目的は不具合を捕まえることと変更を支えること。大きいテストは主な手段でない。カバレッジより振る舞いを問う |
| L12 SWE book 12章 | 全文 | unit testの書き方 | 小さいテストは速く決定的で、即時のフィードバックを返す | 本物の不具合なしに失敗するテストを「brittle」と定義 |
| L13 SWE book 13章 | 全文 | テストダブルの使い分け。忠実度 | unit testは速くあるべき | 忠実度の低いダブルは不具合を見逃す |
| L14 SWE book 14章 | 全文 | 大きいテストは忠実度のため。目的別の種類（性能、設定、カナリア、災害復旧など） | 開発者向けの条件は信頼できる、速い、規模に耐える | unit testの欠落（不忠実なダブル、設定、負荷、想定外の入力、創発）を大きいテストで補う |
| L15 Marick | 全文 | business facing対technology facing、support programming対critique the product | support programmingは書くコードを決め、変えたい振る舞いだけが変わったと確かめる | critique the productは完成品の不備を見つける |
| L16 Crispin | 全文 | L15の4象限。番号は順序でない | 定義しない | 触れない |
| L17 Meszaros | 全文（Web版の章） | 目標（品質・理解・リスク低減の価値と、実行・作成・保守の容易さ） | 簡単に実行できれば頻繁に回す（自動、自己検証、繰り返し可能、独立） | Bug Repellent、Defect Localization。Safety Netの効果は検証の完全さで決まり、欠けたassertionは網の切れ目 |
| L18 GOOS | 目次のみ | 見出しに「進捗を測るテストと回帰を捕まえるテストを分ける」がある | 見出しに「Feedback Is the Fundamental Tool」がある | 本文未読のため判断しない |
| L19 Feathers | 全文 | 資源（DB、ネットワーク、ファイル、並行不可、環境設定）でunit testから外す | 変更のたびに速く回せる集合を保つ | ロジックと外部の不具合を切り分けられる |
| L20 和田（gihyo） | 全文 | 分類しない。必須の性質と推奨の性質 | 即時のフィードバック。自己検証と繰り返し可能が必須、独立と高速が推奨 | 回帰テストで直前の変更の欠陥がわかる。品質保証には足りない |
| L21 和田（講演書き起こし） | 全文（媒体の書き起こし） | テストサイズ。曖昧さが少ない軸としてスコープより優先 | 信頼性の高い結果に短い時間で到達する。Smallを先に回す | 問題箇所の絞り込みに触れる |
| L22 Dodds Trophy | 全文 | Static・Unit・Integration・E2E | 確信と時間の投資対効果で配分 | 触れない |
| L23 Dodds Write tests | 全文 | 型と静的解析も確信を与える層 | integrationが確信と速さの釣り合いを取る | テストの価値は不具合がない確信で測る |
| L24 Spotify Honeycomb | 全文 | Integrated・Integration・Implementation Detail | 速く正確で信頼できるフィードバックを求めつつ、確信と変更しやすさのため速さを一部手放す | 触れない |
| L25 Khorikov | 見出しのみ | 四本柱（回帰からの保護、リファクタリング耐性、速いフィードバック、保守性） | 見出しの「速いフィードバック」 | 見出しの「回帰からの保護」。本文未読のため件数に含めない |
| L26 Google 2018 | 要旨のみ | 該当しない | 該当しない | 差分単位で、カバーされない行とarid lineを除いて変異を作る |
| L27 Google 2021 | 本文の一部（§I〜§II） | 該当しない | 変異はレビュー時に、変更行だけに作る | 全体の変異スコアは行動可能でないとして使わず、生き残った変異を個別に示す |
| L28 Google ICSE 2021 | 本文の一部 | 該当しない | 該当しない | 70%の不具合が変異と結合。結合しない不具合のうち対応する変異演算子がないものの例として、設定・環境の変更と仕様の誤りを挙げる |
| L29 Facebook 2021 | 要旨のみ | 該当しない | 該当しない | 生成した変異の半数以上が既存テストを通過。26人中ほぼ半数が提示された変異に対応 |
| L30 Meta ACH | 要旨と公式ブログのみ | 該当しない | 該当しない | 特定の懸念に絞った変異とテストを生成 |
| L31 PIT incremental | 全文 | 該当しない | 前回の結果を再利用して解析を減らす | 依存の変更が変異の結果を変えないという前提は未証明と明記 |
| L32 Stryker incremental | 全文 | 該当しない | 変更したコードとテストだけを再実行する | 前回の結果を再利用する条件を明記 |
| L33 cargo-mutants `--in-diff` | 全文 | 該当しない | プルリクエストの変更箇所だけを変異させる | 全体を変異させれば見つかる問題を見逃しうると明記 |

分類の軸を全文を読んだ 23 件で数えると、次のとおりです。1 件が複数の軸に入ることがあります。

| 分類の軸 | 件数 | 文献 |
| --- | --- | --- |
| 粒度・範囲・層 | 7 | L1、L2、L5、L10、L11、L22、L24 |
| 実行資源・速さ・決定性 | 6 | L4、L5、L9、L11、L19、L21 |
| 目的・利用者・実行の時点 | 4 | L3、L14、L15、L16 |
| 分類せず性質を並べる | 4 | L6、L7、L8、L20 |
| 不具合の検出力 | 0 | なし |

L12、L13、L17、L23 は分類の軸を述べない文献です。L17 は目標を挙げますが、テストを分ける基準としては使っていません。

## dotagentsの定義案の叩き台

前提の 3 階層を、文献との対応と食い違いとともに示します。定義文の確定は`/think`で行います。

### feedback

定義案は、開発中に oxlint・oxfmt・biome・fallow・型検査と同じ頻度で回し、変更中のコードの機能の不具合を検出するテストです。

| 項目 | 案 |
| --- | --- |
| 入る条件 | 変更差分に入れた変異を、lint と型検査を通る形のまま検出できること |
| 前提条件 | 変異なしの実行が同じ入力で同じ結果になり、待ち時間の上限に収まること。上限の値は未定 |
| 測り方 | 変更差分ごとに範囲を絞って変異を入れること。lint や型検査で止まる変異は集計から除き、変異行を実行しない失敗は検出に数えない |

| 文献との対応 | 根拠 |
| --- | --- |
| 開発中に変更のたびに回す集合という使い方 | L3 § Speed（compile suite）、L7、L15（support programming） |
| 振る舞いの変化への反応を、開発中に回すテストの定義に入れる | L7（開発者のテスト）、L8（unit test） |
| 開発中や早い段階のテストの目的や効果に不具合の発見を置く | L3、L4、L5、L10、L11、L15、L17、L19、L20 |
| lint・型検査を同じ流れに置く | L23（静的解析も確信を与える層）、L27 §II-D（レビュー時にlinterやformatterと並べて変異を示す） |
| 変異を変更差分の単位で使う | L26、L27 §II-A、L32、L33 |

| 文献との食い違い | 根拠 |
| --- | --- |
| 階層を分ける基準を検出力に置く文献は、全文を読んだ23件で0件 | 文献ごとの対応表 |
| 速さと資源で階層や段階を分けるべきと明記する文献がある。和田は、目的やスコープのラベルより曖昧さが少ない軸としてサイズを勧める | L5 § Putting Tests Into Your Deployment Pipeline、L11 § Test Size、L21 § テストサイズに基づくピラミッドの再構築 |
| 変異を使う先行例はレビュー時の個別提示で、階層全体のスコアは使わない | L27 §II冒頭、§II-D |
| 決定性を必須とする文献がある。新定義でも測定の前提条件として残る | L20 § 自動テストに必須の性質、L7 |
| 全テストへの不具合注入は開発方針の対象外 | `docs/wiki/development-policy.md:172`、`skills/implement/references/testing.md:223` |

### quality

定義案は、合意した要求と公開契約を、公開入口から一連の fixture を通して守るテストです。マージ前には必ず通します。

| 文献との対応 | 根拠 |
| --- | --- |
| 公開APIを通すテストは利用者との契約になる | L12 § Test via Public APIs |
| 業務の言葉で説明できるテストを区別する | L15（business facing）、L16 |
| 対応する変異演算子がない不具合の例に、上位の仕様・プロトコルの誤りが挙がっている | L28 §IV-C2 |

| 文献との食い違い | 根拠 |
| --- | --- |
| 下位で再現できる不具合は下位のテストで守るよう勧める文献がある。`quality`だけが検出した不具合を`feedback`に足すかは方針文で決まっていない | L2、L5 § Avoid Test Duplication、`docs/wiki/development-policy.md:200` |
| 「入口から」は範囲の軸で、目的の軸と直交するとの指摘がある | L2（end-to-end・UI・customer-facingの直交） |

### assurance

定義案は、中断・時間切れ・ホスト復帰・プロセスの後始末・lock など、まれな事故や環境要因に備える保険です。repo 全体の走査もここに置きます。

| 文献との対応 | 根拠 |
| --- | --- |
| unit testが埋めない欠落（設定、負荷、想定外の入力、創発）を大きいテストで補う | L14 § Common Gaps in Unit Tests |
| 災害復旧やカオス工学を目的別の大きいテストとして挙げる | L14 § Types of Larger Tests |
| 通常の顧客テストで起こせない状況での振る舞いをリスク低減として確かめる | L17 § Tests should reduce (and not introduce) risk |
| 対応する変異演算子がない不具合の例に、設定・環境の微妙な変更が挙がっている | L28 §IV-C2 |

| 文献との食い違い | 根拠 |
| --- | --- |
| 初版の試行では、入力の組合せ拒否を確かめる要求の入口のテストが`assurance`にあり、M4を検出した | 「限定試行」節のM4 |

## OSSツールの調査

「方針の変更」の列は、`development-policy.md:172`（範囲を絞った不具合注入は可、全テストへの注入は求めない）、`:178`（専用の帳票・評価スコア・監査 CLI を追加しない）、`:204`（専用の採点基盤・定期監査を設けない）に照らした判断です。どの行に当たるかの解釈はこの報告のもので、利用者の確認が要ります。

| 観点 | ツール | 機械的に判定すること | dotagentsで使えるか | 方針の変更 |
| --- | --- | --- | --- | --- |
| サイズ・時間 | Bazelの`size`・`timeout` | sizeから既定の時間上限と資源の見積もりを決め、超過で失敗にする。`--test_verbose_timeout_warnings`で過大な宣言を示す。`flaky`属性は3回まで再実行する | 使えない。ビルド体系の置き換えが要る | 要。新しいビルド体系の導入 |
| サイズ・時間 | Pantsの`javascript_test` | `timeout`とバッチ実行の互換タグ。sizeの概念はない | 未確認。Bunへの対応は調べていない | 要。新しいビルド体系の導入 |
| サイズ・時間 | Buck2のテスト実行 | ラベルをtest runnerへ渡す。取得した文書にsizeの概念はない | 使えない | 要 |
| サイズ・時間 | Bun 1.4.4の`--timeout`と既存runnerの`--timings` | テストごとの時間上限（既定5000ms）とファイルごとの所要時間の記録 | 使える。既存の依存 | 不要（既存の機能） |
| 不安定さ | iDFlakies | 実行順の入れ替えと再実行で、順序依存と非順序依存の不安定さを分類する | 使えない。Java（Maven・Gradle）専用 | 要 |
| 不安定さ | DeFlaker | 変更行を実行せずに失敗したテストを不安定と判定し、再実行する | 使えない。Java（Maven）専用。判定の考え方は変異の集計に応用できる | 要 |
| 不安定さ | NonDex | 仕様が順序を定めないAPIへの依存を見つける | 使えない。Java専用 | 要 |
| 不安定さ | Bun 1.4.4の`--rerun-each`・`--randomize`・`--seed`・`--retry` | ファイルの繰り返し実行、順序の乱択、種の固定 | `bun test`から直接なら使える。`runner.ts`は引数を拒否する | 単発の利用は不要。runnerやcheckへ組み込む場合は変更範囲の合意が要る |
| 不安定さ | `shake` workflow（`~/.claude/workflows/shake`） | 4つの観点で各10回揺さぶり、不安定さを分類する | このrepoの外にある利用者のハーネス。OSSではない | 該当しない |
| テストスメル | tsDetect、JNose | JUnitのテストスメル | 使えない。Java専用 | 要 |
| テストスメル | SNUTS.js | 公開repoを複製してJest・Jasmineのスメルを検出するAPI | 未確認。`bun:test`への対応は試していない | 要。新しい監査用の道具 |
| テストスメル | smelly-test | JavaScript・TypeScriptのスメルをVS Code拡張とCLIで検出 | 未確認。実行していない | 要。新しい監査用の道具 |
| テストスメル | oxlintのjest・vitest規則 | assertionのないテスト、無効化したテストなど | 現状では使えない。`bun:test`のimportを認識しない（tool-probes.txt § 2） | 不要（既存の依存の設定変更） |
| テストスメル | biomeの`noSkippedTests`・`noFocusedTests` | `skip`・`only`の残存 | 使える。`bun:test`でも報告する（tool-probes.txt § 3） | 不要（既存の依存の設定変更）。check対象の変更として合意は要る |
| テストスメル | litmus（ホストに導入済み） | assertionの弱さ、モックの多用など | 動くが、補助関数内の`assert`を数えない誤検知がある | 要。必須検査にするなら監査CLIの追加に当たる |
| 検出力 | StrykerJS 10.1.1 | 変異を入れてテストが失敗するかを数える。`--incremental`で変更分だけ再実行する | 公式runnerなし。`commandRunner`は動くが、カバレッジ分析がなく変異ごとに全体を再実行する | 常設なら要（`:178`）。一時コピーでの範囲を絞った試行は`:172`の範囲内だが、依存の追加が要る |
| 検出力 | `@hughescr/stryker-bun-runner` 1.6.0 | テストごとのカバレッジで、変異に届くテストだけを実行する | 現状では使えない。`typescript <7`のpeer。TypeScript 7の試験的な手順もTypeScript 6以下の併用が要る | 要（依存の変更と`:178`） |
| 検出力 | `stryker-mutator-bun-runner` 0.4.0 | 同上 | 使えない。core 9にしか対応せず、2025-07-07以降更新がない | 要 |
| 検出力 | PIT、mutmut、cargo-mutants、Mull | JVM、Python、Rust、C・C++の変異テスト。cargo-mutantsは`--in-diff`、PITはincremental analysisを持つ | 使えない。TypeScriptに非対応 | 要 |
| 検出力 | 一時コピーへの手作業の変異 | 初版の`run-mutants.ts.txt`による階層ごとの検出 | 使える。初版で9件を試行 | 不要（`:172`の範囲内） |
| テスト選択 | Bun 1.4.4の`--changed` | gitの変更ファイルから静的なimportをたどってテストを選ぶ | `bun test`から直接なら使える。動的importを選ばない。`runner.ts`は引数を拒否する | 単発の利用は不要 |
| テスト選択 | Launchable（CloudBees Smart Tests CLI） | 過去の結果から実行するテストの部分集合を選ぶ | 使えない。CLIはOSSだが、APIキーと外部サービスへのテスト結果の送信が要る | 要。外部へのデータ送信 |
| テスト選択 | STARTS、Ekstazi、pytest-testmon | 静的・動的な依存によるテストの選択 | 使えない。JavaとPython専用 | 要 |
| Test Desiderata | benomahony/testdesiderata | Pythonのテストを静的に調べ、決定性・独立性・速さ・振る舞いの違反を報告する | 使えない。Python専用 | 要 |

TypeScript で Test Desiderata の性質を計測する道具は見つかりませんでした。検索は 1 回だけです（`unknown, requires`別の語での追加検索）。

## 限定試行（初版、再実行していない）

定義の検証方法が使えるかを確かめるため、初版で手作業の変異 9 件を作り、階層ごとの検出を観測しました。目的は検出率の推定ではありません。変異は在プロセスのカバレッジ帯（高・中・低）から選び、条件の反転、検査の除去、境界の変更にしました。

実行環境は`git archive HEAD`で作った別コピーです。各変異について`bun scripts/tests/runner.ts bun scripts/tests/feedback --parallel=2`と`bun scripts/tests/runner.ts bun scripts/tests/quality --parallel=4`を実行しました。`assurance`は、sandbox 内で`ps`を拒否される 7 件が変異と無関係に失敗するため、M4・M6・M9 だけで実行しました。検出として数えたのは、基準の 7 件の失敗より増えた失敗だけです。M5 の`quality`で失敗した`correction-process.test.ts`の 1 件は、そのファイルだけを変異なしと変異ありで各 3 回実行するとすべて成功したため、変異と無関係と判断しました。M9 の`assurance`で増えた`process-cleanup.test.ts`の 1 件も、製品コードを import しないファイルのため同じ扱いです。

| ID | 帯 | 変異 | feedback | quality | assurance |
| --- | --- | --- | --- | --- | --- |
| M1 | 高 | `usage.ts:59` 再試行の数え方を反転 | 検出（`usage.test.ts`） | 通過 | 未実行 |
| M2 | 高 | `shared/target.ts:53` `ciChecks`の重複拒否を除去 | 検出（`target.test.ts`） | 通過 | 未実行 |
| M3 | 高 | `run-report.ts:140` `/private/tmp/`の一時パス判定を除去 | 検出（`run-report.test.ts`） | 通過 | 未実行 |
| M4 | 中・在プロセスで実行される行 | `orchestrator.ts:310` 復帰入口の併用上限を1から2へ | 通過 | 通過 | 検出（`check-timeout-recovery.test.ts:643`、入力の組合せ拒否） |
| M5 | 中・在プロセスで実行されない行 | `orchestrator.ts:326` `--review-run`の併用検査を常に成功へ | 通過 | 通過（不安定な1件を除く） | 未実行。`oxlint`が失敗 |
| M6 | 低 | `correction.ts:217` 保全中のソース変更検査を除去 | 通過 | 通過 | 機能テストは通過。lint検査だけが失敗 |
| M7 | 低 | `correction.ts:258` 検証中の対象設定変更の検査を除去 | 通過 | 検出（`conflicting_target`） | 未実行 |
| M8 | 低 | `publish.ts` draft確認の検査を除去 | 通過 | 検出（`publisher: created_ready`ほか4件） | 未実行。`oxlint`が失敗 |
| M9 | 低 | `revision.ts:141` 停止照合のbranch一致検査を除去 | 通過 | 通過 | 機能テストは通過。lint検査だけが失敗 |

`true ||`の形で書いた M5・M6・M8 は`no-constant-binary-expression`で、関数を未使用にした M9 は`sourceBranch`の`no-unused-vars`で、どれも`oxlint --deny-warnings`が失敗しました。開発中は`feedback`と一緒に lint も回すので、これらはテストより先に lint で止まります。機能テストの検出力を測るには、lint と型検査を通る形で変異を作るか、lint で止まる変異を集計から除く必要があります。

試行の費用は、変異 1 件あたり`feedback`約 4 秒、`quality`約 72 秒、`assurance`約 265 秒でした（各 1 回の観測）。資料は[2026-10-27-feedback-test-definition/](2026-10-27-feedback-test-definition/)にあります。`mutants.json.txt`が変異の一覧、`run-mutants.ts.txt`と`run-followup.ts.txt`と`lint-mutant.ts.txt`が実行スクリプト、`mutants-result.jsonl.txt`と`followup-result.jsonl.txt`が結果です。

## Available Data

| Type | Item | Note |
| --- | --- | --- |
| File | `docs/wiki/development-policy.md` § 制御テストの階層 | 階層の定義と判断順の正本 |
| File | `skills/implement/references/testing.md:53-61` | 独立テスト担当向けの写し |
| File | `scripts/tests/feedback/checks/test-tiers.test.ts` | 階層外や未知の階層のテストを失敗にする検査 |
| File | [literature-sources.txt](2026-10-27-feedback-test-definition/literature-sources.txt) | 文献33件のURL、読んだ範囲、参照箇所 |
| File | [tool-probes.txt](2026-10-27-feedback-test-definition/tool-probes.txt) | oxlint・biome・`bun test --changed`・runnerの試行の出力 |
| Command | `bun test --changed[=REF]` | 静的importをたどる変更ファイル単位のテスト選択 |
| Command | `bun test --rerun-each=N --randomize --seed=N` | 不安定さの確認 |
| Command | `bun scripts/tests/runner.ts bun <paths> --timings=FILE --update-timings` | ファイル単位の所要時間の記録（`scripts/README.md:857`） |
| Tech | Bun 1.4.4、TypeScript 7.0.2、oxlint 1.87.0、biome 2.5.15 | `package.json` |
| Data | 階層ごとの件数と所要時間 | 初版の観測。`feedback` 25ファイル236件・4.2秒、`quality` 14ファイル424件・72.9秒、`assurance` 22ファイル536件・282.4秒、合計1,196件 |

## Constraints

| Category | Constraint |
| --- | --- |
| 方針 | 検出力を判断しにくい箇所では一時コピーでの範囲を絞った不具合注入を使い、全テストへの不具合注入は求めない（`docs/wiki/development-policy.md:172`、`skills/implement/references/testing.md:223`） |
| 方針 | テスト評価のための専用の帳票・評価スコア・監査CLIは追加しない（`docs/wiki/development-policy.md:178`）。比較のための専用の採点基盤・定期監査も設けない（同`:204`） |
| 方針 | 階層の定義の正本は`development-policy.md`で、`testing.md`は写し。改訂は正本から行う（`skills/implement/references/testing.md:53`） |
| 技術 | `typescript 7.0.2`は、`@hughescr/stryker-bun-runner`のpeer `typescript <7`と合わない（`package.json:38`、`npm view`） |
| 技術 | `runner.ts`は`--parallel`・`--timings`・`--update-timings`以外の引数を拒否する（`scripts/tests/runner.ts:104-112`） |
| 環境 | sandbox内では`assurance/implement/review-recovery.test.ts`の7件が`ps`の拒否で失敗する（初版の実行出力、#448本文） |
| OUTCOME | `.claude/OUTCOME.md`が未作成のため、Non-goalsとConstraintsとの照合ができていない |

## Disconfirmation Check

合意した前提（基準は不具合の発見への貢献で、変異の検出で測る）を否定する材料を探しました。

1 つ目に、検出力で階層を分ける先行例を探しました。全文を読んだテスト分類・性質の文献から取得した本文で、変異の語を検索しました。

```text
$ ugrep -l -i 'mutation|mutant' cohn.md fowler-pyramid.md fowler-unit.md fowler-dp.md vocke.md desiderata.md beck-medium-pt.md beck-newsletter.md gtb-sizes-body.txt gtb-e2e-body.txt swe11.md swe12.md swe13.md swe14.md marick.md crispin.md xunit-goals.md feathers.md twada-gihyo.md logmi-330972.md logmi-329184.md dodds-trophy.md dodds-write.md spotify.md; echo "exit=$?"
exit=1
```

0 件が検索の誤りでないことを、変異の文献で確かめました。

```text
$ ugrep -c -i 'mutation|mutant' arxiv-practical-html.md stryker-incr.md
stryker-incr.md:19
arxiv-practical-html.md:187
```

語が出ないことは概念がないことを意味しません。L7 と L8 は、振る舞いの変化への反応を、開発者のテストや unit test の定義の一部に入れています。新しい`feedback`の定義に最も近い先行例です。L6 の`Behavioral`と L17 の Safety Net は、テスト一般に望む性質として検出力を述べています。それでも、どの文献も検出力を階層の境界には使っていません。前提は文献の分類と異なる基準を採ります。

2 つ目に、変異の先行例が階層全体の測定を支えるかを調べました。L27 §II 冒頭は、コード全体の変異スコアを計算し続けることは費用が見合わず、スコアは具体的でも行動可能でもないと述べます。Google が採ったのは、レビュー時に変更行だけを変異させ、生き残った変異を個別に示す方式です。前提の「変異の検出で測る」は、変更差分の単位なら先行例と一致し、階層全体のスコアなら一致しません。開発方針の`:172`も、全テストへの注入を求めていません。

3 つ目に、前提を支える材料も確かめました。L28 §IV-C2 は、変異と結合しない不具合のうち対応する変異演算子がないものの例として、設定・環境の変更と仕様の誤りを挙げています。変異で測れる範囲を`feedback`に、それ以外を`quality`と`assurance`に置く 3 階層の分け方は、この結果と矛盾しません。

この結果から、`/think`で答えるべき問いが 2 つ残ります。1 つ目は、検出を変更差分ごとに測るか、階層全体で測るかです。2 つ目は、速さを基準から外したとき、検出力が高く遅いテストが`feedback`へ流れ込むのを、どの上限で止めるかです。

## References

| Path | Description |
| --- | --- |
| [literature-sources.txt](2026-10-27-feedback-test-definition/literature-sources.txt) | 文献L1〜L33の一覧 |
| <http://www.deflaker.org/> | DeFlakerの判定方法 |
| <https://bazel.build/reference/be/common-definitions> | Bazelの`size`・`timeout`・`flaky` |
| <https://bazel.build/reference/test-encyclopedia> | Bazelのテスト実行環境とtimeoutの警告 |
| <https://www.pantsbuild.org/stable/reference/targets/javascript_test> | Pantsの`javascript_test` |
| <https://buck2.build/docs/rule_authors/test_execution/> | Buck2のテスト実行 |
| <https://stryker-mutator.io/docs/stryker-js/configuration/> | `commandRunner`と`coverageAnalysis`の制約 |
| <https://github.com/stryker-mutator/stryker-js/issues/4439> | Bun test runnerの要望（未解決） |
| <https://github.com/stryker-mutator/stryker-js/issues/5424> | 公式scopeへのBun runner追加の要望（未解決） |
| <https://github.com/hughescr/stryker-bun-runner> | 非公式Bun runner |
| <https://github.com/UT-SE-Research/iDFlakies> | 不安定なテストの検出（Java） |
| <https://github.com/gmu-swe/deflaker> | 変更行を実行しない失敗の判定（Java） |
| <https://github.com/TestingResearchIllinois/NonDex> | 順序を定めないAPIへの依存の検出（Java） |
| <https://github.com/TestSmells/TestSmellDetector> | tsDetect（Java） |
| <https://github.com/arieslab/jnose> | JNose（Java） |
| <https://github.com/Jhonatanmizu/SNUTS.js> | SNUTS.js（JavaScript） |
| <https://github.com/marabesi/smelly-test> | smelly-test（JavaScript・TypeScript） |
| <https://github.com/launchableinc/cli> | CloudBees Smart Tests CLI |
| <https://help.launchableinc.com/resources/cli-reference/> | APIキーの要件 |
| <https://github.com/benomahony/testdesiderata> | Test Desiderataの静的検査（Python） |
| docs/research/test-review-scenario-20260928.md | 手作業の変異で検出力を判断した先行例（slug一致1語） |
| docs/research/test-redundancy-pilot-20261010.md | 独立テストの冗長性判断の試行（slug一致1語、今回の判断には未使用） |
| <https://github.com/thkt/dotagents/pull/448> | 3階層への分割PR |

## Coverage Notes

- 要旨しか読めなかった文献は L26、L29、L30 です。L18（GOOS）は目次だけ、L25（Khorikov）は見出しと第三者の要約だけです。これらは件数に含めていません。L1 は 2009 年のブログで、書籍は読んでいません。
- Test Desiderata の原論文（Medium）は 403 で取得できませんでした。L6 が原論文として挙げる 2 本のうち、L7（Programmer Test Principles）は全文を読みました。
- L27 と L28 は本文の一部だけを読みました。読んだ節は literature-sources.txt にあります。
- `unknown, requires` Stryker の試行。有効な変異が、テストから起動した子プロセスの CLI へ届くかは未確認です。
- `unknown, requires` TypeScript 6 を併用した別コピーでの`@hughescr/stryker-bun-runner`の実行。
- `unknown, requires` SNUTS.js と smelly-test の`bun:test`のファイルでの実行。
- `unknown, requires` `bun test --changed`が子プロセスで起動する CLI の変更を選ぶかの直接の試行。今回は動的 import の未選択から推定しました。
- `unknown, requires` 本数を増やした変異試行。9 件は検出率の推定には足りません。
- `unknown, requires` sandbox 外での全階層の変異試行。
- 文献の件数は分類の判断を含みます。各文献をどの軸に入れたかは対応表の記述が根拠です。
- 初版の限定試行、カバレッジ、所要時間、import 照合は再実行していません。
- `.claude/OUTCOME.md`が未作成です。利用者が`/outcome`で作成する必要があります。
- Advisor。初版で 2 回、今回の改訂の合成前と完了前に各 1 回実行しました。その指摘で、件数の分母と文献 ID の明記、litmus の誤検知の確認、Stryker の行の更新、`development-policy.md:172`の追加、試行記録の保存、`allocation.test.ts`の読み直し、L7・L8 の分類の分割、L28 の記述の限定、初版の根拠（`b29284f`・`97d5104`、Stryker の子プロセスの行、lint 規則名、資料の一覧）を復元しました。
- 調査中、ホストの PostToolUse hook が、この repo の既存コードの knip と litmus の指摘で書き込みのたびに失敗を返しました。指摘は今回の変更と無関係のファイルで、報告と資料の書き込み自体は完了しています。

## Next Steps

調査はここで完了です。`feedback`の定義文、判断順、測る範囲、既存ファイルの再分類案は、後続の`/think`で設計します。

| Intent | Next Command |
| --- | --- |
| Feature planning | `/think` |
| Bug investigation | `/fix` |
| Understanding only | complete |
