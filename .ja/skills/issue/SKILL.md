---
name: issue
description: レビュー済みのResearchとThink成果物から、人間が読みやすくbuildに渡せるGitHub Issueを作成するか、既存Issueのtitleと本文全体を更新する。明示的なIssue公開依頼に使用する。
---

# Issue

この段階で確定する内容は、共通の[契約の粒度](../../workflows/README.md)に従う。

`codex-issue describe`で現在の入力形式、プレビュー、公開の契約を確認する。

## 下書き

- 公開する契約を準備する前に[.codex/OUTCOME.md](../../.codex/OUTCOME.md)を読む。
- think が作成した準備完了の JSON 成果物を 1 件使用する。存在しなければ、hook-bound な`codex-issue stop --input <task-bound-input-path>`を実行する。placeholder の Issue input や Think artifact を作成しない。
- Think artifact が参照する Research report を読む。確認済みの事実と Think の決定だけを使って Issue を作成する。
- `create`または`update`を選ぶ。`update`では対象 Issue を読み、ユーザーの依頼に必要な title と本文を全体的に更新する。既存内容は引き続き有用な場合だけ残す。
- 作業種別の接頭辞を付けず、内容を具体的に表す短い title にする。設定言語で読みやすい prose を書き、背景、確認済みの事実、決定、完了状態のうち有用な section だけを使う。
- `prose` に Plan を含めない。ready Think Plan から、Issue の title・prose に使う設定言語の `plan_markdown` を作る。outcome、各 unit の goal・contract・acceptance を省略せず忠実に翻訳し、順序・条件・範囲を維持する。code identifier、file path、test command は原文のまま保つ。ラベルと `###` unit 見出しも翻訳し、`## Plan` 見出し、code fence、HTML block は含めない。section と canonical JSON は controller が追加する。

## 公開

- ユーザーが先頭で明示した `$issue` invocation を、hook が束縛したリポジトリに対する GitHub Issue の create または edit 最大 1 回の承認として扱う。公開確認を重ねて求めない。
- 公開する場合は、最初の hook-bound `codex-issue draft` command 自体を network escalation で呼び、対応している環境では同じ tool call で prefix `["codex-issue", "draft"]` の永続的な許可を要求する。この prefix は controller が task と repository に束縛された `$issue` approval を引き続き必須とし、closed registry にある Issue の read/create/edit だけを公開するため、永続的に許可できる。missing-source の`codex-issue stop` command には network escalation を使わない。一時的な access failure が発生した場合だけ、publication approval が消費される前に同じ draft command を network escalation で正確に再実行する。
- GitHub へ書き込む前に draft を作成する。
- deterministic な draft error は再試行しない。network または credential の回復で変化し得る GitHub access failure だけを再試行する。
- Plan は draft 作成時に検証し、GitHub へ書き込む直前には update 対象が変更されていないことだけを確認する。
- 公開前に `plan_markdown` を原文 Plan と照合する。outcome、test command、全 unit の goal・files・contract・acceptance が揃い、要件の追加・省略・変更がないことを確認する。controller は 1 つの `## Plan` 見出しの下に翻訳した表示を置き、その後に正確な英語の Plan を折りたたんだ `Build Plan JSON` として追加する。JSON を唯一の Build authority とし、翻訳は表示だけに使う。言語を揃えて公開するときは必ず `plan_markdown` を渡す。省略時の英語描画は既存 caller の互換用に残す。
- Issue URL と`repo + issue_number`の Build selector を返す。

## エスカレーション

必要な動作・範囲・互換性・安全性・受け入れ条件が欠ける Plan は公開せず `think` に戻す。内部実装の選択が未指定なだけなら不完全とは扱わず、レビュー済み契約を変えずに公開する。GitHub 失敗は `issue` で停止する。

## 報告

canonical JSON Plan と機械向け workflow artifact は英語のままにする。Issue の title、prose、表示する Plan Markdown、Issue URL・Build source・次の状態を含む最終報告は設定言語で書く。source 不在で明示停止した場合は、`missing_decision`、GitHub write なし、次の状態として think を報告する。どちらの次状態にも進まない。
