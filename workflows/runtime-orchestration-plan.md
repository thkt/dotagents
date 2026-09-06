# runtime が制御する workflow の移行 Plan

状態: 移行全体の設計記録。P0 の事前確認と P1 の実装・検証を実施済み。P1 の実装根拠は公開 [Issue #34](https://github.com/thkt/dotagents/issues/34) の canonical Plan とし、本書は Build の実装根拠ではない。P2 は公開 [Issue #36](https://github.com/thkt/dotagents/issues/36) に基づき実装・検証・マージ済み。P3 は公開 [Issue #38](https://github.com/thkt/dotagents/issues/38) に基づき実装・検証・マージ済み。P4 は公開 [Issue #40](https://github.com/thkt/dotagents/issues/40) に基づき実装・検証・マージ済み。P5 は公開 [Issue #42](https://github.com/thkt/dotagents/issues/42) に基づき実装・検証済み（レビュー待ち）。P6 は未実装。

調査基準: `6421ea78addb0329935c3a37cbbfd7a7c758a623`。実装開始前に対象 HEAD と公開 Issue を再確認する。

## 到達する結果

`Research → Think → Issue → Build` を基本経路とし、各工程の成果物に静的検証と独立した LLM レビューを実施する。未達なら runtime が修正担当または必要な前工程を起動し直す。工程遷移、完了判定、状態保存、再開を親 LLM の判断や記憶に依存させない。

SDK は実行手段として継続利用する。native multi-agent の利用や SDK の除去は完了条件に含めない。コードから制御できる担当 agent と独立 reviewer によって分担を成立させる。独立した読み取り調査の並列化は最後に追加する。

`.codex/OUTCOME.md` の成果物、Issue を唯一の Build authority とする境界、Code の Git 操作禁止、言語、Knowledge の派生性を維持する。

## 現在あるものと不足

| 所有箇所                               | 現在の処理                                         | この移行で埋める不足                       |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------ |
| `execution/engine.ts`, `controller.ts` | 永続状態に基づく実装・検証・差し戻し               | 工程横断の戻りと再開への接続               |
| `execution/agent.ts`                   | 実装、独立レビュー、不要な handoff の修正          | 修正担当の継続性を検証可能にする           |
| `research/pipeline.ts`                 | 調査と監査を一巡し、証拠を検証して保存             | 未達時の担当への修正ループ、途中再開       |
| `think/pipeline.ts`                    | 設計とレビュー、不正な Plan を reviewer に一度返す | 設計者による修正と独立した再レビュー       |
| `issue/pipeline.ts`                    | ready Plan、公開原稿、公開結果の検証               | 原稿の意味的忠実性を公開前に独立レビュー   |
| `runtime/invocation.ts`, `storage.ts`  | 工程別の入力、task に結び付いた許可と保存          | 自動で戻る際の入力生成・親子関係・許可境界 |
| `shared/codex.ts`, `codex-home.ts`     | SDK、構造化応答、監視、隔離                        | 継続・再開の能力確認と必要最小限の拡張     |

## 必須の契約

以下は公開 Plan に引き継ぐ observable requirements。内部 API 名やファイル分割は実装者が選ぶ。

1. **Completion:** A stage completes only when static validation and an independent semantic review pass for the same candidate and governing inputs. LLM declarations cannot advance runtime state.
2. **Findings:** Rejections identify the unmet acceptance condition, supporting evidence, and a permitted correction destination. Advisory findings do not block completion. Malformed responses and infrastructure failures are indeterminate, never successful reviews.
3. **Independence:** The implementation or authoring agent cannot approve its own candidate. A reviewer that changes a candidate becomes an author; that candidate requires another independent review.
4. **Binding:** Runtime binds accepted findings to the invocation, attempt, candidate, relevant inputs, and repository snapshot. Changed candidates or governing inputs invalidate prior acceptance. Late and duplicate results cannot advance another attempt.
5. **Local correction:** In-scope implementation choices and test failures return to the responsible worker. Preserve worker continuity where supported; otherwise reconstruct the assignment and correction context from persisted evidence without claiming session continuity.
6. **Cross-stage routing:** Only confirmed missing facts route to Research; only confirmed requirement or design decisions outside the current contract route to Think. Runtime validates the route and prepares the destination's own validated input.
7. **Research outcomes:** Explicit, evidence-backed unknowns may be a valid Research outcome. Research need not invent answers to pass. Whether those unknowns block a requested Plan is decided separately by Think.
8. **Execution:** While a runtime process is active, it dispatches the next allowed action itself. Persist pending work before dispatch and accepted results before advancement. Process termination requires a subsequent runner invocation to resume; this plan does not add a background scheduler.
9. **Recovery:** Reconcile interrupted attempts and external actions before retrying. Concurrent runners cannot both own a run. Repeated correction, transient retries, and cross-stage returns have finite persisted limits; exhausted limits produce a resumable blocked result with evidence.
10. **Authority:** Research and Think may prepare corrections within the original authorized scope. They cannot silently replace the public Issue Plan. A changed Plan requires authorized Issue publication and a new Build invocation bound to that public revision; the previous Build does not reread and adopt it mid-run.
11. **External actions:** Agent findings never grant publication or Ship authorization. Issue publication and Ship retain their existing explicit authorization checks. Never blindly retry an uncertain GitHub create operation; reconcile evidence or block for resolution.
12. **Compatibility:** Preserve existing public entrypoints and artifact meaning. Version changed persisted contracts and either support safe resumption or reject incompatible state before side effects with an explicit recovery path. Do not silently reset old active runs.

## 実装順序と受入条件

各行を 1 つの review 可能な変更単位とする。公開 Issue 化する際は、各単位に必要な上記契約を全文で含め、未公開の本書への参照だけに依存させない。

| 順序 | 変更単位                                                                                                              | 依存 | 完了を確認する証拠                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| P0   | 現行 SDK の起動・追加指示・中断・再開・隔離を小さな隔離環境で確認する。現在の保存形式と許可の境界も記録する           | なし | 実モデルの記録。対応能力と fallback を確定し、内部 API を推測しない                                                        |
| P1   | Build / Code の既存 executor 上で、判定・成果物 binding・差し戻し・再開の共通契約を揃える。状態互換性と同時実行も扱う | P0   | 静的失敗・意味的失敗から修正に戻る。古い結果、順序飛ばし、競合 runner を拒否。既存 Build / Code が回帰しない               |
| P2   | Research に静的検証→独立監査→調査担当の修正→再検証と途中再開を追加する                                                | P1   | 不正な証拠を修正し合格できる。根拠付き unknowns は保存可能。監査不正は未判定。Knowledge 更新失敗は完成 Report を失わせない |
| P3   | Think に設計者の修正ループを追加する。レビューは候補の書き換えと自己承認を兼ねない                                    | P2   | 不正・不十分な Plan が設計者に戻り、修正後に再レビューされる。事実不足は具体的な Research 要求になる                       |
| P4   | 許可された範囲で Research / Think / Build 間の戻りと呼び出し元への復帰を runtime が実行する                           | P3   | Think→Research→Think と Build→Think の実行記録。入力混用を拒否。Plan 変更は Issue 再公開待ちとなり、旧 Build は進まない    |
| P5   | Issue 原稿の静的検証と独立した意味的レビューを公開前に追加し、再公開・新 Build の接続を完成する                       | P4   | Plan の追加・省略・翻訳による意味変更を差し戻す。許可なしでは公開しない。公開応答喪失から重複作成しない                    |
| P6   | Research の独立した読み取り調査を上限付きで並列化し、全体の実モデル検証を行う                                         | P5   | 個別の結果を統合して監査。子 agent の失敗・遅延でも誤完了しない。実装の同時編集は導入しない                                |

P1 で別の汎用 workflow framework を新設することを目的にしない。既存 executor の仕組みを再利用し、Research/Think に必要な共有部分だけを抽出する。P4 では既存の明示的な入口を維持し、親の許可から派生する内部実行を外部書き込み許可と区別する。

P0 で確認する SDK の継続手段が利用できなくても、永続化された修正文脈を新しい SDK thread に渡して進行できれば移行は継続できる。native multi-agent への変更は同じ受入条件を満たす場合の将来の選択肢とする。

## 検証と完了の判定

- 各変更で、その observable behavior を確認する最小レベルのテストを追加し、`bun run check` を通す。
- deterministic な agent/gateway を使い、静的失敗、意味的失敗、応答不正、timeout、候補変更、中断・再開、遅延結果、上限到達、未許可の公開を再現する。
- 中断を「呼び出し前」「結果取得後・保存前」「結果保存後・次工程前」で注入し、許可された工程だけ再開し、副作用を重複させないことを確認する。SDK 呼び出し自体の再実行と外部副作用の重複は区別する。
- 保存済みの旧形式は互換性 fixture で確認する。復旧不能なら変更や外部操作の前に具体的な理由で停止する。
- 隔離リポジトリで実モデルによる Research 修正、Think の Research 差し戻し、Build の review 修正を確認する。外部書き込みは stub とし、実 GitHub 操作が必要な確認は別途明示的な許可のある対象に限定する。
- 実測は model、reasoning effort、所要時間、取得できる token usage、修正回数、停止理由、状態・ログ・検証結果を記録する。unit test 合格と実モデルで観測できた範囲を分けて報告する。
- P6 完了時に独立レビューを実施し、静的検証と意味的レビューを通らない成果物が次工程へ進めないこと、および差し戻し後の再実行が親 LLM の指示待ちにならないことを確認する。

## 実装開始の手順

1. 本書を基に P0 の能力・互換性確認を行い、有限回数の初期値と状態移行方針を根拠付きで確定する。
2. 確認結果を Research として残し、Think で依存順の自己完結した Plan にする。
3. 明示的な公開許可があるときに Issue と canonical Plan を公開する。
4. 公開 Issue を根拠に P1 以降を順に Build する。各単位の検証完了後、次の Plan が現行リポジトリと一致するか確認する。

この計画が保証するのは検証と遷移の強制であり、LLM 判断の完全な正しさや有限回数での修正成功ではない。解消しない問題は証拠付きで停止し、許可と入力が揃った後に再開できることを完了条件とする。
