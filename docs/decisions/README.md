# 判断の記録

後で変える費用があり、文脈なしでは理由が分からず、実際の代替案との選択がある判断を残します。現在の手順は[wiki](../wiki/README.md)、調査・実測の原本は[research](../research/README.md)から辿ります。

Claude／Codexとも[共通手順](../../skills/references/documents.md)で今回関連する記録を選び、対象版・適用条件・状態と、現行コード・Issueを照合します。判断記録の採用状態は、今回の要求や実行許可を自動で追加しません。

| 記録 | 状態 | 判断の対象 |
| --- | --- | --- |
| [DR-0001：要求と根拠を分けて同じ参照を渡す](0001-separate-requirements-from-evidence.md) | superseded by DR-0003 | #90・PR #92で採用した共有モデル選択と根拠の引き継ぎ |
| [DR-0002：過去の検証結果を固定資料として保全する](0002-retain-historical-evidence.md) | accepted | #161・PR #163で採用した過去報告の扱い |
| [DR-0003：共有モデル選択を終了し、説明をwikiへ集約する](0003-retire-shared-knowledge-selection.md) | superseded by DR-0004 | #265で合意した選択・生成の廃止と報告参照の維持 |
| [DR-0004：文書参照と実行記録は現行形式だけを受け付ける](0004-use-current-document-inputs-only.md) | accepted | #270で合意した旧文書運用の互換処理の終了 |

ここには置換済みの判断を含め4件を載せています。過去資料全件が採用済みという意味ではありません。[移行準備の記録](../research/documentation-migration.md)には、見送り・保留・未合意の提案、公開前の資料、元のhashを取得できなかった原本も区別して残しています。

## 状態と更新

[MADR形式のテンプレート](../../skills/templates/decision-template.md)を使い、状態をfrontmatterの`status`へ記します。

| 状態 | 意味 |
| --- | --- |
| `proposed` | 検討中。内容を改訂でき、採用済みの規則として使いません |
| `rejected` | 採用しなかった判断。理由と再判断条件を残します |
| `accepted` | 根拠のある採用判断。記録した範囲と条件で適用します |
| `deprecated` | 現在は使わない判断。終了した理由を残します |
| `superseded by DR-NNNN` | 後続の判断で置き換え済み。指定したDRへ進みます |

採用後の理由や当時の条件を書き換えて履歴を失わせず、方針の変更は後続DRへ記録し、旧記録の状態と参照を更新します。合意者・対象版・出典・採用状態が分からない場合は推測で埋めず、元のIssueや原本へ確認を戻します。調査終了やページ保存だけではacceptedにしません。
