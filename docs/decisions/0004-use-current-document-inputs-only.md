---
status: "accepted"
date: "2026-09-25"
decision-makers: "Issue #270の要求を合意した依頼者"
---

# 文書参照と実行記録は現行形式だけを受け付ける

## Context and Problem Statement

[DR-0003](0003-retire-shared-knowledge-selection.md)は共有モデル選択を廃止し、wikiと版付き報告参照へ移しました。一方、その移行のために旧Issueの選択ブロック、旧`research/`パス、旧`writing`設定、旧state形式とIssue hashを特別に扱う処理が残りました。[Issue #270](https://github.com/thkt/dotagents/issues/270)で、利用者は旧運用との互換性を不要とし、現行運用に必要なコードだけを残すよう選択しました。

## Decision Drivers

- 新しいIssue・設定・文書参照の契約を、旧形式の分岐なしで説明できるようにする。
- 必要な報告の版照合、実行途中の同一性検査、要求と根拠と権限の分離を保つ。
- 過去のIssue・run・Git blobを改変せず、現行の入力と取り違えない。

## Considered Options

- 旧形式に固有の停止・読取り・hash互換処理を残す。
- 旧形式は現行形式の検証で不正入力として扱い、専用の互換処理を除く。

## Decision Outcome

Chosen option: "現行形式だけを受け付ける"。`docs/research/`・`docs/wiki/`・`docs/decisions/`のMarkdown参照を開始commitとGit blobで固定します。旧形式の自動変換や再開は提供しません。新しいIssueと現行設定で実行し、過去の記録が必要なら原本の対象版と適用条件を人が確認します。DR-0003のうち旧選択の明示停止と移行手順に関する判断を置き換えます。

### Consequences

- 旧形式専用の解析と分岐、旧形式だけを確認するテストと操作案内を削除できます。形式が合わない保存stateや報告パスは通常の入力検証で拒否します。
- 旧形式を含むIssue本文を自動解釈しません。担当者は今回の要求と必要な根拠を現行Issueへ明示し、古い選択内容から黙って補完しません。
- wikiは現行の手順として手で更新し、重要な判断変更をDRへ記録します。独立評価と人の確認は引き続き必要です。

### Confirmation

現行の初回実装・既存PR修正・単独検証と不正入力の制御テスト、`bun run check`、文書・HTMLのリンクと表示、独立評価で確認します。ここに未実行の結果は記載しません。

## More Information

### Evidence and Scope

合意は[Issue #270](https://github.com/thkt/dotagents/issues/270)に記録します。過去の判断と原本は[DR-0003](0003-retire-shared-knowledge-selection.md)と[研究記録](../research/shared-knowledge-90.md)から辿れます。過去記録の内容と実測値は変更しません。

対象は旧文書運用のための互換処理です。現行の報告参照の版照合、実行中の同一性・失敗時の保全、GitHub公開の保証、無関係な過去形式の一括変更は含みません。

### Reassessment Triggers

- 旧形式から必要な要求・根拠を現行Issueへ移せない具体的な事例が生じた場合。
- 現行の参照形式で版・適用条件を維持できない事実が見つかった場合。
