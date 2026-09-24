# pstackとCodex移植版から取り入れる候補

2026-09-19確認。比較後、依頼者は候補AとBを別Issueにする案を選択した。ハーネスの実装・設定・スキルは変更していない。

## 判断

最初の採用候補は、実モデル評価から正誤のラベルを隠すことと、scopingで観測可能な不明点を小さな実験で解消する条件を具体化すること。この2点なら既存の実行経路と人の判断を保ち、専用スキルや必須工程を増やさず取り込める。

商品ごとの操作・検証手順も参考になる。ただし共通ハーネスには商品がなく、既存のcheck・captureとの重複を避けるには対象商品を選ぶ必要がある。今回の初回採用案には含めない。

これはソースと手順の比較に基づく提案。pstackの実行品質がdotagentsより高いことや、採用による時間・費用・検出率の改善は測定していない。

## 比較対象と方法

- dotagents: [0fafcb816b5ab34559f551d1fc0fefd121a0f17b](https://github.com/thkt/dotagents/tree/0fafcb816b5ab34559f551d1fc0fefd121a0f17b)。現在のscoping・implement、開発方針、制御CLI、修正・独立評価、実モデル評価のコードを確認した。関連する追跡ファイルにHEADとの差分はなかった。
- pstack-codex: [594acccc740b2bfab7b83a37bf2ffde40dfec050](https://github.com/ScriptedAlchemy/pstack-codex/tree/594acccc740b2bfab7b83a37bf2ffde40dfec050)。公開repoを一時領域に取得し、中心スキル、関連playbook、実行契約、検証手順、PR監視・実行記録の補助コードを確認した。インストールや外部連携の起動はしていない。
- 比較軸は要求への適合、既存機能との差、モデル呼出し・実行・保守の追加負担、適用条件、検証可能性。記述量やスキル数を品質の代理にしない。
- 未完了Issueの番号・タイトルと、全状態の関連語検索を確認し、既存の#66・#83の本文を照合した。今回の優先候補と同じ要求の既存Issueは見つからなかった。本文の網羅調査ではない。人への判断経路は#133・#134、レビュー記録の整理は#126・#130に近いため、別の改善として広げない。
- 作業中にmainが`61e1c8ec7e874b66c4922b7cd59e5118beba6efc`へ進み、#133がclosedになった。差分を確認し、候補Aの正誤ラベルとレビュー入力、候補Bのscopingの判断に影響がないことを照合した。

## 差分と採否

| 観点 | pstackの具体策 | dotagentsの現状 | 判断 |
| --- | --- | --- | --- |
| 実モデル評価の偏り | 評価対象から実験の正解・比較条件を隠し、出力と記録で判定する | 正常・不具合入りの独立した再現確認はあるが、レビュアーへ渡るパスに`correct` / `defective`がある | 優先候補A。評価入力の正誤ラベルを除く |
| 設計前の不明点 | 意思決定を先に定め、本番コードと分離した小さな試作で観測する | 調査・十分性判断・人への確認はある。過去の下書きに試作の実例もあるが、共通手順は実験を選ぶ条件を具体化していない | 優先候補B。既存scoping参照内で適用条件を補う |
| 利用者の操作による検証 | 起動・健康確認・操作・証拠・後片付けと、機能ごとの到達手順を用意する | repo別check・captureと対象照合がある。商品側の操作手順は各repoの責任 | 商品を選んで検討。共通の検証台帳や全機能巡回は追加しない |
| 失敗が続くときの前提の見直し | 同じ前提の修正が繰り返し失敗したら前提と分布を調べる | 修正時の根本原因調査、過去指摘の再評価、共有知識との矛盾調査、同じ調査が進まないときの相談がある | 現時点で追加しない。別ゲートを足す根拠はない |
| 指摘の取捨選択 | 実行経路と文脈を確認し、好みや仮定だけの指摘を除く | defect/concern、required、根拠、not_applicableの理由、呼出元・呼出先の確認がある | 既存と重複。pstackの指摘数の目安も採用しない |
| 複数モデルのレビュー | 同一promptと基準を複数モデルへ渡して統合する | Astraによる独立評価、対象版の拘束、指摘の継続評価、ホストによる受入計算がある | 保留。追加検出・誤指摘・時間・使用量の比較なしに常設しない |
| 作業分割・長期運用 | worktree、台帳、PR監視、定期実行、複数PRの進行管理 | Issue単位の隔離・検証・公開確認・予算・中断・停止後の照合がある | 初回候補から除く。多PRの自動進行という追加要求がない |
| 自律実行とマージ | 自動でマージまで進めるplaybookや外部操作の広い既定方針がある | 人が要求・権限・承認・マージを判断する | 現方針に適合しない部分は採用しない |

pstackにも状態保存・lock・PR判定の実コードがあるため、「すべてプロンプトだけ」とは分類しない。双方で扱う対象範囲が異なり、今回は全体の安全性・速度の優劣を認定しない。

## 優先候補A: 実モデル評価の正誤ラベルを隠す

### 確認した事実

pstackの[Eval](https://github.com/ScriptedAlchemy/pstack-codex/blob/594acccc740b2bfab7b83a37bf2ffde40dfec050/plugins/pstack/skills/poteto-mode/playbooks/eval.md)は、評価対象に比較のメタ情報を知らせず、評価者にもモデル名を隠す手順を示している。

dotagentsの[verify-review.ts](https://github.com/thkt/dotagents/blob/0fafcb816b5ab34559f551d1fc0fefd121a0f17b/scripts/verify-review.ts#L79)は、`broken`に応じて`defective` / `correct`というディレクトリを作り、その配下をcwd・記録先にする。[correction.ts](https://github.com/thkt/dotagents/blob/0fafcb816b5ab34559f551d1fc0fefd121a0f17b/scripts/correction.ts#L562)は、その絶対パスを含むtargetRecord・diff・additionsの参照をレビューpromptに入れる。正誤ラベルが通常の入力経路に含まれることはコードから確認できる。

独立した再現コードをレビュー終了後に作る点、各指摘を別に裁定する点、少数の合成課題から一般的な検出率を主張しない点は既にある。残す。

ラベルが過去の回答を変えたかは未測定。過去の結果を誤りや無効と断定せず、非盲検条件という制約として記載する。

### 提案するIssueの範囲

仮題: **実モデルレビューの評価入力から正誤ラベルを除く**。

- 評価用checkout・記録先に正誤を表さない識別子を使い、正解との対応は評価対象へ渡す資料から分離する。実行順を識別子の正誤の意味として固定しない。
- cwd、prompt、target record、差分・追加ファイル、参照ログ、実行引数など、実際に渡る入力を確認する。ディレクトリ名だけを変えて完了にしない。
- 通常のIssue要求、コード、テスト、独立評価の基準は維持する。pstackの禁止語一覧を一般のレビューに導入しない。実際の`test`や`review`という名称を一律に消す必要はない。
- 正誤の対応と再現による裁定はホストが保持する。レビュー後に実入力・期待値・実結果で既知の不具合と各指摘を判定する現行手順を残す。
- 対象は実モデル評価用の入口と関連説明。通常のレビューのモデル数、schema、公開処理、予算、停止条件を変えない。

### 完了条件と検証案

1. 実モデルを呼ばない隔離試行で、モデルに渡る実際の引数・prompt・参照資料を捕捉し、正誤を示すメタ情報が既定入力に混ざらないことと、ホスト側では両ケースを再現・裁定できることを確認する。単なるソース文字列の一致を検証にしない。
2. 通常の要求・レビュー基準・対象版の記録を保ち、`bun run check`と既存の独立評価を通す。
3. 正常・不具合入りを各1回、既存の実モデル確認手順で実行する案とする。指摘、裁定、未確認、使用量を記録し、成功応答だけで精度改善とは主張しない。これは追加の性能ベンチマークや複数モデル比較ではない。
4. 説明には、偶発的な正誤の手掛かりを減らす範囲と、モデルによる意図的な周辺ファイル探索まで防ぐセキュリティ境界ではないことを記す。

追加費用は評価用入口の局所変更、入力経路の確認、既存規模の実モデル試行。通常の開発フローへのモデル呼出し追加はない。試行の実施はIssueの合意範囲に含めて決める。

## 優先候補B: scopingの実験を選ぶ条件を具体化する

### 確認した事実

pstackの[Prototype](https://github.com/ScriptedAlchemy/pstack-codex/blob/594acccc740b2bfab7b83a37bf2ffde40dfec050/plugins/pstack/skills/poteto-mode/playbooks/prototype.md)は、先に判断対象を決め、隔離した試作で画面・出力・時間等を観測し、判断と根拠を本実装へ渡す。

こちらの[十分性の判断](https://github.com/thkt/dotagents/blob/0fafcb816b5ab34559f551d1fc0fefd121a0f17b/skills/scoping/references/sufficiency.md)には、目的・根拠・制約と代替案・不確実さ・整合・権限の確認がある。調査・実験ができない仕組みではない。今回確認したローカル下書きにも隔離した試作の例があるため、すでに実践する判断を短い条件として共有する提案とする。

### 提案するIssueの範囲

仮題: **scopingで観測可能な不明点を小さな実験へつなぐ**。

- 既存の十分性判断の中で、文書やコードでは判断がつかず、観測結果が方針を変える不明点に限り、小さな実験を選ぶ。
- 「決めること」「結果を区別できる観測」「観測の限界」を先に明らかにし、本番コードから分離した最小の試作・再現を使う。答えが出た時点で止め、実験自体の網羅性を目的にしない。
- 事実として確かめられることと、人が決める目的・許容範囲・権限を区別する。観測可能でも本番への書込みや未許可の外部操作が必要なら、その権限を推定しない。
- 結論と判断に必要な証拠を既存のIssue下書き・必要なresearchへ残す。試作を実装成果物や合意済みの仕様と扱わない。
- 新しいskill、実験用runtime、必須の比較案数、専用台帳、追加ゲートは作らず、重複する説明は既存の記載へ統合する。

### 完了条件と検証案

既存の[scoping手順確認](https://github.com/thkt/dotagents/blob/0fafcb816b5ab34559f551d1fc0fefd121a0f17b/scripts/README.md#scopingの切替と手順確認)で、事実不足なら小さな観測へ進み、目的・権限の未確定なら人へ戻ることを確認する。既存資料で足りる例で無用の実験を始めないこと、試作の結果を本実装の完了にしないことも見る。スキルの文字列一致テストは追加せず、`bun run check`、既存の独立評価、代表的な会話上の判断で確認する。

この候補の効果は、観測できることをユーザーへ質問する回数や、根拠なしに選んだ方針の手戻りを減らせるかで判断する。改善量は未測定であり、一般的な原則を増やすだけなら採用しない。

## 後続候補: 商品側の操作・検証手順

pstackの[create-verification-skill](https://github.com/ScriptedAlchemy/pstack-codex/blob/594acccc740b2bfab7b83a37bf2ffde40dfec050/plugins/pstack/skills/create-verification-skill/SKILL.md)から参考になるのは、起動・準備完了・利用者の入口・操作後の副作用・所有するプロセスの終了・証拠の保存を具体化し、作った手順を一度通すこと。

こちらには[ホストによる検証と撮影](https://github.com/thkt/dotagents/blob/0fafcb816b5ab34559f551d1fc0fefd121a0f17b/scripts/README.md#ホストによるブラウザー検証と撮影)があり、[repair.ts](https://github.com/thkt/dotagents/blob/0fafcb816b5ab34559f551d1fc0fefd121a0f17b/scripts/repair.ts#L33)は実装担当のsandbox内でのブラウザー・サーバー起動を禁じている。pstackの「担当者が直接アプリを動かす」をそのまま移植せず、操作と期待結果を商品側の既存spec・手順へつなぎ、実行はホストが担当する必要がある。

対象商品を選んだ後、よく使う1操作で既存の手順を試し、欠落があればその正本を修正する。操作手順を探す時間や再現の漏れが実際にあるかを確認してから範囲を決める。今回、特定商品の欠落や改善量は未調査。

## 現行の方針と重複する部分

- [レビュー指示・受入計算](https://github.com/thkt/dotagents/blob/0fafcb816b5ab34559f551d1fc0fefd121a0f17b/scripts/review.ts)は、現在の呼出経路、具体的な根拠、過去指摘の全件更新、必須の未解決指摘からの状態計算を既に持つ。多数決やリード役の印象へ置き換えない。
- [修正ループ](https://github.com/thkt/dotagents/blob/0fafcb816b5ab34559f551d1fc0fefd121a0f17b/scripts/correction.ts#L616)は、根本原因の修正と必要な対象検証を指示し、要求・権限・上限の変更を人へ戻す。[scoping](https://github.com/thkt/dotagents/blob/0fafcb816b5ab34559f551d1fc0fefd121a0f17b/skills/scoping/SKILL.md)にも新しい根拠が得られないときの相談がある。pstackの[Attack the Premise](https://github.com/ScriptedAlchemy/pstack-codex/blob/594acccc740b2bfab7b83a37bf2ffde40dfec050/plugins/pstack/skills/principle-attack-the-premise/SKILL.md)が要求するactor別の偏り調査は特定の問題向けで、全障害に固定適用する理由はない。
- pstackの[実行契約](https://github.com/ScriptedAlchemy/pstack-codex/blob/594acccc740b2bfab7b83a37bf2ffde40dfec050/plugins/pstack/CODEX.md)と[連携の検証記録](https://github.com/ScriptedAlchemy/pstack-codex/blob/594acccc740b2bfab7b83a37bf2ffde40dfec050/INTEGRATION-TESTS.md)は、保存済み設定と実際の実行成功を区別している。これは現在のdotagentsにもある区別であり、仕組みを追加する理由ではない。

## 本家cursor/plugins/pstackの追加確認

2026-09-19、依頼者の追加依頼に基づき[本家pstack](https://github.com/cursor/plugins/tree/032be146865d973682535de75f2287da438550bf/pstack)も取得・確認した。比較時のmonorepo HEADは`032be146865d973682535de75f2287da438550bf`、pstackのversionは`0.15.2`。

### 移植元との差分

Codex移植版の[UPSTREAM.json](https://github.com/ScriptedAlchemy/pstack-codex/blob/594acccc740b2bfab7b83a37bf2ffde40dfec050/UPSTREAM.json)が示す移植元は`e31650eea443aaea1e84cc15d88c13f40080b275`。このcommitと現在の本家HEADをGitで比較すると、`pstack/`に差分はなかった。両方の同ディレクトリのtree IDは`f235052692fba08f7ff40df62775339cb4794c4c`で一致する。monorepo全体のHEADの違いをpstackの更新とは扱わない。

本家とCodex版はともに`skills/*/SKILL.md`が47件、playbookが23件。数の一致だけで移植品質を保証するものではないため、採用済み2候補と周辺の本文差分を確認した。

- [本家Eval](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/poteto-mode/playbooks/eval.md): 正解や比較のメタ情報を隠す方針は共通。本家の異なるモデル「系統」という評価者指定がCodex版では異なる利用可能モデルに変わり、履歴の参照方法も環境に合わせている。#138は既存の評価入口から正誤ラベルを除く範囲なので、多モデル化へ広げる理由にはならない。
- [本家Prototype](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/poteto-mode/playbooks/prototype.md): 本文差分は画面操作・検証ツールの案内。判断を先に定め、隔離した小さな試作で観測する方針は共通で、#139の根拠を変えない。
- [本家poteto-mode](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/poteto-mode/SKILL.md): Cursorのmode/reminder、Task、モデル指定、control系スキル、loopなどがCodexの実行方法に置き換わっている。本家の指示をCodexでそのまま実行する前提にはしない。
- [本家create-verification-skill](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/create-verification-skill/SKILL.md): 保存先や呼出名の変更が中心で、前回整理した商品側の操作・検証手順の考え方は共通。

### 前回より詳しく確認した考え方

| 本家の具体策 | 取り入れる価値がある点 | 現行との関係と判断 |
| --- | --- | --- |
| [Blast radius](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/blast-radius/SKILL.md) | 呼出元一覧で終えず、安全性が依存する少数の事実を絞る。導入版のライブラリ、非同期の順序、保存・通信形式などを追い、可能なら実コードで確かめる | 現行reviewは呼出元・呼出先・状態遷移と必要な対象検証を既に扱う。「どの前提を実行で確認すべきか」の具体例として有用だが、今回の確認だけで追加ゲートや常時実行を要求しない |
| [Architect](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/architect/SKILL.md)と[design red flags](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/architect/references/design-red-flags.md) | 呼出側の使い方を先に書き、型・境界を導く。単なる転送、内部知識の漏れ、工程ごとの分割で同じ判断が散る形を見直す | 現行の冗長性評価と方向が合う。関数境界を越えるたびに複数モデルで設計する固定手順は追加費用が大きく、採用しない。具体的な設計変更で使う参考例に留める |
| [Encode Lessons in Structure](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/principle-encode-lessons-in-structure/SKILL.md) | 繰り返す注意を型・lint・共通処理・実行時検査で防げるなら、説明の追加を減らす | 型、ホストの検証、既存reviewという責任分担と合う。型や機械で判定できない要求・根拠の意味判断は残す。一度の失敗を全体ルールにしない |
| [Hillclimb](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/poteto-mode/playbooks/hillclimb.md) | 実際の負荷条件、結果を区別できる測定、回帰条件を揃え、一つの仮説ごとに前後を比べる | 性能改善を目的にした個別Issue向け。実測と推測を区別する現行方針の補助になる。通常のscopingへ固定回数・専用台帳・長期ループを加えない |
| [Reflect](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/reflect/SKILL.md)と[利用者向け説明](https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/docs/guide/09-make-it-yours.md) | 単発の出来事をルールにせず、将来の判断を変える学びだけを既存skillへ戻す | 人の合意と通常のIssue・PR経由で扱える。毎回3評価者と統合担当を起動する流れや別の学習台帳は不要 |

これらは本家にしかない新機能ではなく、Codex版にも含まれる考え方。本家確認を機に前回より詳しく読んだ追加観点として区別する。

結論は#138・#139の範囲を維持する。追加候補には、現在のフローで具体的に何を見逃したか、既存の手順をどう置き換えるか、追加費用に見合うかを示す材料がまだないため、新規Issueにはしていない。公開済みIssue本文の要求変更も行っていない。今回の追加確認はソース・Git差分と現行方針の照合であり、pstackの実モデル実行や実商品での効果測定、独立評価は未実施。

## 合意と検証の状態

比較・候補整理を経て、依頼者は「AとBを別Issueにする」を選択した。Aは[Issue #138](https://github.com/thkt/dotagents/issues/138)、Bは[Issue #139](https://github.com/thkt/dotagents/issues/139)として公開し、タイトル・全文・対象・作者・OPEN状態を読み戻して原稿と照合した。実装と実モデル試行はまだ行っていない。Issueの別評価者による独立評価は未実施で、執筆担当が出典・対象版・事実と提案の区別を照合した。これは採用済みコードやスキルの変更ではない。

要求と必要な根拠は各Issue本文と固定版の参照で足りるため、この比較メモは実装の必須入力にしない。本文はローカル保存のみで、commit・pushはしていない。商品側の検証手順は対象商品が決まってから扱う。
