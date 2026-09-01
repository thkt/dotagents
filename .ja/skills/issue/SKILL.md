---
name: issue
description: レビュー済みのthink成果物1件から、検証済みでbuildに渡せるGitHub Issueを作るか、既存IssueへPlanを追加する。明示的なIssue公開依頼に使用する。
---

# Issue

`codex-issue describe`で現在の入力形式、プレビュー、公開の契約を確認する。

## 判断

- 公開する契約を準備する前に [.codex/OUTCOME.md](../../.codex/OUTCOME.md) を読む。
- think が作成した準備完了の JSON 成果物を 1 件使用する。存在しなければ、設計判断が不足している状態で止める。
- 新規 Issue を作るか、指定された既存 Issue へ Plan を追加するかを選ぶ。
- 新規 Issue では、作業種別の接頭辞を付けず、内容を具体的に表す短い title を付ける。
- priority は critical、high、medium、low から 1 つ選ぶ。

## 公開

- ユーザーが先頭で明示した `$issue` invocation を、hook が束縛したリポジトリに対する GitHub Issue の create または edit 1 回分の承認として扱う。公開確認を重ねて求めない。
- Issue の title と人が読む説明には Codex で設定された言語を使用する。確立した識別子と実行可能なテスト名は変更しない。
- GitHub へ書き込む前に draft を作成する。
- GitHub へ書き込む直前に、同一 draft の title、body、証拠、リポジトリ状態、対象 Issue を検証する。
- 検証済みの draft を同じ invocation で公開し、Issue URL、receipt、build source を返す。

## エスカレーション

Plan・証拠が不正または古い場合は公開せず `think` に戻す。GitHub 失敗は `issue` で停止する。

## 報告

公開後は Issue URL、receipt のパス、次の状態が build であることを報告する。次の状態へは進まない。
