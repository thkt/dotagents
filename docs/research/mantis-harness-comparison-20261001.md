# Mantis と dotagents の比較と導入候補

合意済みIssueの実装を人のレビューへ渡す用途では、dotagentsの要求・権限・公開管理が充実しています。脆弱性を広く探索し、再現・再攻撃・過去の調査結果を使って調査する用途では、Mantisの専用機能が充実しています。両者の強みは用途ごとに異なります。

推奨するのは、dotagentsの既存工程に、修正前の再現と修正後の正常動作の対照、指摘への反証、必要な場合の再攻撃を取り入れることです。Mantisの全工程や知識DBを一括導入する根拠は得られていません。以下の優劣は機能・契約・指示の比較からの判断であり、検出率や速度の実測結果ではありません。

## 調査の目的と対象版

目的は、google/mantisから再利用できる知見を保存し、我々のハーネスが優れる点と、Mantisが優れる点を導入判断に使える形で整理することです。前回の会話で挙げた候補を引き継ぎ、今回は参照ハーネスのコードも確認しました。Mantisにも判定を検査する実装があり、指示文だけで運用されているとは扱いません。

| 対象 | 確認した版と条件 |
| --- | --- |
| 確認日 | 2026年10月1日 |
| dotagents | `918aa6ec5a582da43a82bf831240c2f921f6d686`。調査開始時点の追跡ファイルに変更なし。無関係な未追跡資料は比較対象外 |
| Mantis | `47099edfe7518345850ceaae947e2f91b554ec23`。公開ソースを固定版で読取り |
| 調査方法 | README・スキル・関連する実装・テスト定義を比較。Mantisのモデル実行、再現環境、テストスイートは未実行 |
| 保存状態 | 調査資料と未採用の提案としてローカル保存。機能の採用、Issueの合意、commit・push・PR公開は含まない |

Mantisはスキル群とPython／ADKの参照ハーネスです。READMEは公式サポート製品ではなくデモ用途と説明しています。[Mantis README][m-readme]

## 用途によって評価基準が異なる

dotagentsの入口は要求整理と合意済みIssueの実装です。コード・要求・テスト・文書を独立評価し、対象版を照合してdraft PRを公開し、公開後確認とCIを経て人のレビューへ渡します。Mantisの標準工程は履歴・構造索引・脅威モデル・調査計画から始まり、発見・重複整理・判定・本番条件の確認・再現・攻撃の連鎖・修正・重大度調整・振り返り・報告へ進みます。[dotagents README](../../README.md)、[Mantis工程定義][m-workflow]

したがって、PR運用の機能が多いことを脆弱性検出力の高さとは扱わず、セキュリティ専用工程が多いことを通常の実装効率の高さとも扱いません。以下は、各用途に必要な支援がどこまで具体化されているかの比較です。

## dotagents が優れる点

各行の「優れる」は、記載した用途と確認範囲での判断です。Mantisの全機能に対する不在証明ではありません。

| 観点 | 確認した差と優れる理由 | 限界と根拠 |
| --- | --- | --- |
| 合意した要求と権限の管理 | Issueを要求の正本とし、調査報告を追加の許可と区別する。対象repo・remote・主体・権限を確認し、不一致で止める。人と共同で通常の開発を進める契約が具体的 | Mantisは調査目標と脅威モデルを中心にする。意図と証拠を区別する仕組みはあるが、確認した標準工程には同等のIssue合意から公開までの契約がない。[参照引き継ぎ](../../scripts/implement/research-handoff.ts)、[対象検査](../../scripts/shared/target.ts)、[Mantis証拠の境界][m-evidence] |
| PR公開と既存PR修正 | 検証済みcommit、公開先、作者、head・base、本文、draft状態を照合する。公開後の読戻しと同じheadのCI、実表示確認、人の承認・マージを分けて扱う | Mantisの標準工程は調査報告へ終着し、確認した範囲では同等のPR公開ライフサイクルを提供しない。GitHubの操作間の競合を完全に排除する保証ではない。[公開](../../scripts/implement/publish.ts)、[既存PR](../../scripts/implement/revision.ts)、[CI](../../scripts/implement/ci.ts)、[Mantis工程][m-workflow] |
| 通常変更の評価範囲 | コードの欠陥だけでなく、Issueの要求、テストの検出力と保守費用、文書の意味と版を既存の独立評価で扱う。文書のみの変更やテスト整理にも適用できる | Mantisの専用レビューはセキュリティ指摘の妥当性を中心にする。どちらの指示もモデルが遵守する保証ではない。[レビュー指示](../../scripts/implement/review.ts)、[Mantisレビュー][m-review] |
| 実行途中の対象同一性と現行形式 | 報告の開始commit・blob、Issue・ソース・check結果・評価対象を照合し、対象の変更で停止する。旧stateを変換・再開せず、現行形式へ契約を絞る | Mantisもsnapshotを照合するが、スキルにはsnapshot引数がない場合のlegacy動作と互換分岐がある。我々の強みは契約の一貫性で、証拠管理が我々にしかないという意味ではない。[修正と評価の制御](../../scripts/implement/correction.ts)、[DR-0004](../decisions/0004-use-current-document-inputs-only.md)、[Mantis snapshot説明][m-agents] |
| 不明な結果を成功へ置き換えない評価方針 | 欠陥と懸念、要求充足と実行成功、CI失敗と取得不能、観測できた使用量と欠損を区別する。再現できないことを低リスクの根拠にしない判断へつなげやすい | Mantisにも未確認状態がある。一方、重大度規則にはsnapshot例外を除き再現失敗・未実施をLOWへ下げる規則がある。この差は保守的な判断方針の比較で、重大度の正解を測定したものではない。[検証結果の範囲](../wiki/evidence-scope.md)、[使用量集計](../../scripts/implement/usage.ts)、[Mantis重大度規則][m-calibration] |

## Mantis が優れる点

セキュリティ調査用の機能と指示の充実度を評価しています。機能の存在から実際の検出力や隔離強度は断定しません。

| 観点 | 確認した差と優れる理由 | 限界と根拠 |
| --- | --- | --- |
| 調査対象を自ら見つける計画 | 履歴、構造索引、アーキテクチャ、脅威モデルを調査計画へ接続する。特定Issueの差分を受け取る前の、広い探索を支援する工程がある | dotagentsの独立評価も関連経路を追うが、全体の攻撃面を探索する専用パイプラインではない。索引の存在は全経路の検査を保証しない。[工程][m-workflow]、[調査計画][m-plan] |
| 指摘の反証と実際の本番条件 | 指摘を否定する観点と、本番ビルド・配置条件で成立するかを別スキルとして具体化する。仮の呼出しやテスト用コードを実害へ飛躍させる誤指摘を減らす設計 | dotagentsも独立確認を求めるが、この用途の具体例は少ない。Mantisの固定除外規則には移植すべきでないものもある。[レビュー][m-review]、[本番条件の確認][m-critic] |
| 修正前と修正後の対照検証 | 修正前の新しいコピーで再現し、修正後のビルド・正常入力・攻撃入力を確認する条件を明記する。入口を壊して攻撃が通らなくなった結果を修正成功と誤認しにくい | 条件全体はスキルの要求であり、すべてが参照ハーネスのコードで強制されると確認したわけではない。[修正指示のBlock G][m-patch] |
| 独立した再攻撃 | 修正に対して独立担当が入力の変種で回避を試みる。元の再現だけに合わせた修正を見つける手順が具体的 | dotagentsは関連経路と再発を再評価するが、再攻撃の専用手順はない。Mantisの変種3件以上という固定数は、十分性の証明にはならない。[修正と再攻撃][m-patch] |
| 動的実行の証拠確認 | 終了コードだけでなく、対象経路のマーカーやsanitizer・crash出力を確認し、動的確認状態へ進める実装がある | 文字列・正規表現による確認であり、出力の真正性や攻撃成立を完全に証明するものではない。dotagentsのcheck成功とも確認対象が異なる。[実行証拠検査][m-sandbox-tools]、[工程完了時の状態更新][m-graph] |
| 危険な再現コードの実行環境 | static-only、gVisor、Microsandbox、GCEを選べる実装がある。再現コードを実行するための環境切替と事前確認が用意されている | dotagentsはCodexのread-only／workspace-writeを役割別に使う。今回どちらの隔離性能も実測していない。Mantisの標準工程はstatic-onlyで、動的再現には別設定が必要。[環境実装][m-environments]、[dotagents actor](../../scripts/implement/codex-actor.ts) |
| 調査間の知見と同じ原因の追跡 | 過去の欠陥、修正、誤指摘をファイルやlineageに関連付け、編集前に問い合わせる。調査の繰返しと再発防止を直接支援する | dotagentsにはwiki・判断記録・researchとrun内の指摘履歴があるが、同等の専用検索・系譜管理はない。過去の非該当を現在の免除にする使い方は避ける。[助言][m-advise]、[重複整理][m-dedupe] |
| 複数の弱点をつないだ影響の調査 | 単独の指摘から、攻撃の連鎖を組み立てる専用工程がある。局所評価だけでは見えない影響を調べる支援になる | dotagentsでも関連経路を調べられるが、専用の連鎖調査はない。連鎖の各条件が成立するかは別途確認が必要。[攻撃の連鎖][m-chain] |
| 工程別のツールと調査範囲の観測 | 工程定義にツールを列挙し、loaderが対応するツールを組み立てる。また、調査範囲・指摘の種類・棄却・指摘なしの範囲を観測するコードがある | ツール構成はOSの権限分離と同じではない。観測値は合否ゲートや検出率ではなく、調査の偏りを判断する材料。[工程][m-workflow]、[loader][m-graph]、[調査の分布][m-diversity] |

## 両者にある仕組みと未確認の優劣

独立した判定、構造化した応答、実行上限は両者にあります。対象版と証拠の照合、過去の結果の利用、模擬テストと実モデル評価の入口も備えています。片方の名称や指示量だけで優劣を決めません。Mantisのevalにも工程別の評価コードとデータがあります。[Mantis eval][m-eval]、[dotagents evalの調査時点の実装](https://github.com/thkt/dotagents/blob/918aa6ec5a582da43a82bf831240c2f921f6d686/scripts/eval/eval.ts)

検出率・誤指摘率・実時間・token・保守費用・隔離の強度は、同じ課題と条件で比べていないため未確認です。dotagentsの過去の少数試行をMantisとの比較値へ流用しません。Mantisのスキルが要求する条件、参照ハーネスの強制条件、実行で満たした条件も区別します。調査した機能の比較を、リポジトリ全体の安全性監査とは扱いません。

## 取り入れる候補と我々の既存機能との差

以下は未採用の提案です。費用は実測ではなく、変更箇所と追加実行からの見積りです。全変更への必須工程や、新しい専用帳票を求めるものではありません。

| 優先度 | 候補 | 我々への最小の追加と期待する効果 | 費用と採用前の確認 |
| --- | --- | --- | --- |
| 高 | 修正前の再現と修正後の正常入力を対照にする | 既存テスト方針に具体例を加える。元の不具合が存在したことと、機能を壊さず直ったことを確認する | 小〜中。既存の再現・正常系テストで足りる場合は追加しない |
| 高 | 指摘を否定する条件を評価する | 既存レビューのcondition・impact・evidenceで、呼出経路、入力主体、既存防御、設定を確認する | 小。誤指摘が減る一方で欠陥を捨てないか、既知の誤指摘と真の欠陥で比較する |
| 高・条件付き | 独立評価で修正を崩す | パス、認可、競合などで別入力・操作順を試す。既存の修正ループに戻す | 中。入力数を固定せず、対象の失敗条件から選ぶ。通常変更へ一律には課さない |
| 中 | 過去の非該当理由と修正の意図を編集前に使う | 関連するwiki・判断記録・researchへの参照を充実させる。適用版と再確認条件を残す | 小〜中。まず既存文書で試し、DBの追加が必要かは検索の失敗と費用から判断する |
| 中 | 原因・条件・対象版に基づく重複判定 | 既存IDと原指摘を保持し、同じ原因の症状を複数の欠陥として数えない | 小。似た説明の別の欠陥を統合しないか確認する |
| 中 | 調査した範囲と未確認範囲を示す | 大きな調査の既存findingsに、確認した経路・観点・指摘なしの範囲を簡潔に残す | 小〜中。件数目標や品質点数にはしない。記録が判断を助けるか確認する |
| 中・条件付き | 工程別のツール制限 | 評価担当が必要とする操作を列挙し、実行基盤で制限できるか調べる | 中〜大。現行のsandboxとの追加差と、必要な検証を妨げないことを確認する |
| 低 | スキルのコマンド参照を機械検査する | 信頼する実体からCLIを解決する既存規則の漏れを検出する | 小。Mantisの検査も限定した構文の検査であり、コマンド全体の安全性検査ではない。[参照検査][m-anchoring] |

## そのまま移植しない規則と機構

- **再現失敗・未実施による一律のLOW判定。** 検証不能と影響の小ささを分け、未確認理由を保持する。Mantis側のsnapshot例外も含めて読む。[重大度規則][m-calibration]
- **DoSや防御の追加不足を広く除外する固定規則。** 我々の対象repoの要求・運用・権限から適用範囲を決める。Mantisの除外を汎用的な正解として採用しない。[レビュー規則][m-review]
- **再攻撃の固定件数とVERIFIED_SECUREという断定。** 対象の条件から必要な変種を選び、確認した範囲を説明する。一定数の失敗だけで安全性を保証しない。[修正指示][m-patch]
- **全工程、知識DB、動的な工程生成の一括導入。** 通常のIssue実装で追加する価値と費用は未確認。セキュリティ調査の要求が具体化してから別途評価する。[工程][m-workflow]、[loader][m-graph]

## 次の判断に必要な比較

まず、修正前の再現・正常入力の対照と、反証観点の追加を、既存の不具合・誤指摘事例で試すことを推奨します。課題と開始commit、入力を固定します。モデルと設定、採点条件も揃え、要求充足・見落とし・誤指摘を独立に確認します。その後、失敗と再試行を含む時間・観測できる使用量を比べます。[既存の比較方針](../wiki/development-policy.md#改善効果の比較)

採用判断は、必要な欠陥を見つけたか、誤指摘を減らしたか、既存の要求・正常動作を維持したか、その効果が追加費用に見合うかで行います。両ハーネス全体の優劣を一度に測る試験はまず行わず、取り入れる要因を絞ります。実装と公開を進める場合は、対象のIssueで要求と完了条件を合意します。

## 根拠の固定リンク

本文のdotagentsへの相対リンクは読む入口です。比較時点のソースは [dotagentsの固定版](https://github.com/thkt/dotagents/tree/918aa6ec5a582da43a82bf831240c2f921f6d686) の同じパスで確認します。Mantisへのリンクは下記の固定版を使います。

[m-readme]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/README.md
[m-agents]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/README_AGENTS.md
[m-workflow]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/reference/workflow.json
[m-review]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/mantis-review/SKILL.md
[m-critic]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/mantis-critic/SKILL.md
[m-patch]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/mantis-patch/SKILL.md#L558-L618
[m-calibration]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/mantis-calibrate/references/calibration_rules.md
[m-plan]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/mantis-plan/SKILL.md
[m-advise]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/mantis-advise/SKILL.md
[m-dedupe]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/mantis-dedupe/SKILL.md
[m-chain]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/mantis-chain/SKILL.md
[m-evidence]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/reference/core/evidence.py
[m-sandbox-tools]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/reference/tools/sandbox_tools.py
[m-graph]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/reference/core/graph_loader.py
[m-environments]: https://github.com/google/mantis/tree/47099edfe7518345850ceaae947e2f91b554ec23/reference/core/environments
[m-diversity]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/reference/core/diversity.py
[m-eval]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/reference/evals/run_eval.py
[m-anchoring]: https://github.com/google/mantis/blob/47099edfe7518345850ceaae947e2f91b554ec23/reference/scripts/check_skill_anchoring.py
