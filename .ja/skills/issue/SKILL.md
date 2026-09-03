---
name: issue
description: レビュー済みのResearchとThink成果物から、人間が読みやすくbuildに渡せるGitHub Issueを作成するか、既存Issueのtitleと本文全体を更新する。明示的なIssue公開依頼に使用する。
---

# Issue

`codex-issue describe`で現在の入力形式、プレビュー、公開の契約を確認する。

## 下書き

- 公開する契約を準備する前に[.codex/OUTCOME.md](../../.codex/OUTCOME.md)を読む。
- think が作成した準備完了の JSON 成果物を 1 件使用する。存在しなければ、hook-bound な`codex-issue stop --input <task-bound-input-path>`を実行する。placeholder の Issue input や Think artifact を作成しない。
- Think artifact が参照する Research report を読む。確認済みの事実と Think の決定だけを使って Issue を作成する。
- `create`または`update`を選ぶ。`update`では対象 Issue を読み、ユーザーの依頼に必要な title と本文を全体的に更新する。既存内容は引き続き有用な場合だけ残す。
- 作業種別の接頭辞を付けず、内容を具体的に表す短い title にする。設定言語で読みやすい prose を書き、背景、確認済みの事実、決定、完了状態のうち有用な section だけを使う。
- prose に Plan を複製したり`## Plan` section を追加したりしない。完成した title と prose を controller へ渡し、Think artifact の正確な Plan は controller に追加させる。

## 公開

- ユーザーが先頭で明示した `$issue` invocation を、hook が束縛したリポジトリに対する GitHub Issue の create または edit 最大 1 回の承認として扱う。公開確認を重ねて求めない。
- 公開する場合は、最初の hook-bound `codex-issue draft` command 自体を network escalation で呼ぶ。GitHub へ書き込むため、その prefix の永続的な許可は要求しない。missing-source の`codex-issue stop` command には network escalation を使わない。一時的な access failure が発生した場合だけ、publication approval が消費される前に同じ draft command を network escalation で正確に再実行する。
- GitHub へ書き込む前に draft を作成する。
- deterministic な draft error は再試行しない。network または credential の回復で変化し得る GitHub access failure だけを再試行する。
- Plan は draft 作成時に検証し、GitHub へ書き込む直前には update 対象が変更されていないことだけを確認する。
- `## Plan`の下に JSON Plan を 1 件だけ公開する。renderer は読みやすさのために折りたたんでもよいが、Build は周囲の表示用 markup に依存しない。
- Issue URL と`repo + issue_number`の Build selector を返す。

## エスカレーション

Plan が不正または不完全な場合は公開せず`think`に戻す。GitHub 失敗は`issue`で停止する。

## 報告

公開 Plan と workflow artifact は英語のままにする。Issue の title、prose、Issue URL、Build source、次の状態を含む最終報告は設定言語で書く。source 不在で明示停止した場合は、`missing_decision`、GitHub write なし、次の状態として think を報告する。どちらの次状態にも進まない。
