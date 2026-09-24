# 用語と責任境界を既存の共有モデルで表す試行

確認日: 2026-09-20（JST）。対象版: `8a89f33a06dfa75406f1d56113435e9dcf868690`。状態: 隔離した表現・抽出の試行完了、通常フローへの追加は未採用。

## 結論

dotagentsの「独立評価の終了」と「公開本文の確認・ready・人の承認」の違いを、既存の共有モデル形式で表せた。新しいschema・属性・ツールは不要だった。同じ定義から人向け説明とAI入力を取り出す既存処理も利用できた。

ただし、この例はIssue #128で整理済みの責任境界で、現行コードと方針にも区別が残っている。今回、新たな不具合や不足を検出したわけではない。この試作品をそのまま正式追加すると、既存方針との二重管理が増える。取り違えや引き継ぎ時間の改善は未評価であり、正式追加や新規Issueの根拠にはまだ足りない。

## 選んだ実例と出典

[Domain-Driven Agents](https://coldtake.dev/blog/domain-driven-agents)の、用語の意味・所有者・接続境界を明示する考え方を参考にした。対象プロダクトの指定はなかったため、現在のdotagentsの実例を選んだ。複数repo間の業務モデルや両側の契約宣言を検証した試行ではない。

[Issue #128](https://github.com/thkt/dotagents/issues/128)には、完成PR本文の公開前の意味確認を担当者の責務に置きながら、通常CLIにはその介入点がないというずれが記録されている。今回の根拠はこの記録と現行コード・方針の読解であり、当時の障害を再実行したものではない。

- [現行方針](https://github.com/thkt/dotagents/blob/8a89f33a06dfa75406f1d56113435e9dcf868690/.codex/DEVELOPMENT.md#pr本文人向け文書の日本語確認): 公開後の担当AIが本文を確認し、人が承認・マージを判断する。
- [review.ts](https://github.com/thkt/dotagents/blob/8a89f33a06dfa75406f1d56113435e9dcf868690/scripts/review.ts#L221): AIの指摘と更新を使い、ホストがacceptedを算出する。
- [correction.ts](https://github.com/thkt/dotagents/blob/8a89f33a06dfa75406f1d56113435e9dcf868690/scripts/correction.ts#L600): acceptedを下位処理のready_for_human_reviewという終了理由へ変換する。
- [development.ts](https://github.com/thkt/dotagents/blob/8a89f33a06dfa75406f1d56113435e9dcf868690/scripts/development.ts#L754): CI成功時もpublished_draftとし、公開しない場合はverified_localとして後続作業を残す。

## 試作した区別

下記に統合した試作モデルは目的1件、概念3件、規則1件からなる。既存のstatement・scope・question・relationsに、意味、担当、同一視してはいけない語、受け渡し条件を記した。所有者を機械が照合する専用属性は追加していない。

| 言葉・状態 | 意味を定める処理・担当 | 同一視しないもの |
| --- | --- | --- |
| reviewのaccepted | AIが指摘を評価し、ホストが必須未解決指摘の有無から算出 | 公開本文確認済み、人の承認済み |
| correctionのready_for_human_review | 下位の検証・修正処理の終了理由 | GitHub PRのready |
| published_body_check | draft公開後の担当AIによる意味確認 | ホストの文字列一致確認、CI成功 |
| GitHub PRのready | 担当AIが既存条件を確認して切り替え、実状態を読戻す | 人の承認・マージ判断 |

JSON内のagreedは出典の合意済み規則、observedは今回読んだ実装を表す。この試作の採用合意ではない。モデルで明示する目的はproposedとし、用途別の入力試行では選択しなかった。

## 試作モデルの明細

旧JSONのschemaVersionは`1`。以下は試行時の表現を保存したもので、現在の知識モデルの正本ではない。

### 出典と当時の状態

| ID | 状態 | 対象版・確認時点 | この試作で使った範囲 |
| --- | --- | --- | --- |
| [`issue-128`](https://github.com/thkt/dotagents/issues/128) | `agreed` | 2026-09-20 JST取得、CLOSED | 過去の完成PR本文の確認時点・責任のずれと、draft公開後へ集約する採用理由。現在の状態は現行方針・コードで確認する。 |
| [`publication-policy`](https://github.com/thkt/dotagents/blob/8a89f33a06dfa75406f1d56113435e9dcf868690/.codex/DEVELOPMENT.md#pr本文人向け文書の日本語確認) | `agreed` | 8a89f33a06dfa75406f1d56113435e9dcf868690 | 担当AIの公開後確認、ready切替条件、人の承認・マージ判断。 |
| [`review-code`](https://github.com/thkt/dotagents/blob/8a89f33a06dfa75406f1d56113435e9dcf868690/scripts/review.ts#L221) | `observed` | 8a89f33a06dfa75406f1d56113435e9dcf868690 | AIの指摘と更新からホストがacceptedを算出する条件。 |
| [`correction-code`](https://github.com/thkt/dotagents/blob/8a89f33a06dfa75406f1d56113435e9dcf868690/scripts/correction.ts#L600) | `observed` | 8a89f33a06dfa75406f1d56113435e9dcf868690 | 独立評価がacceptedになったときの下位処理の終了理由。 |
| [`development-code`](https://github.com/thkt/dotagents/blob/8a89f33a06dfa75406f1d56113435e9dcf868690/scripts/development.ts#L754) | `observed` | 8a89f33a06dfa75406f1d56113435e9dcf868690 | published_draftとverified_local、および未完了作業の分離。 |

### 目的・概念・規則

#### `avoid-premature-completion`

分類: `teleology` / `purpose`。当時の状態: `proposed`。

担当AIと人が、独立評価の終了、公開本文の確認、PRのready、人の承認を区別し、確認していない段階を完了と報告しないようにする。

確認する問い: 一つの成功表示から、誰がまだ何を確認すべきかを読み取れるか。

適用範囲: この区別を共有モデルで表す提案。現在の公開・承認条件の変更ではない。

出典: `issue-128`、`publication-policy`。

関係:

- `review-and-correction`: 下位の成功の適用範囲を限定する
- `published-body-check`: 公開後の意味確認を別の責任として残す
- `ready-and-human-approval`: レビュー可能と承認を区別する

#### `review-and-correction`

分類: `ontology` / `concept`。当時の状態: `observed`。

reviewのacceptedは、AIの指摘と更新からホストが再構成した評価に、必須かつ未解決の指摘がないことを表す。correctionはこれをready_for_human_reviewという終了理由へ変換する。この語は下位処理の終了を表し、GitHub PRのreadyや、人による承認を表さない。

確認する問い: acceptedやready_for_human_reviewを、公開本文確認済み・承認済みという同義語として使っていないか。

適用範囲: 定義・算出の責任はreview.tsとcorrection.tsのホスト処理。指摘の意味判断は独立評価AI。上位フローでは対象再照合や公開処理が残る。公開しない実行はverified_localとなり、公開後の作業は未完了として残る。

出典: `review-code`、`correction-code`、`development-code`、`publication-policy`。

関係:

- `published-body-check`: 生成前の評価で公開後の本文確認を代替しない
- `ready-and-human-approval`: 下位のreadyをGitHubのreadyや人の承認へ読み替えない

#### `published-body-check`

分類: `ontology` / `concept`。当時の状態: `agreed`。

published_body_checkは、draft公開後に担当AIが実際の最新本文をIssue・対象commit・accepted評価・検証結果と意味の面で照合する責任を表す。必要な媒体は実表示も確認する。ホストによる本文文字列や対象の一致確認とは対象と担当が異なる。

確認する問い: 文字列一致、CLI終了、CI成功、生成前のacceptedだけで本文の意味を確認した扱いにしていないか。

適用範囲: 意味確認の担当は公開後の担当AI。機械照合はホスト。意味確認の完了を機械状態から自動推定する項目は、この試作では追加しない。

出典: `issue-128`、`publication-policy`。

関係:

- `review-and-correction`: 生成前の独立評価と対象・時点を分ける
- `ready-and-human-approval`: ready切替の前提の一つとなる

#### `ready-and-human-approval`

分類: `ontology` / `concept`。当時の状態: `agreed`。

GitHub PRのreadyはdraftからレビュー可能へ移す状態である。担当AIは本文・必要媒体と同じheadのCIを確認し、対象・根拠・主体・権限を再照合してから切り替え、実状態を読み戻す。readyへの切替は人の承認ではなく、承認・マージの判断は人が所有する。

確認する問い: 担当AIがreadyにしたことを、人が差分や要求を承認したことに置き換えていないか。

適用範囲: readyの実状態はGitHubから観測し、切替手順は現行方針に従う。人の要求・許容範囲・権限・マージ判断をモデル定義やAI評価で代替しない。

出典: `publication-policy`。

関係:

- `published-body-check`: 意味確認を満たしてから状態変更する
- `boundary-transition`: 未確認や対象変更時の戻り先を保つ

#### `boundary-transition`

分類: `nomology` / `rule`。当時の状態: `agreed`。

下位処理の成功を上位の完了へ変換するときは、未実施の責任を維持する。CIがpassedでもdevelopmentはpublished_draftとし、公開本文確認・ready切替・人のレビューを残す。未確認ならdraftを維持し、対象や根拠が変われば関係する確認へ戻る。

確認する問い: 上流の成功を渡す際に、後続の未確認事項や担当が失われていないか。

適用範囲: 既存の結果と残作業の意味を表す。新しい遷移、権限、自動承認、モデルによる停止条件の変更を追加しない。

出典: `development-code`、`publication-policy`。

関係:

- `review-and-correction`: 下位成功の意味を限定したまま渡す
- `published-body-check`: 後続の担当と根拠を残す
- `ready-and-human-approval`: 外部状態の変更と人の判断を分ける
## 実施した確認

一時ディレクトリのJSONに対し、既存の`scripts/knowledge.ts`の公開関数を直接呼び出した。通常の実装run、モデル呼出し、GitHubへの書込みは行っていない。

| 確認 | 結果 |
| --- | --- |
| 既存形式で読み込めるか | parseKnowledgeが5件を受理した |
| 同じJSONから説明を生成・照合できるか | generateKnowledgeの生成とcheckが成功した |
| 必要部分だけを選べるか | 選択した概念・規則4件が入力に入り、未選択の目的は入らなかった |
| 人向け説明とAI入力が同じ定義を使うか | renderKnowledgeの出力をknowledgeContextがそのまま含んだ |
| 存在しない関係先を拒否するか | 隔離コピーで参照先を存在しないIDへ変えると拒否した |
| 意味の誤りまで拒否するか | 「acceptedは公開本文確認と人の承認まで完了を意味する」という誤った文でも形式検査は通った |

最後の結果は既存の責任分担どおりであり、新しい不具合とは扱わない。意味・適用の評価はAIと人に残る。今回の文例の妥当性は執筆担当が出典と照合しただけで、独立評価モデルの検出力や人の理解改善を確認したものではない。

## 採用時に残る条件

この例を正式な共有モデルへ移す場合は、既存方針や手順のどの定義を生成・参照へ置き換えるかを先に決め、手修正箇所が増えないことを確認する必要がある。名前の似た状態をモデルに載せるだけでは、実コードの遷移や意味の誤りを自動検出できない。

別プロダクトへの適用では、その業務用語の正本と責任を確認する。今回のdotagents内部の例から、バックエンドとフロントエンドなど複数repo間での効果を一般化しない。現時点では全repoの台帳、全体図生成、自動Issue化、必須の用語監査を追加する根拠はない。

## 保存・共有状態

本報告に統合したモデルは調査時点の試作品で、現在方針の正本にはしない。既存の知識JSON・生成説明・コード・規則・設定は変更していない。追加したのはローカルの調査報告1件で、commit・公開・別評価者による独立評価は未実施。将来採用する場合は、その時点のIssue・コード・方針へ照合し直す。
