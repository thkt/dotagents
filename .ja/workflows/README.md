# Workflow contracts

プロジェクトの成果条件は [.codex/OUTCOME.md](../../.codex/OUTCOME.md) に定義する。
この文書は安定した handoff 境界の一次情報である。

- Think と Research の model stage は同一 run の immutable repository snapshot を使う。
- Build は `repository + issue_number` で公開 GitHub Issue contract を選び、実行者固有のローカル receipt や latest scan に依存しない。
- semantic reviewer と auditor は独立した検査である。
- terminal model failure は intent を消費し、入力または binding 検証失敗は保持する。
- Issue は canonical Plan から可視 body と machine contract を生成し、current source と完全一致を再検証して一度 publish する。Build は開始時と Ship 直前に同じ公開 Issue を再検証する。
- active controller は task-bound な `codex-flow cancel` でだけ取消できる。取消は Ship authorization を失効させ、terminal `cancelled` となる。

Think Plan は内容を再生成せず、この文書の該当規則を引用する。
