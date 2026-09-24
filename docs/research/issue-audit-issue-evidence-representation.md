# Issueの取得・保存・hashで使う表現を統一する

## 目的と現在の根拠

同じIssue証拠を入口ごとに異なる改行表現で扱い、後段が補正する構造を整理する。要求内容と更新の検出条件を変えず、取得・保存・比較の契約を一箇所で決める。

監査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。developmentは[checkedでstdoutをtrim](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/development.ts#L60-L64)して[Issueを取得](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/development.ts#L214-L224)する。correctionは[raw stdoutを返し](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/correction.ts#L134-L151)、その値をhashする。結果として[previousRunは改行なし/末尾改行1個の2種類のhashを許容](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/revision.ts#L83-L87)し、[実行中のrevision照合はtrim](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/revision.ts#L126-L143)する。

## 範囲・対象外

Issue取得結果の保存と比較に使う表現を統一し、同じ表現からhashを作る。取得時の証拠と比較用の値を分ける場合は、対応関係を明示して変換を重複実装しない。既存の証拠を読むための互換処理が必要なら、その責任を旧形式の読取りへ限定する。

本文内の空白・改行の意味を変える正規化、title/body/state/updatedAtの検出対象からの除外、過去runの書換え・変換・再開、全コマンドstdoutの一律trimは対象外。単独correctionのIssueコマンド出力を、GitHubのJSONだけに限定しない。

## 受入条件

- [ ] 新しいrunでは取得・保存・hash・再照合の表現が一致し、同じ入力に対して複数のhash表現を生成しない。一般コマンドの出力処理へIssue固有の変換を混ぜない。
- [ ] 記録上必要なraw出力、JSON内の本文文字列、UTF-8、本文の空白・改行を保持する。外側の出力形式と要求内容を取り違えない。
- [ ] 開始後のIssue変更を引き続き拒否し、updatedAtだけの変更でも停止する現在の契約を維持する。合意済み更新を新しい修正runで固定できる動作も維持する。
- [ ] 既存の検証済み公開runを新しい修正の参照元として読め、保存されたIssue証拠の改変を検出する。旧記録を書き換えて整合させない。必要な互換読取りは新規runの生成経路と区別する。

## 検証・関連・合意

既存のrevision/development/correctionテストで、末尾改行あり/なしの取得、保存後の再読取り、JSON内の改行と空白、UTF-8、本文・state・updatedAtの変更と旧証拠の改変を確認する。一般コマンドや平文のIssue出力への回帰も既存の入口から確認する。

セットアップは`bun install --frozen-lockfile --ignore-scripts`。実装提出前に`bun run check`、独立評価と日本語確認、PR公開時に同じheadの`checks`・`verify`を確認する。captureは`null`で媒体は不要。

完了済みの[#172](https://github.com/thkt/dotagents/issues/172)は、合意して更新したIssueを新runで固定する開始条件を整理した。今回はその条件を変えず、残る取得・保存表現の差を整理する。Issue取得と修正対象照合の責務分離は別Issueで扱い、形式変更と照合境界の変更を同時に広げない。

必要な根拠は本Issueと固定版リンクで足り、追加の必須調査報告や未commitの下書きを後続作業の入力にしない。着手時に最新の採用版で適用性を確認し直す。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
