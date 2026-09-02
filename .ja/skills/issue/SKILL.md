---
name: issue
description: レビュー済みのthink成果物1件から、検証済みでbuildに渡せるGitHub Issueを作るか、既存IssueへPlanを追加する。明示的なIssue公開依頼に使用する。
---

# Issue

`codex-issue describe`で現在の入力形式、プレビュー、公開の契約を確認する。

## 判断

- 公開する契約を準備する前に [.codex/OUTCOME.md](../../.codex/OUTCOME.md) を読む。
- think が作成した準備完了の JSON 成果物を 1 件使用する。存在しなければ、hook-bound な`codex-issue stop --input <task-bound-input-path>`を実行する。placeholder の Issue input や Think artifact を作成しない。
- 新規 Issue を作るか、指定された既存 Issue へ Plan を追加するかを選ぶ。
- 新規 Issue では、作業種別の接頭辞を付けず、内容を具体的に表す短い title を付ける。
- priority は critical、high、medium、low から 1 つ選ぶ。

## 公開

- ユーザーが先頭で明示した `$issue` invocation を、hook が束縛したリポジトリに対する GitHub Issue の create または edit 最大 1 回と、選択した対応済み priority label が存在しない場合の作成承認として扱う。公開確認を重ねて求めない。
- controller は GitHub network access を有効にして実行する。execution sandbox が`api.github.com`を拒否した場合は、承認が消費される前に同じ hook-bound コマンドを network escalation 付きで再実行する。
- GitHub へ書き込む前に draft を作成する。
- GitHub へ書き込む直前に、同一 draft の title、body、証拠、リポジトリ状態、対象 Issue を検証する。
- 検証済みの draft を同じ invocation で公開し、Issue URL、監査用 receipt、`repository + issue_number`の portable build source を返す。
- 可視 Plan と埋め込み machine contract を同じ canonical Plan から生成し、公開前に Build と同じ完全一致検証を行う。

## エスカレーション

Plan・証拠が不正または古い場合は公開せず `think` に戻す。GitHub 失敗は `issue` で停止する。

## 報告

公開後は Issue URL、任意の監査用 receipt のパス、portable build source、次の状態が build であることを報告する。source 不在で明示停止した場合は、`missing_decision`、GitHub write なし、次の状態として think を報告する。どちらの次状態にも進まない。
