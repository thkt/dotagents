# Project outcome

一度の依頼で、一次ソースに基づく Think/Research の判断と設計を高品質な Issue として publish できること。

## 検証可能な境界

- Think と Research の全 model stage は、開始時に取得した immutable repository snapshot を読み、実行中の共有 worktree 変更で結果が変わらない。
- current source の引用と Build Plan dependency は handoff 時に再検証し、stale または scope 外なら具体的な path を報告する。
- Issue は Outcome、Decision、実装に必要な Plan を構造化して一回で publish し、確立した契約はこの repository の documentation から再利用できる。
- Build は published Issue だけを実装・検証・semantic review・commit の契約として消費する。
- 確立した知識は repository docs に戻し、将来の Plan が引用できる。
- terminal model failure は intent を消費して停止し、入力・binding 検証失敗だけは修正のため intent を保持する。

検証は focused regression tests、`bun test`、typecheck、lint、format:check で行う。依存関係は `bun.lock` を正本とし、`bun install --frozen-lockfile --ignore-scripts` で再現する。
