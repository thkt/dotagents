---
name: issue
description: レビュー済みのthink成果物1件から、検証済みでbuildに渡せるGitHub Issueを作るか、既存IssueのPlanを追加・置換する。明示的なIssue公開依頼に使用する。
---

# Issue

`codex-issue describe`で現在の入力形式、プレビュー、公開の契約を確認する。

## 判断

- 公開する契約を準備する前に[.codex/OUTCOME.md](../../.codex/OUTCOME.md)を読む。
- think が作成した準備完了の JSON 成果物を 1 件使用する。存在しなければ、hook-bound な`codex-issue stop --input <task-bound-input-path>`を実行する。placeholder の Issue input や Think artifact を作成しない。
- 新規 Issue または指定された既存 Issue への Plan 追加を選ぶ。Plan より前の既存本文を保持し、この workflow が公開した Plan だけを置換する。
- 新規 Issue では、作業種別の接頭辞を付けず、内容を具体的に表す短い title を付ける。

## 公開

- ユーザーが先頭で明示した `$issue` invocation を、hook が束縛したリポジトリに対する GitHub Issue の create または edit 最大 1 回の承認として扱う。公開確認を重ねて求めない。
- controller は GitHub network access を有効にして実行する。execution sandbox が`api.github.com`を拒否した場合は、承認が消費される前に同じ hook-bound コマンドを network escalation 付きで再実行する。
- GitHub へ書き込む前に draft を作成する。
- GitHub write 前に draft が失敗した場合は、同じ task-bound invocation を再試行する。
- GitHub へ書き込む直前に、承認対象の draft と attach 対象が変更されていないことを確認する。
- `## Plan`の下に JSON Plan を 1 件だけ公開し、別の encoded Plan や Plan hash を追加しない。
- Issue URL、任意の監査用 receipt、`repo + issue_number`の Build selector を返す。

## エスカレーション

Plan が不正または不完全な場合は公開せず`think`に戻す。GitHub 失敗は`issue`で停止する。

## 報告

公開 Plan と workflow artifact は英語のままにする。Issue URL、任意の receipt、Build source、次の状態を含む、ユーザー向けの最終報告だけを設定言語へ翻訳する。source 不在で明示停止した場合は、`missing_decision`、GitHub write なし、次の状態として think を報告する。どちらの次状態にも進まない。
