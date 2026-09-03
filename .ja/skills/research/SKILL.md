---
name: research
description: プロジェクトまたは技術上の問い1つを調査し、別担当による検証と未確定事項を含む、出典確認済みの成果物にする。明示的な調査依頼に使用し、変更の実装やPlan自体の作成は行わない。
---

# Research

`codex-research describe`で現在の入力形式と成果物の契約を確認する。
束縛された workflow command は network access 付きで実行する。sandbox が入れ子 Codex の接続を拒否した場合は、同じ command を network escalation で再実行する。`model_unavailable` はその再実行のため intent を保持する。

## 判断

- 存在する場合は[.codex/OUTCOME.md](../../.codex/OUTCOME.md)を読み、関連する一次資料だけを最小限確認する。
- 問いを 1 つに絞る。
- 調査対象外の証拠を除く必要がある場合だけ、リポジトリ内の対象範囲を指定する。
- repository の証拠だけでは回答できない場合に限り外部資料を有効にし、一次資料を優先する。

## 境界

- 確認できない主張は推測で埋めず、未確定事項として残す。
- 関連する Knowledge は手掛かりとして扱い、各 finding を支える現在の repository または外部 source を示す。

## 報告

成功した Research は永続化済み report から topic 別 Knowledge の再構築を試みる。Knowledge の書き込み失敗によって Research report を無効にしない。workflow artifact は英語のままにする。回答、finding と未確定事項の件数、成果物パス、次の状態が`think`であることを含む、ユーザー向けの最終報告だけを設定言語へ翻訳する。Think へは進まない。
