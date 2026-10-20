# pstackの導入候補とdotagentsとの比較

公開時の補足（2026-10-20）：以下は10月11〜13日の調査・提案・失敗記録です。「現行」「未採用」は調査時点を指します。当時の基点は[固定版](https://github.com/thkt/dotagents/tree/7aca234e768638a3d77a6d72d2cff928d3edb44f)です。後続の[PR #389](https://github.com/thkt/dotagents/pull/389)で前提の検証、[#390](https://github.com/thkt/dotagents/pull/390)で設計理由、[#392](https://github.com/thkt/dotagents/pull/392)で機械化候補の手順が整備されました。性能測定は[#400](https://github.com/thkt/dotagents/pull/400)、利用側の例は[#391](https://github.com/thkt/dotagents/pull/391)・[#411](https://github.com/thkt/dotagents/pull/411)で具体化されています。現在の説明は[開発方針](../wiki/development-policy.md)とその参照先が正本です。`output/`由来の検査混入は[PR #412](https://github.com/thkt/dotagents/pull/412)で対処済みです。以下の過去の数値を更新したものでも、導入効果を再測定したものでもありません。

pstackを一括導入するより、既存のscoping・implementに不足する具体的な観点を選んで取り入れることを推奨する。まず、繰り返す注意や暗黙の条件を型・lint・実行時検査・スクリプトで守れないか、AI自身が調査・検討する入口を具体化する。あわせて、変更の安全性を支える前提の検証と、必要な場面で使う設計・測定・実アプリ検証の方法を検討する。

一方、外部書込みの権限、自動マージ、PRを最初からreadyで作る指示、コメント削除の既定方針は、現行ハーネスにそのまま適用できない。複数モデルや多数の検証担当を常時必須にする運用も、追加費用に見合う効果が未確認である。

2026-10-11に全体を比較し、2026-10-12に機械化の自律検討を追補した。2026-10-13に他の導入候補も含めて整理した。以下の推薦は内容と適用場面の比較による提案であり、採用効果を実証した順位ではない。

この報告は未採用の提案である。スキル、実行コード、公開方針の変更、Issueの作成、プラグインの導入は行っていない。

## 導入候補のまとめ

共通の実装・レビューへ加える入口と、特定の課題で使う方法を分ける。全候補を毎回の工程にせず、判断が変わる条件で使う。取り入れる内容は次の八つに整理できる。

| 観点 | AIに調査・実行させること | 使う場面と既存との差 |
| --- | --- | --- |
| 機械で守る方法の自律検討 | 人の注意に依存する条件を見つけ、既存の保証を調べ、型・lint・実行時検査・スクリプト・テストを比較する。追加が不要な理由も判断する | 最初に具体化する共通の入口。現行にも再発防止の方針はあるが、選択済みの規則の検証と、AIが自発的に候補を発見することを分けて確かめる |
| 安全性を支える前提の実証 | 「この変更が安全なのは何が成り立つからか」を特定し、対象版・外部契約・非同期順序などを必要な実行証拠で確かめる | 暗黙の前提に依存する変更。既存の依存先・状態遷移の確認を具体化し、非局所の前提を検索結果だけで保証しない |
| 停滞時に共通の前提を疑う | 同じ前提で失敗が続く場合、その前提と反証条件を明示する。観測で原因仮説を切り分けてから次の修正を選ぶ | 同種の修正が効かない場面。現行の停滞理由の再評価に、前提を反証する観測方法を加える。担当間の偏りの集計は関係する課題だけで使う |
| 設計理由の根拠と確度を保つ | 当時の明示的な理由、間接証拠からの推論、推測、理由不明を区別する。矛盾する記録も残す | 防御処理や過去の設計を見直す場面。既存の事実・推論の区別を具体化し、今もっともらしい理由を当時の意図として扱わない |
| 利用側の例から設計する | 呼出し側の利用例と期待する結果を先に書き、型・公開境界・所有者を比較する | 変更費用が大きいAPIや責任の境界。現行の保守性レビューを具体化する。すべての関数変更に複数モデルや二案を要求しない |
| 性能数値の意味を検証する | 計時範囲、実処理の完了、正しさと処理量、比較条件、ばらつき、全体への効果を確認する | 数値で採否や優先度が変わる性能課題。既存の版・入力・環境・費用の比較に、処理を測っていない可能性の確認を加える |
| 実アプリの検証手順を通す | 起動、正しい実行環境の確認、利用操作、証拠保存、後片付けを一つの手順として実行する | 対象repoの既存手順で要求を再現できない場面。setup・check・CI・captureの受け皿を使い、手順を書くだけで完了にしない |
| 候補比較と分担調査を選び分ける | 同じ課題の別案を比較するか、異なる範囲を分担するかを先に決め、判定根拠と未確認範囲を揃える | 一つの設計判断が高くつく場合や調査範囲が広い場合。既存の独立評価を補助する選択肢であり、担当数やモデルの一致を正しさの保証にしない |

最初の候補は、AIが具体的な守る条件を発見し、何で保証するのが適切かを考える入口である。安全性の前提を調べる方法は、その条件や証拠を特定する助けになる。性能測定や実アプリ検証の候補は、対象repoの課題が生じた際に使う。

型・データ構造から考え、不要な構造を減らす方針は、現行にもある。読者が辿る層や保持する状態を減らし、現物の観測で完了を判断する方針も、共通の基盤として維持する。原則の本文を重複して増やすより、上表の入口・具体例・適用条件を既存の参照へつなぐ。

出典と詳しい判断は、以下の各候補、補助候補、全スキル・playbookの評価に記す。外部操作の権限、自動マージ、readyでのPR作成、コメント削除の既定方針を移植する案は含めない。新しい必須工程・専用台帳・全repoの常時監査も、この整理からは要求しない。

## 調査対象と確認範囲

問いは「pstackから、このハーネスへ取り入れる価値があるものは何か」である。2026年10月11日に、[cursor/pluginsのpstack](https://github.com/cursor/plugins/tree/11713c683fe4add4fd403ea880580abbc9e0875f/pstack)を取得した。対象commitは`11713c683fe4add4fd403ea880580abbc9e0875f`、pluginの版は`0.15.17`、ライセンスはMITである。以後の外部リンクはこのcommitに固定した。

対象には165ファイルがあり、トップレベルの52個の`SKILL.md`、23個のplaybook、2個のagent定義を全文で確認した。52個の内訳は24個の原則と28個の作業スキルである。加えて、README・manifest・licenseと、関連する設計・検証・判断根拠の参照文書を読んだ。Bennyの入口と主要手順、PR監視・計画検査・作業管理・worktree監査のコードも確認した。補助文書やコード・テストを含む165ファイルすべての全文監査ではない。

比較側はdotagentsのHEAD `7aca234e768638a3d77a6d72d2cff928d3edb44f`と、調査時の作業ツリーである。特に[開発方針](../wiki/development-policy.md)、[scoping](../../skills/scoping/SKILL.md)、[implement](../../skills/implement/SKILL.md)、[CLIガイド](../../scripts/README.md)、[検証結果の適用範囲](../wiki/evidence-scope.md)、[根拠の引き継ぎ](../wiki/reference-handoff.md)を照合した。開発方針と研究索引には既存の未commit変更があり、それも比較対象に含めた。今回その既存変更は編集していない。

pstackに対して実行した追加確認は、PR監視コードに模擬入力を渡すローカル検証のみである。実行にはBun `1.4.3`を使った。Cursorでの運用、上流のテスト一式、実際のPR監視、モデルを使った導入効果の比較は実施していない。

## pstackの構成と、比較で重視する違い

[poteto-mode](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/poteto-mode/SKILL.md)が入口となり、作業種別に応じてplaybook、原則、専門スキルへ振り分ける。設計候補の比較、コード作業の委譲、複数の観点からのレビュー、実行検証を組み合わせ、継続的に仕事を進めるための指示が充実している。作業種別から必要な参照を選ぶ構造は参考になる。

ただし、手順に要求を書いたことと、実行側が要求を強制できることは別である。PR監視コードや作業管理コードは一部の状態を機械で扱うが、権限、検証証拠の意味、独立性、要求充足の多くはモデルへの指示で担う。dotagentsでは、合意済みIssue、対象版の照合、必須CI、独立評価、公開前の確認、人によるマージが責任分担の中心である。pstackの指示を増やしても、この実行側の確認を置き換える根拠にはならない。

現行の入口はscopingとimplementの二つに絞っている。pstackのカタログ全体を追加すると、参照先の選択と重複規則の更新が増える。採用するなら、既存の参照文書や対象repoの検証手順に、条件付きの具体例として加えるのが適している。

## 2026-10-12の追補：機械で守る方法をAI自身が調べる

対話で追加候補として挙がったのは、型・lint・実行時検査・スクリプトへ移せる条件を、AIが自律で調査・検討する方向である。既存の規則を機械化する方法だけでなく、通常の実装・レビュー中にその候補を発見する入口を具体化する。

[encode-lessons-in-structure](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/principle-encode-lessons-in-structure/SKILL.md)は、同じ指示を繰り返すときに機械的な仕組みへ移せないか考える。[現行方針](../wiki/development-policy.md#ドキュメントの更新)にも採用した指摘の原因・再発性を調べ、必要な検証へつなぐ考え方がある。ただし、[コード規則の限定試行](code-context-pilot-20261006.md)は選択済みの一規則を扱ったもので、AIの自発的な発見や開発上の改善効果を確認した結果ではない。

追加する場合の指示案は次のとおりである。これは未採用の案であり、今回スキルへ反映したものではない。

> 実装・レビューで、繰り返す注意や、守るべき条件が人の記憶に依存する箇所を見つけたら、その必要性・適用範囲・既存の保証を調べる。型、既存lint、実行時検査、スクリプト、既存テストで守れるか比較し、実装・維持・誤検出の負担を含めて最小の方法を選ぶ。判断を左右する不明点があれば、正例・違反例・適用外の小さな例で確かめる。既存の保証で十分な場合や、追加の負担が効果を上回る場合は、その理由を示して見送る。合意範囲内で必要な改善は通常の実装へ含め、規約変更や範囲外の改善は根拠と影響を伴う候補として示す。

型は表現できる状態・値の組合せ、lintはコードから判定できる規則、実行時検査は外部入力や実行中に変わる条件に適する。スクリプトは反復作業や再実行できる調査・検証、テストは実際の振る舞いや順序の確認を担える。この対応を固定の優先順位にはせず、対象条件を保証できる範囲で選ぶ。型で検査できない外部状態を型だけで保証したとは扱わない。

候補を見つけた際の調査・比較・小さな再現は、許可された通常作業の中で進める案である。全repoの常時監査、新しい専用台帳、自動的な規則追加は含めない。既存のfindingsやIssueに、守る条件、既存の保証、推奨案、見送る案の理由、適用限界を必要な範囲で残す。

限定試行では、機械化すべき未保証の条件、既存検査で十分な条件、機械判定に適さない意図・好みを含む課題を使う。個別に「lint化する」と指示せず、通常の依頼から候補を発見できるか、不要な検査を増やさないか、具体的な証拠で方法を選べるかを確認する。試行・独立評価と、指示の採用は未実施である。

## 安全性・性能・実アプリ検証の候補

| 候補 | 既存方針に対する追加価値 | 取り入れる場所と条件 |
| --- | --- | --- |
| 安全性を支える前提を確かめる | 呼出し元・共有型の確認だけでは見えない、依存ライブラリ、非同期順序、保存形式、別言語の利用者まで調べる方法が具体的 | implementのレビュー観点。変更の安全性が未検証の外部契約や暗黙の前提に依存するときに使う |
| 性能数値が何を測ったか確かめる | 計時範囲、遅延実行、誤りや処理省略、比較相手の条件、測定ノイズを確認する手順が具体的 | scopingの実験・性能調査の参照。数値によって採否や優先度が変わるときに使う |
| 実アプリの検証手順を一度通す | 起動できるだけでなく、正しい実体への接続、利用操作、観測、証拠保持、後片付けまで揃える | 対象repoの既存検証文書・ハーネス。現在の手順で実アプリの要求を再現できないときに整備する |

### 1. 変更の安全性を支える前提の検証

[blast-radius](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/blast-radius/SKILL.md)は、変更が安全だという説明を支える少数の重要な事実を特定し、その事実を検証する。検索で直接見つかる呼出し元に加え、必要な範囲で次を辿る。

- 導入版ライブラリの実装とローカルpatch。
- ライフサイクルと非同期処理の順序。
- JSON・DB・wire形式。
- 別言語やfeature flagを介した利用。

価値があるのは、確認対象と証拠を結び付ける方法である。「そう動くはず」という説明、該当する実装、問題経路を除いた変更では、証拠の性格が違う。さらに、実コードを使う再現と実アプリの観測を区別する。現行レビューにも依存先・状態遷移・異常系の確認はあるため、新しい全件ゲートの追加は不要である。

例えば、中断後の完了通知は届かないという前提で通知を無視する処理を削除するなら、導入版の中断と通知の契約を確認する。必要なら、中断前後の順序を変えた小さな再現を実コードで実行する。単回の通知なしで、すべての順序を保証したとは扱わない。

取り入れる文面の核は「変更の安全性が未確認の前提に依存する場合、対象版と成立条件を特定し、その前提を確かめる最小の証拠を取得する」でよい。既存の型・テストで前提が保証される変更に、新しい調査や報告を要求しない。

試行するなら、外部契約の誤認がある課題と、既存契約で安全性を確認できる正常対照を用意する。見落とし、誤指摘、必要な追加確認、時間・使用量を既存レビューと比較する。文章にこの観点が出たことだけでは改善成功としない。

### 2. 性能測定の妥当性確認

[benchmark-checklist](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/benchmark-checklist/SKILL.md)と[explain-the-number](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/principle-explain-the-number/SKILL.md)は、速い数値を出すことより、数値の意味を確かめる手順として有用である。

追加候補は次の五点である。

1. 計時範囲に、必要な処理と完了待ちが含まれるか。遅延iterator、Promise、未使用結果などで処理を測っていない可能性を確認する。
2. 正しさと処理量が同じか。エラー、結果欠落、処理省略による見かけの高速化を除く。
3. 比較条件が妥当か。版、設定、warm/cold、cache、batch、負荷、比較相手の調整を記録する。
4. 差が測定ノイズを超えるか。実行順を偏らせず、ばらつきと失敗を残す。profilingによる観測は性能比較の計時と区別する。
5. 改善が全体の時間へどれだけ効くか。実際の律速箇所、改善対象の占める割合、利用場面での影響を説明する。

現行の比較方針は版・入力・環境、未完了、親子を含む費用、少数試行からの一般化を扱う。今回の追加価値は、性能測定自体の誤りを発見する具体例にある。pstackの反復数を全実験へ固定したり、すべてのモデル比較でprofilerを必須にしたりする必要はない。

最小試行には、完了待ちを計時外へ出した測定と、正しく完了まで測る対照が使える。採用判断では、誤った速度改善を棄却できるか、妥当な測定に不要なやり直しを要求しないかを見る。すでに保存した入力と実行記録で判断できる場合は再実行しない。

### 3. 実アプリの検証手順の整備

[create-verification-skill](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/create-verification-skill/SKILL.md)と[maintain-verification-skill](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/maintain-verification-skill/SKILL.md)は、実行検証を再現できる手順へ落とす方法が具体的である。

検証手順を、起動、実行環境の健全性確認、利用操作、証拠保存、後片付けの五つに分ける。正しいprocess・build・port・認証・データへ接続していることを確認し、検証用profileやデータを分離する。操作前の条件、操作入口、期待する最終状態を機能ごとに対応付ける。証拠を残し、今回起動したprocessだけを片付ける。

新しく書いた手順は、少なくとも一つの機能で最初から最後まで実行してから渡す。保守時は、文書のずれ、検証ハーネスの不足、プロダクト不具合を区別する。検証が通るようにプロダクト不具合を無断で直し、元の失敗を消してはならない。

dotagentsには対象repoのsetup・check・CI・captureと補助検証を渡す仕組みがある。受け皿はその既存入口であり、共通のCursor用スキルを新設する必要はない。GUI、CLI、shortcutなど複数の入口が要求に関係する場合は、どれを確認したかを明示する。毎回すべての入口や全機能を走査するという意味ではない。

最初の試行は、実行検証の入口が不足している対象repoの一機能に限定する。再起動しても同じ手順で確認できるか、別instanceへの誤接続を見分けられるか、証拠保持と後片付けが実際にできるかを見る。全repo向けの日次監査や自動化の新設は、この候補に含めない。

## 条件付きで有用な補助候補

| 出典 | 使える部分 | 現行との差と適用条件 |
| --- | --- | --- |
| [architect](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/architect/SKILL.md) | 呼出し側の利用例を先に書き、必要な型・責任・公開境界を比較する | 現行の保守性レビューを具体化できる。変更費用が大きいAPI境界に限定し、関数変更のたびに二案と複数モデルを必須にしない |
| [why](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/why/SKILL.md) | 当時の明示的な理由、根拠のある推論、推測、理由不明を分ける | 現行の出典・事実と推論の区別に沿う。防御処理や過去の設計理由を見直すときに、もっともらしい理由を過去の事実へ置換しない。毎回あらゆる外部情報源を探す必要はない |
| [attack-the-premise](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/principle-attack-the-premise/SKILL.md) | 同じ前提で失敗が続くとき、前提と反証条件を明示して観測する | 現行にも修正が停滞した理由の再評価はある。担当ごとの偏りや割当ての非対称性を観測する具体例が有用。失敗二回だけで全課題に同じ調査を強制しない |
| [arena](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/arena/SKILL.md)・[swarm](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/swarm/SKILL.md) | 同じ課題の候補比較と、異なる範囲の分担調査を区別する | 独立評価を追加する前に、何を比較するか、何を分担するかを選べる。担当数やモデルの一致を正しさの証明にせず、未確認範囲と費用を残す |

これらも新しい必須スキルより、既存の設計・調査・レビュー参照への例の追加が適する。追加した指示が実際に判断を改善するかは未確認である。

## 既存方針との重複と、取り入れない指示

24個の原則は、主に以下のように評価した。表中は`principle-`を省略している。

| 原則 | 評価 |
| --- | --- |
| `laziness-protocol`、`subtract-before-you-add`、`minimize-reader-load`、`foundational-thinking`、`redesign-from-first-principles` | 追加前に不要な仕事・構造を減らし、保守費用で判断する方針は既存と重なる。標語を増やすより適用例が必要 |
| `model-the-domain`、`type-system-discipline`、`boundary-discipline`、`migrate-callers-then-delete-legacy-apis` | 型・責任・境界・移行先の一本化は既存と重なる。内部だから無条件に信頼することや、外部利用者・互換性条件を調べず旧APIを消す指示は採用しない |
| `prove-it-works`、`test-behavior-not-implementation`、`fix-root-causes`、`experience-first` | 実行証拠、振る舞い、原因、利用場面の重視は既存と重なる。否定的なassertionを形だけで不適切とせず、副作用禁止などの要求に対する検出力で判断する。必要な防御処理を一律に除かない |
| `outcome-oriented-execution`、`sequence-verifiable-units`、`separate-before-serializing-shared-state`、`make-operations-idempotent` | 完了条件、検証可能な単位、隔離、重複処理への耐性は有用だが既存の受け皿がある。旧runの変換や再開へ拡張せず、対象の契約に応じて使う |
| `encode-lessons-in-structure`、`build-the-lever`、`guard-the-context-window`、`never-block-on-the-human`、`exhaust-the-design-space` | 型・lintへの定着、再利用、必要な参照、人待ちに依存しない作業は既存と重なる。すべての単発仕事をツール化せず、要求・権限の判断待ちを独断で解消しない。委譲や複数設計を全件必須にしない |
| `attack-the-premise`、`explain-the-number` | 停滞時の反証と性能測定の具体例を条件付きで検討する。前節の候補に含めた |

作業スキルの全体も、必要性と運用費用で選ぶ。

| 作業スキル群 | 評価 |
| --- | --- |
| `poteto-mode`、`poteto-help`、`setup-pstack` | 入口から適切な参照へ振り分ける構造は参考になる。カタログ、Cursor固有の設定、モデルの既定値は移植しない |
| `how`、`why`、`teach`、`bro` | 動作・理由・説明方法を分ける。`why`の根拠区分が有用。他は現行の調査・説明へ統合できる |
| `recall`、`ketchup`、`show-me-your-work` | 調査履歴や判断を辿る考え方は有用。ただし会話履歴や新しいTSV台帳を正本にせず、既存のIssue・文書・対象版・実行記録を使う |
| `architect`、`arena`、`swarm`、`interrogate` | 設計比較と分担の方法を選択的に利用する。複数モデルの合意や指摘数の少なさを正しさの保証にしない |
| `blast-radius`、`benchmark-checklist`、`create-verification-skill`、`maintain-verification-skill` | 優先候補。適用条件と既存入口を限定する |
| `tdd`、`typescript-best-practices` | 再現、公開契約、型による表現は既存と重なる。すべての変更に新しいテストを要求しない |
| `correct`、`reflect`、`automate-me`、`figure-it-out` | 繰り返す問題を構造へ反映する発想は既存と重なる。修正依頼の範囲を越える規則追加、外部ticket作成、自動化は別の判断が必要 |
| `no-comments`、`unslop`、`technical-writing` | 不要な説明や冗長表現の整理は参考になる。必要な不変条件・順序・制約の理由まで消す既定方針は採用しない。日本語確認は既存のnatural-japaneseと文書lintを使う |
| `make-bot-ui` | 外部連携とCursor固有の操作口を新設する用途。今回の目的に必要な機能ではない |

特に[no-comments](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/no-comments/SKILL.md)は、名前・型・構造へ理由を移せるかという問いには価値がある。しかし、移せていない不変条件や順序の理由を削除すれば、読み手が必要な情報を失う。コメント数の削減を成功指標にはしない。

## 23個のplaybookから使える部分と衝突

| playbook | 評価 |
| --- | --- |
| `investigation`、`bug-fix`、`feature`、`refactoring` | 調査と変更を区別し、仮説・再現・振る舞い・既存利用者を確認する点は既存と重なる。非自明な変更の委譲や設計競争の常時必須化は採用しない |
| `prototype` | 方針を変える不明点だけを隔離した試作で観測する考え方は、scopingの既存方針に沿う。試作の成功を要求の合意や本実装の完了にしない |
| `perf-issue`、`hillclimb` | 実際の負荷、測定が差を検出できること、一度に一仮説、悪化時の撤回が有用。固定の改善率・試行回数を全課題へ要求しない |
| `runtime-forensics`、`trace-forensics` | 実行中の状態や固定traceを使う仮説検証が参考になる。「調査」であっても実行中の状態変更には対象と権限の確認が必要。traceだけで原因を確認済みにしない |
| `visual-parity` | 参照との差を具体的に測る用途には有用。pixel差ゼロと継続修正は、要求で完全一致が必要な場合に限定する |
| `eval` | 共通入力、評価者への候補名の隠蔽、根拠付き評価は参考になる。通常の要求・テスト・版の情報を消して公平さを演出しない |
| `opening-a-pr`、`babysit`、`shipping` | 衝突・指摘・CIの状態を区別する部分は参考になる。常にreadyでPRを作ることや自動マージは、draftから公開確認を経て人がマージする現行方針に反する |
| `orchestrate`、`autopilot-stack`、`autopilot-full`、`autonomous-run` | 多数の作業とstackを運営する専用基盤。現在の目的には過大で、権限・正本・マージ責任の再設計が必要。一般のPR手順は`gt`を要求しない一方、`orchestrate`とfrontier解決コードにはGraphite依存がある |
| `multi-phase-plan` | 大きな仕事で完了条件と検証を事前に結び付ける部分は有用。全PRでunit・live・perfと10個のlive担当を必須にする計画形式は、リスクに比例しない |
| `authoring-a-skill` | 再現例と成果物の確認を伴う指示作成は参考になる。既存のCodex用スキル作成手順を置き換える必要はない |
| `pause-safely`、`session-pickup`、`worktree-cleanup` | 対象と未完了を残す点は参考になる。WIPの自動commit、未追跡ファイルを捨ててよいとする分類、強制削除をそのまま移植しない |

出典は固定版の[playbooks一式](https://github.com/cursor/plugins/tree/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/poteto-mode/playbooks)である。計画検査の[check-plan.mjs](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/poteto-mode/scripts/check-plan.mjs)は、指定された見出し・項目・担当数の形式を確認する。形式の成功を、要求との適合や検証の十分性の証拠とは扱えない。

また、poteto-modeは可逆な仕事だけでなく、team chat、ticket更新、eval起動などの外部操作も、確認なしで進める既定方針を置く。現行では要求の範囲と操作の許可を確認し、外部へのメッセージ送信には明示的な指示が必要である。この権限差は、文面の翻訳だけでは解消できない。

## PR監視コードで確認した適用限界

PR監視は単なるプロンプトではなく、[watch-pr/policy.ts](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/poteto-mode/scripts/watch-pr/policy.ts)、[github.ts](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/poteto-mode/scripts/watch-pr/github.ts)、[cli.ts](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/skills/poteto-mode/scripts/watch-pr/cli.ts)で状態を分類する。取得失敗とチェック結果を区別し、再試行や機械可読の出力を備える点は参考になる。

ただし、`ready`をdotagentsの公開・マージ判定と同じ意味では使えない。固定版の実際の`readSnapshot`と`classifyPr`へ、上流のfixture helperで次の入力を渡した。PRはopen・非draft、チェックは成功、未解決threadと競合はなし、headのrollupは`SUCCESS`である。承認判定を`REVIEW_REQUIRED`にして、マージ状態だけを変えた。

| 模擬入力のマージ状態 | 承認判定 | 実コードの分類結果 |
| --- | --- | --- |
| `CLEAN` | `REVIEW_REQUIRED` | `ready` |
| `BLOCKED` | `REVIEW_REQUIRED` | `ready` |
| `UNKNOWN` | `REVIEW_REQUIRED` | `ready` |

これはローカルで`bun`から実行した結果であり、GitHubへの書込みや実PRの操作はない。模擬データでこの分類を再現したことを示す。実際のGitHubが各組合せを返す頻度や、上流の運用事故は確認していない。

再現方法は、固定commitから取得した`pstack`と同じディレクトリへ、以下を置いて`bun`で実行する。実コードの読込みと模擬入力だけであり、上流CLIのbootstrapは実行しない。

```ts
import { readSnapshot, classifyPr } from './pstack/skills/poteto-mode/scripts/watch-pr/policy.ts';
import { fakeReader, passingCheck } from './pstack/skills/poteto-mode/scripts/watch-pr/fakes.test-helper.ts';
import { parsePrNumber } from './pstack/skills/poteto-mode/scripts/watch-pr/types.ts';

const context = { owner: 'fixture', repo: 'fixture', number: parsePrNumber(1) };
for (const mergeStateStatus of ['CLEAN', 'BLOCKED', 'UNKNOWN'] as const) {
  const reader = fakeReader({
    facts: { mergeStateStatus, reviewDecision: 'REVIEW_REQUIRED' },
    fastPath: { kind: 'checks', checks: [passingCheck()] },
    commitRollups: [{ oid: 'head', state: 'SUCCESS' }],
  });
  const snapshot = await readSnapshot({ reader, context, pendingHistory: 'include', allowDraft: false });
  console.log({ mergeStateStatus, decision: classifyPr(snapshot).kind });
}
```

静的なコード確認でも、次の差がある。

- 必須チェック名の設定を持たず、取得できたチェックから状態を判断する。チェックが空の場合は成功扱いしないが、期待する必須チェックの欠落を同じ方法で検出する仕組みではない。`SKIPPED`・`NEUTRAL`も必須名と照合して拒否する判定ではない。
- `REVIEW_REQUIRED`を待機理由にせず、`CHANGES_REQUESTED`などを扱う。人の承認を待つ必要があるかは、呼出し側の別判断になる。
- review thread取得は`first: 100`で、thread一覧の続きの取得を確認できない。取得範囲外も含め、未解決threadがないことの保証には使えない。
- `--status-only`は状態表示で正常終了する。終了値0だけを`READY`の意味で扱えない。既定のtimeoutは0で、有限時間で終了する設定ではない。

現行の[CI判定コード](../../scripts/implement/ci.ts)は、設定した必須名、各結果、PR・head・base・draftなどを対象版と照合する。pstackのwatcherをその代わりに採用する理由はない。一方で、現行の通常開発にも修正・レビューの回数と累計モデル時間の上限設定はないため、「こちらは全ループが有限」という比較は成立しない。観測用のreview-probeや制御テストの制限とは区別する。

## Bennyは別用途として評価する

[Bennyの入口](https://github.com/cursor/plugins/blob/11713c683fe4add4fd403ea880580abbc9e0875f/pstack/automations/benny/FOR_AGENTS.md)と主要手順は、通常のpstackスキル群から分けて評価した。manifestの登録先はskillsとagentsであり、Benny一式がそれだけで自動的に動く構成ではない。

Bennyには、バグ受付の将来設計に参考になる点がある。

- 投稿前にchannelと元threadを再確認し、出典permalinkで重複を判定する。
- 原因に即して担当先を判断し、既存の修正・作業中の担当・同じ報告を確認してからticketを作る。
- 信頼する投稿者と元threadに結び付いたmarkerを使い、任意の本文だけで運用状態を変えない。
- 既存修正がある場合は新しい修正を競合させず、元の症状と修正後の期待状態を確認する。
- 再現できないこと、能力や環境が足りないこと、修正効果を確認できないことを分ける。修正はdraftに留め、マージとdeployを行わない。
- 外部投稿は担当を限定し、workerに投稿用の権限を与えない運用を要求する。

この部分はpoteto-modeの広い自律権限とは性格が違う。ただし、指示が書かれているだけで権限が隔離されたとは証明できない。実際のtokenとtoolの配布、再試行や同時実行時の重複防止、途中失敗時の外部状態を別途設計する必要がある。二回再現できたことも、flakyでないことの一般保証にはならない。

現行の目的は人と進める要求整理・実装であり、Slackからの無人バグ受付は含まれない。Bennyは将来の受付設計の参照に留め、今回のスキル追加や自動化起動には含めない。

## 採用へ進む場合の順序と判断条件

最初は、機械で守る方法をAI自身が調べる入口を既存の実装・レビューに接続する案を具体化する。未保証の条件、既存検査で十分な条件、機械判定に適さない意図・好みを含む課題で、候補発見と方法選択を分けて評価する。安全性の前提、設計理由、修正停滞、利用側の設計例の候補は、必要な判断に応じて使う。性能測定と実アプリ検証は対象repoの課題が発生した際に試し、候補比較や分担調査は追加費用に見合う場合だけ選ぶ。

進める場合は、既存のscopingで適用対象、追加しない仕事、比較条件、完了条件を合意する。採用案は最小の文面か検証手順に落とし、既存と候補を同じ入力・環境で比較する。真の指摘、誤指摘、見落とし、未確認、手戻り、親子を含む時間・使用量を分けて判断する。保存記録で十分な比較と、新しいモデル実行が必要な比較を区別する。

採用前には独立評価を行い、要求・原資料・観測結果・文面の意味を照合する。今回の研究報告はその独立評価や実モデル試行をまだ受けていない。優先順位は内容の比較からの提案であり、効果を実証した順位ではない。

現時点で根拠があるのは、pstackの具体的な手順に追加候補があり、既存と重なる指示や運用上の衝突も多いこと、PR監視の分類が現行の公開判定を代替しないことである。実装・モデル性能・費用の改善率は、この調査からは判断できない。

## 2026-10-11の文書確認

日本語確認には、既存方針で固定したnatural-japaneseのcommit `9a78a42964096da509b8f3e011f0085a5f080151`のクイック手順を使った。`uv run`はキャッシュへの書込み制限で失敗したため、取得済みのPython環境から同じスクリプトを同じ引数で実行した。指摘を読み、長い説明を分割し、確認先の列挙を箇条書きにした。用語の反復、体言止めの欠如、短い列挙の指摘は、技術用語・条件の明確さと文章の役割を優先して維持した。機械検査の終了値を意味の一致や独立評価の代わりにはしていない。

`bun run lint:docs -- docs/research/pstack-adoption-review-20261011.md`で文書の静的lintを確認した。報告内のローカルリンクに欠落はない。

`bun run check`はlint・format・complexity・typecheckを通過したが、`check:unused`で停止した。既存の`output/`配下の試行資料を含む748件の未使用判定と、同じ領域の構文不正fixtureに対する解析警告が出た。今回の研究文書とは別の既存資料であり、削除や設定変更は行っていない。共通check全体の成功とは報告しない。

未実行だった制御テストは個別に実行した。既定の`bun run test:control`が`output/`内の複製テストも拾うことを確認して中断し、`bun scripts/tests/runner.ts bun ./scripts/tests`で現行ディレクトリに限定した。Bun `1.4.3`で510件中506件成功、4件失敗、実行時間171.47秒だった。失敗は`review-probe.test.ts`の4件で、ディレクトリ読込みの`EISDIR`と、後続の`preflight.json`の欠落がログに出た。根本原因の修正は実施していない。模擬コマンドの制御テストであり、実モデルや実際のGitHub公開の検証ではない。

## 2026-10-12の追補確認

追補は既存方針とコード規則の限定試行を照合し、調査の入口と、機械化を選ぶ条件・見送る条件を案として記した。現行スキル、検証定義、実行コードは変更していない。固定版natural-japaneseのクイック手順で確認し、専門用語の反復と短い列挙などの情報指摘は意味の明確さを優先して維持した。文書の静的lintは終了0だった。独立評価と実モデルによる自発的な発見の試行は未実施である。

`bun run check`はlint・format・complexity・typecheckを通過し、`check:unused`で停止した。既存の`output/`配下を含む未使用判定は818件で、同領域の構文不正fixtureによる解析警告も残った。制御テストには到達していない。2026-10-11の実行結果と区別し、既存資料の削除や無関係な修正は行っていない。

## 2026-10-13の整理と確認

導入候補を八つにまとめ、共通の入口と課題ごとに使う方法を区別した。既存との差と適用条件を添えた提案であり、現行スキルや実行コードは変更していない。採用効果の比較と独立評価は未実施である。

固定版natural-japaneseのクイック手順で新しい列挙文を分割し、専門用語の反復と短い列挙は意味の明確さを優先した。文書の静的lintは終了0だった。`bun run check`はlint・format・complexity・typecheckを通過したが、`check:unused`で停止した。既存の`output/`配下を含む未使用判定は1245件で、同領域の構文不正fixtureによる解析警告も残った。制御テストには到達していない。既存資料の削除や検査設定の変更は行っていない。
