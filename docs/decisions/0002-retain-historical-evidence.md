---
status: "accepted"
date: "2026-09-20"
decision-makers: "Issue #161の要求を合意した依頼者"
---

# 過去の検証結果を固定資料として保全し、専用の常時検査を終了する

## Context and Problem Statement

Issue #58の検証報告は特定の過去commitの結果です。その報告だけを再生成・照合する処理を通常のcheckに残しても、現在変更している機能の正しさは確かめられません。根拠を失わずに、現在の機能の検証へ集中できる形が必要でした。

## Decision Drivers

- 当時の結果、対象版、数量、未確認事項、出典を保存する。
- 過去の報告と現行の検証結果を混同しない。
- 過去の固定資料のためだけの生成・一致検査を通常開発から外す。

## Considered Options

- 過去の報告専用の生成器と、JSON・Markdownの常時一致検査を維持する。
- 報告を固定資料にし、当時の原本と生成器を参照可能に保って専用検査を終了する。

## Decision Outcome

Chosen option: "報告を固定資料にし、原本と生成器を参照可能に保って専用検査を終了する"。過去の結果を保持しながら、通常checkを現在の機能に必要な検証へ集中させるためです。

### Consequences

- 当時の実測と判断を対象版に結び付けて参照できます。
- この過去報告の再生成、形式検査、JSON・Markdownの自動一致検査は通常経路からなくなります。
- 現行runtimeの制御テストや、別途行う実撮影・実モデルの確認は必要なままです。検査を減らした速度効果は、この判断だけでは確認できません。

### Confirmation

[固定報告](../research/harness-review-2026-09-14.md)の対象版と未確認事項、`package.json` の現在のcheck、終了した生成器へのGit履歴参照を照合します。過去の実測原本を現行の値へ書き換えず、今回の文書変更のcheckと独立評価は別に記録します。

## More Information

### Evidence and Later Changes

[Issue #161](https://github.com/thkt/dotagents/issues/161)と[PR #163](https://github.com/thkt/dotagents/pull/163)、[採用commit](https://github.com/thkt/dotagents/commit/2edaf7bcd47c69bf93df0a951ce0d06ce7ccdd07)に基づく判断です。`date`は採用commitの日付で、合意者の個人名は今回再確認していません。

後続の[PR #257](https://github.com/thkt/dotagents/pull/257)では、現行ツリーから過去のJSONを外し、固定報告からGit履歴の原本へ案内しています。この後続整理と、#161で専用検査を終了した判断は区別します。原本は[当時のJSON](https://github.com/thkt/dotagents/blob/f06b3d62e9a033ee594ce46291cbba8c5b781144/docs/evidence/harness-review-2026-09-14.json)から参照できます。

### Reassessment Triggers

- 固定資料の値を継続的に再集計する具体的な用途が生じた場合。
- 原本・対象版・出典へ辿れなくなった場合。復元や参照修正を行い、過去の実測を推測で埋めません。
