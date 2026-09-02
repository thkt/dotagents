# Workflow contracts

プロジェクトの成果条件は [.codex/OUTCOME.md](../../.codex/OUTCOME.md) に定義する。
この文書は安定した handoff 境界の一次情報である。

- Think と Research の model stage は同一 run の immutable repository snapshot を使う。
- Build は `repository + issue_number` で公開 GitHub Issue contract を選び、実行者固有のローカル receipt や latest scan に依存しない。
- hook が作る task directory は一時的な intent、approval、input、controller record を保持する。repository-local な`.codex/workflow-artifacts/`は無視可能な handoff・監査 cache であり、Build authority ではない。path は固定し、互換性のない task-local state は exact schema validation で拒否し、cache は再生成可能に保つ。
- protocol identifier はハーネス release ではなく、outcome を持つ1つの contract を表すため、すべて versionless とする。parser は現行の exact schema だけを受理する。durable Issue、Plan、manifest、task-local record が古い場合は、version 分岐や推測で読み替えず現行 workflow で作り直す。
- 公開 Issue は task-local record ではなく、ハーネスをまたいで残る durable authority である。publication は固定の `codex-public-build-contract` envelope と別途 hash された publication identity を使う。Build は古い envelope を拒否し、現行 Issue workflow による再公開を要求する。
- Build は読み込んだ公開 Plan から actor goal、contract、verification command を導出する。最終テスト後、独立した read-only Codex SDK review が完全な diff を検査してから Ship へ進む。
- external branch、commit、push、draft PR action は、中断した controller の再開時に observable postcondition から reconcile する。
- terminal model failure は intent を消費し、入力または binding 検証失敗は保持する。
- ready Think artifact がない pending Issue は、task-bound な`codex-issue stop`でだけ終了する。placeholder input や GitHub access を要求せず publication authority を失効させる。
- Issue は canonical Plan から可視 body と machine contract を生成し、current source と完全一致を再検証して一度 publish する。Build は開始時、semantic review 前、Ship 前に同じ公開 Issue を再検証する。
- 確立した decision は repository documentation に戻し、将来の Plan が knowledge として引用できるようにする。
- active controller は task-bound な `codex-flow cancel` でだけ取消できる。取消は Ship authorization を失効させ、terminal `cancelled` となる。

Think Plan は内容を再生成せず、この文書の該当規則を引用する。

## GitHub CLI access

runtime のすべての `gh` 呼び出しは `shared/github.ts` に宣言し、workflow module は GitHub command を組み立てず、そこで定義した literal argv builder を使う。

| Operation                                                                            | Access    | 必要な authority                                                                                         |
| ------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------- |
| `repo view`、`issue view`、publication-id による Issue 検索、`label list`、`pr view` | read-only | なし。正確な command の実行には sandbox の network escalation が別途必要な場合がある                     |
| `label create`、`issue create`、`issue edit`                                         | write     | 先頭の明示的な `$issue` invocation が作成し、repository に束縛された `issue-publication` approval の消費 |
| `pr create`                                                                          | write     | 先頭の明示的な `$build` invocation が作成し、task と repository に束縛された `build-ship` approval       |

pending Build の hook は、source に束縛された正確な `gh issue view` command だけを許可する。Issue が提供する shell gate では `gh` を禁止し、すべての shell-gate subprocess から GitHub token を除去して独立した `GH_CONFIG_DIR` を使う。Git push は別の `build-ship` action とし、Issue 由来 command へ委譲しない。

branch 作成前の GitHub network・authentication・keyring access failure は cursor 0 のままにし、manifest、`HEAD`、worktree snapshot が同一の場合だけ Build を再実行できる。Issue 不在、GitHub response 不正、Issue contract 不正は network failure として再実行できない。GitHub write failure で消費済み write approval を拡張または復元しない。

Ship recovery は GitHub が明示した「pull request が存在しない」結果だけを absence として扱う。既存 PR を取得できない、response が不正、または既存 PR が期待値と不一致の場合は、`gh pr create` を再実行せず block する。
