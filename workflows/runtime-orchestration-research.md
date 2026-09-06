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

P2 の最終 `bun run check` は 272 pass / 0 fail。実プロセスを調査 dispatch 前、候補保存後、監査前、監査保存後、公開状態保存後、JSON 保存後に終了して再開した。修正途中の文脈保持、2回の未受理 dispatch による再試行上限、競合所有、変更された入力・snapshot・dispatch の拒否、削除された live scope の snapshot による検証、保存先設定変更後の部分公開復旧も確認した。旧 Research Report を使う Think / Knowledge の既存テストを維持した。

PR #37 のレビュー後、完成直後の Markdown 二重書き込みと、完成結果の取得時に snapshot を要求する処理を修正した。正常な成果物は書き直さず、欠落した Markdown は snapshot なしで再生成する。Report の二重保存を除き、候補と固定生成日時から導出する Research state v2 に更新した。v1 は記録を保持して拒否する。2回目の Markdown 書き込みを失敗させる子プロセス検証、snapshot と live scope の削除後の取得、生成日時・JSON・mtime の保持、Markdown の欠落復旧、旧形式の拒否を deterministic tests で確認した。

追加の簡素化では、入力・intent・state の確認を pipeline の所有 lock 内に集約し、テスト専用の任意 context 経路を削除した。snapshot は再開用の保存先へ直接作成し、一時 snapshot からの全体コピーを除いた。重複した正常系・失敗系と固定の prompt 文言テストを、本番 runner 経由の境界検証と独立 SDK thread への入力確認に統合した。保存先の上書き拒否、未追跡・staged ファイルの保持、失敗時の上限・未公開、未対応 state の拒否を含めて deterministic tests で確認した。

## P3 Think — Issue #38

PR #37 マージ後の `63169c975b8dc2ebe76622930ea4c4abafdcab32` を基準に確認した。旧 Think は reviewer が最終 decision を生成し、Build 契約違反も同じ reviewer が修正していた。候補・根拠・途中状態は保持しなかった。

P3 では設計者が `ready` / `research_required` の候補を所有し、reviewer は条件・根拠付きの blocking / advisory findings を返す。静的検証と独立レビューが同じ候補に合格した場合だけ完成とする。静的・意味的な欠陥は最大3回設計者に戻し、応答不正・通信失敗は段階・候補ごとに1回だけ再試行する。保存された文脈を新規 SDK thread に渡す方式で、SDK session の継続は主張しない。

既存の SQLite 所有 lock と durable snapshot 作成を再利用した。Think 専用 state は開始時の入力識別・解決済み Research / Knowledge・snapshot・契約識別・候補・予算・公開先を保持する。再開時に live Research の変更・削除を採用せず、完成後は snapshot なしで同じ成果物を返す。工程間の自動起動は P4 の範囲である。

### 隔離した実モデル実測

調査用 fixture に `value.ts` と `.codex/OUTCOME.md` のみを配置した。model / effort は設計・レビューとも `gpt-5.6-sol/high`、read-only、外部情報なし、`caffeinate -i` 使用。実リポジトリのソースと外部公開操作は測定対象へ渡していない。

- 修正ケース: `1` から `2` への変更 Plan の初回 outcome を harness が `999` に置換した。独立 reviewer が要求との矛盾を指摘し、設計者が `2` へ修正して再レビューに合格した。`ready`、87,605 ms、設計2回・レビュー2回・修正1回。
- 事実不足ケース: 数値を決める外部 deployment contract が未提供という要求を与えた。設計者は必要な数値を具体的な質問として返し、独立 reviewer が不足の妥当性を確認した。`research_required`、37,868 ms、設計1回・レビュー1回・修正0回。
- usage: 共有 wrapper が公開していないため未取得。上記は特定 fixture の遷移観測であり、一般的な成功率ではない。
- 記録: `/private/tmp/dotagents-p3/measurement.json`、`measure.ts`、`measurement.log`。一時ファイルのため長期の観測記録は本書とする。実測後の入力識別・保存済み context 形式検証の補強は deterministic tests で確認する。

P3 の `bun run check` は 283 pass / 0 fail。静的・意味的失敗の設計者修正、独立した read-only SDK thread、未判定の上限、競合所有、候補受理の前後を含む8つの実プロセス中断境界、修正文脈と予算の再開、入力・snapshot・契約・dispatch の変更拒否を検証した。basename 指定と保存先設定の変更、Research / Knowledge の live 原本削除、完成済み成果物の mtime 維持と欠落 Markdown 復旧も確認した。既存 Issue の Think Report 消費テストを維持した。

## P4 工程間の差し戻し — Issue #40

PR #39 マージ後の `1d00c9b94a32f48745463f5920d7f9b550981559` を確認した。Think の調査要求と Build の独立レビュー済み handoff は次工程を実行せず停止していた。

P4 は保存された親の検証済み状態から、子工程の route・入力・snapshot を導出する。子の run は親と分離し、通常の CLI や新しい intent からは起動できない。親 runner だけが読み取り権限を渡し、root 全体で子 dispatch を最大2回に制限する。子の完了・親への採用は別々に保存し、再開時は同じ子を再利用する。

Think → Research → Think は採用した証拠で候補を作り直して独立レビューする。Build → Research は元の actor へ明示的な unknowns も含む証拠を戻す。Build → Think は修正案を保存して Issue 再公開待ちにし、元の Build は公開 Plan を読み直したり修正案を採用したりしない。Issue 公開・Ship の権限を子には渡さない。

途中状態は Think state v2 / execution revision 2 に更新し、未対応の状態は保持したまま復旧手順を示す。完成 Research / Think Report の形式は維持する。

戻り記録は子の識別・入力・照合情報を保持し、Report と error のコピーは保存しない。再開時は子工程自身の完了処理を通すため、入力改変・競合する JSON を拒否し、失われた JSON / Markdown をモデル再実行なしで復旧する。親 snapshot は子起動前と終了後に検証し、起動前の重複走査を除いた。戻り記録の形式は v2 とし、旧形式は保持して再開を拒否する。

### P4 の検証記録

`bun run check` は 295 pass / 0 fail（44 files）。Think の子予約前後・子 stage 完了後・親採用前後、Build の子完了後・提案採用後に実プロセスを終了し、同じ子の再利用とモデル・Issue 読み取りの非重複を確認した。未許可の子起動、入力混用、破損した戻り記録、親の変更、ネストした共通予算、明示的 unknowns の引継ぎ、pending Build の置換拒否も検証した。子完了後の入力改変・成果物欠落・JSON 競合についても、親が未検証の結果を採用しないことを確認した。

隔離実測は fixture のみを読み取り、GitHub はローカル stub、外部公開・Ship は禁止した。設計・調査・独立レビューは `gpt-5.6-sol/high`、Build actor は `gpt-5.6-luna/low`。`caffeinate -i` を使用し、usage は共有 wrapper から未取得。

- Think → Research → Think: 独立 Research で現行 export の値を確認してから Plan を作る要求を与えた。実モデルが調査要求を返し、独立レビュー済み Research を受けて再設計・再レビューし `ready` になった。135,824 ms、設計3回・Think review 2回・調査1回・監査1回、工程間の戻り1回。Think の静的修正1回を含む。
- Build → Think: `value.ts` の変更を要求しながら writable paths を `notes.md` に限定した public Issue fixture を使用した。actor と独立 handoff review が scope 決定の必要を確認し、Think が `value.ts` を許可する提案を作成した。提案の検証コマンドに対する静的・意味的修正を3回行い、最終的に独立レビューが合格した。263,607 ms、actor handoff 1回・設計4回・Think review 2回、工程間の戻り1回。旧 Build は `blocked / next_step: issue`、runtime failure なしで停止した。
- 最初の Build fixture はモデル起動前の975 msで `gate_mutated_repository` により停止した。同時刻の `.DS_Store` 出現を確認したため、非表示の新規 fixture で測り直した。前者は fixture の状態変化による停止として分離し、成功実測に含めない。
- 記録は `/private/tmp/dotagents-p4/measurement.json` と `measurement-build.json`、対応する `measure.ts` / `measure-build.ts` とログ。一時ファイルのため長期の観測記録は本書とする。測定は限定した事例であり一般的な成功率ではない。実測後の親からの入力導出の集約・pending handoff 置換防止・unknowns 引継ぎ・保存済み snapshot の同一性照合の整理は deterministic tests で検証した。

## P5 Issue 原稿の独立レビューと公開の再開 — Issue #42

PR #41 マージ後の `1c408bf3078cb618eefb85812e32db0afe96a3f7` を調査した。Issue は ready Think Plan の静的検証と同期公開を行っていたが、原稿の独立した意味的レビュー、担当者による修正、公開操作の途中再開はなかった。create の応答や後続 view が失われると、作成済みの Issue を runner が確定できなかった。

P5 は既存の原稿生成・GitHub adapter・SQLite ownership・read-only SDK を再利用し、Issue 専用の状態を追加した。初期原稿を検証・独立レビューし、blocking な表現の問題だけを原稿担当へ戻す。canonical Plan は固定し、その変更が必要なら Think で停止する。修正は最大3回、各モデル処理は最大2回で、保存済みの原稿・指摘・試行回数から再開する。

公開前に pending を保存する。create の URL が返れば view の前に Issue 番号を記録し、応答喪失後は既知の対象を照合する。番号さえ不明な create は再送せず、記録を保持して明示的な解決を要求する。update は既存 target の競合を検出し、照合で一致した場合だけ完了する。原稿生成を新 runner でも共有し、旧 helper だけを通る別の本番処理は追加していない。

### P5 の検証記録

`bun run check` は 309 pass / 0 fail（46 files）。production Issue runner で追加・省略・矛盾・翻訳による意味変更の修正と再レビュー、原稿担当と reviewer の SDK thread 分離、無許可・入力/Report/snapshot/preview の変更拒否、上限維持を確認した。実プロセスを review 前・review 保存後・公開前・pending write 保存後・create 番号保存後・完了後に終了し、既知の結果を照合して write を重複させないことを確認した。GitHub adapter の view が失敗する前に create 番号を保存する経路も検証した。

P4 の Build → Think → Research → Think が提案した変更を、明示許可した Issue update で再公開し、新しい明示許可の Build が変更後の public Plan を1回だけ読んで完了する接続を確認した。旧 Build の保存状態は同一 bytes のまま停止し、Issue から Build や Ship を自動起動しない。

最終コードの隔離実モデル検証では、canonical Plan が value 2 を要求するのに title/prose が value 3 を要求する fixture を与えた。`gpt-5.6-sol/high` の独立レビューが矛盾を検出し、原稿修正1回・独立レビュー2回を経て `completed` になった。22,922 ms、corrections 1、停止理由なし。`caffeinate -i` を使用し、GitHub はローカル stub、外部公開・Build・Ship は実行していない。usage は wrapper から取得できない。初回の同条件検証も21,325 msで同じ回数・結果となり、原稿生成処理を集約した後の最終コードで測り直した。

記録は `/private/tmp/dotagents-p5/measurement.json`、`measure.ts`、`model.log`。一時ファイルのため長期の観測記録は本書とする。実モデルで観測したのはこの限定した矛盾修正であり、意味的レビュー全般の正確性や成功率を保証するものではない。
