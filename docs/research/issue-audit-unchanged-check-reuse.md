# 調査: 成果物を変更しない修正後に成功checkを再利用できる条件を確定する

## 目的と現在の根拠

成果物を変更しない修正後にも成功checkを毎回実行する現状について、必要な検出力を保って実行を減らせる条件と、その条件を確かめる負担を調べる。check再利用の採用は未合意であり、本Issueは調査・設計と採否判断までを対象とする。

監査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。[cycle](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/correction.ts#L621-L674)は修正応答がrepairedなら次のcycleへ進み、[checkを再実行](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/correction.ts#L456-L474)する。通常runの[回数・モデル時間設定はnull](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/development.ts#L491-L494)である。

既存のcorrection fixtureで、check成功後に同じ指摘を返し、修正担当が成果物を変更せずrepairedを返す条件を模擬した。有限の試験予算でcheck 3回・review 3回・repair 2回が実行され、全イベントのsourceは同じだった。実サービスの時間・費用は測定していない。sourceには含まれない依存・環境・外部状態があり得るため、同じsourceだけでcheckの同等性を保証できない。

## 調査範囲・対象外

同一run内の成功checkについて、成果物、checkコマンド・設定、依存、実行環境や外部状態のうち何を固定・観測する必要があるか整理する。常に再実行する現状と、条件を限定した再利用案を比較する。条件が確かめられない場合は再実行する案を含める。

本番でのcheck省略、source一致だけによるキャッシュ、専用の状態管理・長期キャッシュ、全体snapshot照合の削除、旧runの再利用・再開、修正回数の上限復活は対象外。修正理由の独立評価への受け渡しは別Issueで扱い、本Issueの調査をその実装の必須前提にしない。

## 調査の完了条件

- [ ] 前回成功と前回失敗・timeout・実行不能を区別し、成果物不変でも再実行が必要な現実的条件を示す。失敗後の再試行を成功証拠の再利用で置き換えない。
- [ ] 条件を揃えた模擬比較で、無変更、成果物変更、設定・依存・環境の変更を扱い、検出できる不具合と失う検出条件を説明する。観測できない条件を同一と推定しない。
- [ ] check証拠と評価対象の結び付け、独立評価、モデル前後の照合、途中の変更と復元、停止・証拠保全への影響を確認する。呼出回数の減少だけで採用判断しない。
- [ ] 減らせる実行と増える状態・分岐・保守を比較し、採用・不採用・保留の結論を本Issueへ残す。採用候補がある場合も、具体的な範囲と保証変更を依頼者が判断してから実装へ進む。

## 検証・関連・合意

既存のcorrection/capture/process/reviewテストとfixtureを再利用する。調査用の計数や試作を常設の必須検査へ追加しない。セットアップは`bun install --frozen-lockfile --ignore-scripts`。コード・文書を提出する場合は`bun run check`、独立評価と日本語確認、PR公開時の同じheadの`checks`・`verify`を確認する。調査だけのためにライブモデルや公開試行は起動しない。captureは`null`で媒体は不要。

完了済みの[#155](https://github.com/thkt/dotagents/issues/155)の無制限修正を維持する。[#101](https://github.com/thkt/dotagents/issues/101)で採用した同じ境界内のファイル取得共用と、見送った境界を越える観測保持とは区別する。今回の調査はcheck実行の再利用条件であり、#101で残したソース照合の削除を再提案するものではない。

必要な根拠は本Issueと固定版リンクで足り、追加の必須調査報告や未commitの下書きを後続作業の入力にしない。着手時に最新の採用版で適用性を確認し直す。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
