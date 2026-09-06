# runtime orchestration の事前確認

確認日: 2026-09-06。対象 HEAD: `6421ea78addb0329935c3a37cbbfd7a7c758a623`。

## 結論

SDK を継続利用して、runtime が担当の起動と追加指示を制御できる。同一プロセス内の継続は確認済み。プロセス終了後は保存済みの成果物と修正指示から新しい thread を起動する方式を初期実装に採用する。

## 実測

`@openai/codex-sdk` のインストール済み実装を使用。model は `gpt-5.6-luna`、reasoning effort は `low`。専用の一時 Codex home、読み取り専用の一時ディレクトリ、ツール利用不要の marker 記憶課題で確認した。

| 操作                                            | 結果                        | 所要時間 |
| ----------------------------------------------- | --------------------------- | -------- |
| 新規 thread で marker を返す                    | `cedar-472`、構造化応答成功 | 5,760 ms |
| 同一 thread に追加指示                          | marker を保持               | 4,627 ms |
| 同一 home の新しい SDK client で `resumeThread` | marker を保持               | 3,941 ms |
| 別 thread の開始イベントで AbortSignal を発火   | `AbortError [ABORT_ERR]`    | 未計測   |

3 応答の SDK usage は順に input tokens 9,562 / 9,596 / 9,630、cached input tokens 0 / 8,960 / 8,960、output tokens は各 18。中断した呼び出しの usage は未取得。

生の実測記録とスクリプトは `/private/tmp/dotagents-orchestration-p0/results.json` と `probe.ts` に保存した。一時ファイルであり、長期的な実装根拠は本書に記録した観測内容と repository source とする。credentials は記録していない。

別 OS process での resume、OS による書き込み拒否、通信断からの回復、長時間実装の収束は今回の marker 課題では未検証。読み取り専用設定を渡したことと隔離を実測で破れないと確認したことは区別する。

## source で確認した境界

- `shared/codex.ts` の `CodexClientLike` は `startThread` と `run` のみ公開する。stream の `turn.completed` がない場合は成功にしない。
- `shared/codex-home.ts` は client の専用 home を作成し、親 process の exit で削除する。home を保存しないまま thread ID だけ保存しても、process 終了後の resume の根拠にならない。
- SDK の型定義は `Thread.id`、`resumeThread`、`TurnOptions.signal` を公開する。[公式 SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) も thread の継続と resume を説明する。SDK の能力と現在の wrapper の公開範囲は異なる。
- `execution/manifest.ts` の既存修正上限は 3。`controller.ts` は gate ごとの回数と失敗理由を保存する。
- `execution/engine.ts` の `runWorkflow` は保存状態を開始・再開して loop を駆動する。run 全体の排他所有を取得する処理はこの入口に存在しない。
- `runtime/invocation.ts` は明示的な工程呼び出しを task・repository に結び付け、Issue と Ship の許可を検証する。自動的な前工程呼び出しはこの入口とは区別した内部 binding が必要。
- `research/pipeline.ts` は一巡の investigate / audit、`think/pipeline.ts` は design 後に reviewer への限定的な再要求を行う。工程別に候補と修正状態を保存する機能が必要。

## 初期実装の判断

- 修正は既存と合わせて各工程で最大 3 回。未判定の一時的再試行は最大 1 回、工程横断の戻りは親 run 全体で最大 2 回とする。後二者は性能の実測値ではなく、初期の暴走防止の設計値。上限を状態に保存し、resume で暗黙にリセットしない。
- reviewer は worker と別 thread とし、採用候補を直接変更させない。再試行時に合格扱いの fallback は設けない。
- プロセス終了後の担当は新規 thread に保存済み入力・候補・未達条件を渡す。SDK session の継続を偽装せず、再構成したことを記録する。
- 新しい永続 record は形式を識別可能にし、不整合な旧 active record は副作用前に拒否する。旧状態は削除せず、元の実行環境で完了・cancel するか、確認後に新規 run を開始する経路を示す。
- プロセスが生存している場合の競合実行は拒否する。中断の検出だけで外部操作を無条件に再送しない。

## 開始時の repository 状態

未コミット差分は `workflows/runtime-orchestration-plan.md` のみで、余計な変更は存在しなかった。stash は作成していない。`codex/validate-actor-handoffs` から `codex/runtime-orchestration` を作成した。基点の PR #33 は確認時点で OPEN のため、この実装はその変更に依存する。

PR 作成時点では PR #33 はマージ済み。`main` と作業ブランチを merge commit `27474fe01eb5ee7df555cf61e99faf351d067918` に揃え、P1 差分を保持した。ブランチ整理用の一時 stash は復元・削除済みで、既存の過去作業の stash は保持した。

## P1 の実モデル検証

実装根拠は [Issue #34](https://github.com/thkt/dotagents/issues/34)。専用の一時リポジトリで Code の共有 executor を実行した。actor は `gpt-5.6-luna/low`、独立 reviewer は `gpt-5.6-sol/high`。

初回 actor の返却後に測定側が `value = 1` へ意図的に戻した。型だけを確認する shell test は合格したが、実モデル reviewer が「要求は正確に 2」との不一致を blocking finding として返した。runtime は `semantic_review_failed` を付けて担当を再実行し、`value = 2` へ修正、shell test と独立レビューの両方が合格して完了した。

- 所要時間: 105,311 ms。
- actor: 2 回。reviewer: 2 回。review 差し戻し: 1 回。
- 最終結果: `completed`、exit code 0、`export const value = 2;`。
- Git 操作: fixture 作成のみ。Code 内の Git action 呼び出しは例外にする adapter を使用し、呼び出しなし。
- usage: 共有 wrapper が公開していないため、この実測では未取得。
- 記録: `/private/tmp/dotagents-orchestration-p0/p1-measurement.json`、再現スクリプト: 同ディレクトリの `measure-p1.ts`。

これは実装成功率の比較実験ではなく、意図的な欠陥注入に対して実モデルのレビュー・修正・再検証がつながることの観測である。

実リポジトリ差分全体を外部 SDK reviewer に渡す追加レビューは自動承認レビューに拒否され、実行していない。理由は具体的な source payload と送信先への明示承認不足。差分自体は現在のセッションでローカルレビューする。

## P2 の実装と検証

実装根拠は [Issue #36](https://github.com/thkt/dotagents/issues/36)、調査基準は PR #35 マージ後の `6133597b5cce4094ba37e95518a9a608430495fc`。既存の監査が Report を書き換える処理を、調査担当による完全な候補作成と、独立監査による根拠付き指摘へ分離した。完成 Report の JSON 形式は維持する。

保存状態は Research 専用で、P1 の task 排他所有と既存の snapshot・source seal・atomic write を再利用する。最大3回の修正と、段階・候補ごとに最大1回の未判定再試行を保存する。プロセス終了後も同じ snapshot と候補を使い、公開前に保存先を固定して JSON と Markdown の部分保存から復旧する。SDK session の継続は主張しない。

隔離した `value.ts` の実モデル実測では、調査担当の初回候補の answer だけを測定側で「1」に置換した。静的な引用検証を通過した後、独立監査が source の `42` との矛盾を blocking finding として指摘した。runtime は候補と指摘を調査担当へ返し、`42` への修正と再監査を経て完成した。

- model / effort: 調査・監査とも `gpt-5.6-sol/high`（既存 Research の設定）。
- 所要時間: 52,898 ms。調査2回、監査2回、修正1回。
- 結果: `completed`、完成 Report の answer は `42`、根拠は `value.ts:L1`。
- usage: 共有 wrapper が公開していないため未取得。
- 再現条件: 専用の一時 Git repository に `export const value = 42;` と fixture 用 `.codex/OUTCOME.md` のみを配置し、外部資料を無効化。実リポジトリのソースはモデルへ渡していない。実行中は `caffeinate -i` を使用。
- 記録: `/private/tmp/dotagents-p2-measure/result.json`、スクリプト `measure.ts`、ログ `output.log`。一時ファイルのため長期の観測記録は本書とする。

最初の fixture は必須 OUTCOME がなく、モデル呼び出し前に停止した。上記は fixture を補完した後の成功実測であり、最初の295 msの停止や、一般的な成功率とは区別する。この実測後に追加した task binding と保存先の固定は deterministic な再開テストで検証する。

P2 の最終 `bun run check` は 278 pass / 0 fail。実プロセスを調査 dispatch 前、候補保存後、監査前、監査保存後、公開状態保存後、JSON 保存後に終了して再開した。修正途中の文脈保持、2回の未受理 dispatch による再試行上限、競合所有、変更された入力・snapshot・dispatch の拒否、削除された live scope の snapshot による検証、保存先設定変更後の部分公開復旧も確認した。旧 Research Report を使う Think / Knowledge の既存テストを維持した。

PR #37 のレビュー後、完成直後の Markdown 二重書き込みと、完成結果の取得時に snapshot を要求する処理を修正した。正常な成果物は書き直さず、欠落した Markdown は snapshot なしで再生成する。Report の二重保存を除き、候補と固定生成日時から導出する Research state v2 に更新した。v1 は記録を保持して拒否する。2回目の Markdown 書き込みを失敗させる子プロセス検証、snapshot と live scope の削除後の取得、生成日時・JSON・mtime の保持、Markdown の欠落復旧、旧形式の拒否を deterministic tests で確認した。
