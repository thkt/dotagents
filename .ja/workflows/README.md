# Workflows

プロジェクトの成果条件は[.codex/OUTCOME.md](../../.codex/OUTCOME.md)に定義する。

## Flow

1. Research は repository と任意の外部証拠を 1 件の report にまとめる。
2. 完了した Research は、原典 report を指す topic 別 Knowledge 索引の再構築を試みる。
3. Think は明示的に選ばれた report と、Knowledge 索引で選ばれた最大 3 件の関連原典を読み、Plan または具体的な追加調査を返す。
4. Issue は読みやすい説明と 1 つの canonical Plan を公開する。作成と、選択済み Issue 全体の更新に対応する。
5. Build は選択された Issue を 1 回読み、1 人の actor が Plan 全体を実装・自己レビューする。test と独立レビュー後に 1 件の commit を作る。
6. Ship は明示的な承認がある場合だけ push と下書き PR 作成を行う。

Code は直接の変更依頼を受け、Build と共通の executor を Git action なしで使う。

## 契約の粒度

この節を Research・Think・Issue・Build・Code の共通方針とする。

契約には、観測可能な動作、許可する編集範囲、必要な外部互換性・永続データの互換性、安全条件、受け入れを確認する証拠を定める。正確な名前・型・field・format・algorithm は、明示した互換性または安全性の要件に必要な場合だけ指定する。それ以外の内部の型・関数・範囲内のファイル構成・algorithm は実装担当が選ぶ。Issue に全 TypeScript schema や API 名を列挙する必要はない。

Research は事実を確認し、未解決の事実上の主張を示す。未指定の実装上の選択は証拠不足ではない。Think は委譲に必要な外部要件と制約を確定し、実装上の選択を担当へ残す。その要件を変え得る、本当に未確定の事実は Research へ戻す。Issue はレビュー済みの同じ Plan を忠実に公開し、公開や翻訳で内部要件を追加しない。

Build と Code はこの区別に従い、認可された範囲で実装・自己レビューする。handoff を提案した場合だけ、返却前に独立した read-only review が、本当に契約外の設計判断または事実不足かを確認する。handoff が不要なら、その指摘を同じ実装 actor に返し、1回だけ修正する。unit stage や、成功した actor 呼び出しへの無条件の review は追加しない。確認された設計判断は Think、事実不足は Research に戻す。通常の実装上の選択と test failure はローカルの作業として扱う。現在の test・source・review・公開時の検証は維持する。

## Ownership

| Directory    | 責務                                         |
| ------------ | -------------------------------------------- |
| `research/`  | 証拠 report と、その派生 Knowledge 索引      |
| `think/`     | Plan の判断と追加調査の問い                  |
| `plan/`      | 共通 Plan の契約と検証                       |
| `issue/`     | 説明文と公開 Plan の公開                     |
| `build/`     | Issue 読み込み、検証、commit、Ship           |
| `code/`      | 直接の変更依頼の変換                         |
| `execution/` | Build と Code で共有する実装・検証・再開処理 |
| `runtime/`   | 起動承認、CLI 入出力、保存、host 環境        |
| `shared/`    | repository・model・schema・text の汎用処理   |

## Boundaries

- ユーザー入力は依頼と対象の選択を持つ。内部実行 record は持たない。
- workflow 契約と機械向け artifact は英語とし、Issue 説明文・表示する Plan Markdown・最終報告は設定言語を使う。
- 公開 Issue 内の唯一の JSON Plan を Build authority とする。Issue 作成時に ready Think Plan を title・prose に使う設定言語の `plan_markdown` へ忠実に翻訳し、全要件・identifier・file path・command を維持する。controller が Plan 見出しと変更のない canonical JSON block を追加する。翻訳表示を省略する既存 caller は英語描画を継続する。
- 任意の PR screenshot は Build の納品入力とし、公開 Plan authority に含めない。
- Research report は証拠記録であり、Knowledge は原典 report を指す再生成可能な索引である。日時は関連候補の順序付けに使い、現在の事実である証明にはしない。
- Build と Code は依頼全体を 1 人の actor で実装する。test または blocking review の失敗時は同じ実装工程へ戻り、test と review を再実行する。
- Plan unit は成果と受け入れ条件を整理する。actor 呼び出しの単位にはせず、レビューの証拠を編集範囲へ制限しない。編集は Plan 全体の許可範囲を守る。
- モデルは判断と指摘を返す。runtime が invocation と source を束縛し、モデルに controller の識別子や digest の復唱を要求しない。
- 1 件の invocation record が task、workflow、repository、外部書き込みの承認を持つ。入力ファイルは task 内で workflow ごとに分ける。hook は host identity を渡し、runner が入力検証、再開、停止理由の管理を行う。
- runtime の GitHub command は `shared/github.ts` に宣言する。shell test には GitHub credentials を渡さない。
- `codex-build` と `codex-code` は共通 executor の薄い adapter とし、一致する workflow binding だけを受理する。
- Issue 公開と Ship はそれぞれ明示的な承認を必要とする。Code は commit、push、PR 作成を行わない。
- 再開時は実行済み action の postcondition を照合し、二重適用を防ぐ。検証済み source と commit 対象の一致を確認する。
- 安定した判断は repository documentation に記載する。

## File naming

- `runner.ts` は workflow の公開 CLI 入口とする。
- 各 workflow の `manifest.ts` は入力を内部実行形式へ変換する。`execution/manifest.ts` は共通実装 step の構築と検証を持つ。
- `execution/engine.ts` は共有実行 loop、`actor-receipt.ts` は受理済み作業の receipt、`repository-isolation.ts` は sandbox と再開可能な変更適用を持つ。
- `research/knowledge.ts` は派生索引の更新と検索、`build/screenshots.ts` は画像の検証と納品をまとめて持つ。
- `runtime/storage.ts` は保存先、atomic write、artifact 命名を持つ。ソースの移動によって保存済みデータの場所は変えない。
- 独立した責務のない小さな helper は唯一の利用先に統合する。公開 CLI の入口は維持する。
- テストは検証する責務と同じディレクトリ名で分類する。

## Verification

`bun run check` を実行する。Bun 1.4.0 と `bun.lock` から依存関係も復元する場合は `bun run verify:clean` を使う。
