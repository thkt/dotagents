# Workflow contracts

プロジェクトの成果条件は [.codex/OUTCOME.md](../../.codex/OUTCOME.md) に定義する。
この文書は安定した handoff 境界の一次情報である。

- Think と Research の model stage は同一 run の immutable repository snapshot を使う。
- Build は明示的に task-bound な published Issue artifact を選び、latest scan を行わない。
- semantic reviewer と auditor は独立した検査である。
- terminal model failure は intent を消費し、入力または binding 検証失敗は保持する。
- Issue は current source を再検証して一度 publish し、Build は published Issue だけを消費する。

Think Plan は内容を再生成せず、この文書の該当規則を引用する。
