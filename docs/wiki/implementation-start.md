---
globs: ["scripts/implement/orchestrator.ts", "scripts/implement/research-handoff.ts", "scripts/implement/correction.ts", "scripts/implement/issue.ts", "scripts/implement/host-handoff.ts"]
scenes: ["plan", "implement"]
---

# 実装開始の条件

## 内容

このページはdotagentsの開始条件を説明する、手で更新する文書です。今回の要求と許可はIssueと合意記録、実行制御は信頼するホストが担います。必要な根拠は[報告参照の手順](../../scripts/README.md#調査報告を指定した実装開始)でpath・Git blob・開始commitを渡します。参照の一致は意味の正しさ、合意、公開許可を保証しません。文書のないrepoにwikiの作成を要求するものではありません。

新しいIssueの初回実装では、元checkoutの無関係な作業を保全し、起動時のHEADを開始commitに固定して隔離worktreeへ実装します。元checkoutは既存作業の場所、隔離worktreeは新しい成果物の場所です。開始時の未確認差分と、実装後の成果物差分を区別します。

## 開始時に照合する条件

- `.dotagents.json`はcheckoutルートの必須の通常ファイルです。commit・pushは任意で、リポジトリでの共有を推奨します。追跡済みなら開始commitの本文・index・モードとの一致を要求します。未追跡・ローカル除外の設定は開始時の原文をrunへ保存し、作業用worktreeへコピーします。実行中の差替えとindexへの追加を拒否し、ハーネスのcommit対象から除外します。選択した必要報告は引き続き開始commitの通常ファイルとして確認済みの内容・版と一致する必要があり、indexやモードの未コミット差分も停止条件です。
- 準備中のHEAD変更、必要入力の欠落・不一致、既存の保存先や同名branchとの衝突では開始しません。無関係な未コミット差分・未追跡ファイルは元checkoutへ残せます。開始のために一括commit・stash・削除はしません。
- 元checkoutでのsetup後と、隔離worktreeでのsetup後にも、必要入力とHEADを再照合します。setup成功だけでモデルを起動しません。
- ホストは対象repo、実効ユーザー、権限、公開先と設定した検証・必要媒体を照合します。AIは根拠の内容・適用条件・矛盾を調べ、要求・権限の変更は人の合意へ戻します。

[既存PRの修正](../../scripts/README.md#既存prの修正)では、前回の検証済み公開headと同じcheckout、設定原文が前回runと一致し、ローカル設定以外の追跡・未追跡差分のない状態、採用した修正依頼、新しい保存先を確認します。新規実装の隔離条件を流用せず、前回の開始commitと報告参照を維持します。報告を実装中に改訂した場合は、固定した開始版との差分として評価します。

[ホスト検証後の再評価](../../scripts/README.md#ホスト検証後の再評価)では、`host_verification_required`で停止したdevelopment runを明示します。担当AIが既存権限で追加検証を実行し、必要な要約・文書を更新してから、新しい保存先で通常checkと独立評価を行います。停止時のHEAD・branchと元の差分基準を維持し、同じcheckoutの未コミット成果物を引き継ぎます。初回実装の新規worktree作成や、公開済みPR修正のclean条件を流用しません。要求・主体・権限・設定・必要報告・停止記録と追加証拠を再照合し、過去の受入や証拠の成功申告を現在の成功と扱いません。旧runの再開・上書きはしません。

[初回不正評価後の新しい検証](../../scripts/README.md#初回不正評価後の新しい検証)は、未公開・有効な評価履歴なし・追加修正なしの初回`invalid_review`専用です。応答生成側を修正した信頼するハーネスから`--review-run`を使い、旧runと同じ親の新しい保存先で、同じcheckout・Issue・設定原文・実効主体・repository・HEAD・branch・元の差分基準・停止成果物・独立テストの内容とモードを照合します。初回実装を繰り返さず、新しいcheckと独立評価へ進みます。旧応答は診断資料として参照し、編集・補正して再投入しません。旧証拠記録の変更、active予約・lock・稼働プロセス、必要記録の欠落、不一致や照合不能では停止します。公開権限を判別できない旧記録は`--no-publish`に限定します。通常初回実装・ホスト追加検証後の復帰・公開済みPR修正の開始条件を混同しません。

[中断した初回評価の照合と新しい検証](../../scripts/README.md#中断した初回評価の照合と新しい検証)では、未公開・終端のverification中断で初回review予約が残るrunを明示します。通常初回とホスト復帰後を扱い、旧内容・モード・未完了の予約を保ったまま実プロセス・remote ref・全状態のPRを照合します。同じ要求・主体・checkout・HEAD・branch・差分基準・検証契約・公開権限を保ち、同じ親の新しい保存先で現在成果物をcheck・独立評価へ渡します。初回実装は繰り返さず、過去の成功・受入を移しません。中断分の不明時間・usageはゼロにせず、旧記録と今回分を区別します。復帰自身の再中断や他の未完了runを自動で飛び越えず、観測失敗や記録・対象・証拠の不一致で停止します。

## 過去の観測と未検証事項

2026-10-12の[Issue #373](https://github.com/thkt/dotagents/issues/373)のローカル試行では、基準commit `04892d99f070953b17525e9b2bdf1746c5aa8fff`から実装した#351の初回`invalid_review`を保全し、変更後のハーネスの通常CLIから新しい兄弟runで検証しました。Bun 1.4.2のcheckは605成功・失敗0、新しい独立評価は`accepted`・指摘0件で、4ステップの10参照が実在する行範囲を指していました。追加修正はありません。旧runは`invalid_review`・評価1回・追加修正0回・有効な評価履歴なしのままで、旧応答を有効な評価へ移していません。

ホストの保全監査は旧runの946ファイルの内容とモード、Issue本文、元の差分基準、成果物、独立テスト34ファイルの維持を確認しています。原資料はホスト保存の`351-final-audit-6.json`（SHA-256: `8275b2d1b4dc25e928929708cdf08d22788e5e39a426125efd0f3ba756e094a4`）と、新runのcheck・評価記録です。個人用生ログは公開repoに取り込みません。今回の実試行は、初回の旧run取込みで一覧取得のhash計算に使った本文を同じ取込み内の解析へ渡す修正と、準備済みテストの保存入力からの差分を原応答の申告と照合する修正を含みます。必要記録の欠落と意味の検査、取込み終了時と各工程の再照合は維持しています。実試行に使った制御コード37ファイルは、監査時の候補と内容・モードが一致しました。

#351の成功はローカル復帰に適用します。#351の設定にない準備済みテスト採用分岐や公開経路の実モデル成功には流用しません。準備記録の採用は、別の独立テスト工程で正常対照2件と必要な不一致拒否12件を再選定しました。公開CLIで採用・拒否理由、後続処理の抑止、旧runと外部原記録の保全を確認しています。原応答と成果物申告の由来が食い違う反例は修正前に受け入れられ、13成功・1失敗でした。保存入力からの差分と原申告を照合するガードを補った版では、ホストのBun 1.4.2で14成功・失敗0です。保留応答の昇格、固定Issue・対象ID・参照・原記録・hash・テスト内容・chmodの不一致も拒否しました。既存の停止・上限・保護テストは維持しています。この結果と文書を含む#373全体の受入は、最新runのcheckと独立評価で別に確認します。

#351のPR公開、AI E2E、共通登録の切替は実行していません。文書Issue1件の観測であり、実モデルの指示遵守・評価品質・時間・費用の一般的な改善は未確認です。

[当時の検証定義](https://github.com/thkt/dotagents/blob/765adbb29c51747b2d4ada473ca03a3e40ed7651/scripts/tests/development.test.ts)には、設定や必要報告のindexを変更した後、本文だけを元に戻しても停止する条件がありました。本文一致だけで開始可能とする説明ではこの条件を表せません。これは模擬コマンドと一時Git repoによる確認例であり、新しい実障害の報告ではありません。

[Issue #90の検証記録](../research/shared-knowledge-90.md)は当時の選択・生成機構の検証です。現在の操作や今回の実行結果として流用しません。準備や手戻りを減らす効果、実モデルの意味判断の品質、時間・費用の改善は未検証です。今回の機構廃止から効果を推定しません。反する観測があれば、影響する開始判断と出典を既存のfindings・assessmentsへ示し、事実不足は調査、条件・要求・権限の変更は人の判断へ戻します。

## 参照コード

- [development.ts](../../scripts/implement/orchestrator.ts) の `selectStart`・`verifyStartInputs`・`prepare`・`implement`：開始入力、setup前後、隔離先、実装直前の照合。
- [research-handoff.ts](../../scripts/implement/research-handoff.ts) の `verifyReportBase`・`verifyReports`・`researchContext`：報告の版照合と権限の区別。
- [revision.ts](../../scripts/implement/revision.ts) の `previousRun`、[correction.ts](../../scripts/implement/correction.ts) の `execute`：現行形式の保存記録と実行中の同一性を照合。
- [development.test.ts](../../scripts/tests/implement/development.test.ts)：必要入力・無関係な作業・setup後の変化の制御テスト。実モデルの効果測定ではありません。

- [host-handoff.ts](../../scripts/implement/host-handoff.ts)・[host-records.ts](../../scripts/implement/host-records.ts)：停止成果物と追加証拠の参照、復帰時の再照合。

- [interrupted-records.ts](../../scripts/implement/interrupted-records.ts)：中断runのモード・外部観測・追加証拠と明示した一件の照合。

- [review-recovery.ts](../../scripts/implement/review-recovery.ts)・[review-recovery-records.ts](../../scripts/implement/review-recovery-records.ts)：初回不正評価の復帰条件と旧記録の実行中照合。

## 由来

- [DR-0004](../decisions/0004-use-current-document-inputs-only.md)：現行形式だけを受け付ける判断。
- [DR-0003](../decisions/0003-retire-shared-knowledge-selection.md)：共有モデル選択を終え、説明をwikiへ集約した経緯。

## 根拠

- [Issue #406](https://github.com/thkt/dotagents/issues/406)（2026-10-18T12:19:47Z版）：終端中断の原記録保全と明示的な照合。#373の入口・ガードを維持し、別の新runで検証する合意です。実中断の復帰成功はホストの実行証拠で確認し、過去の#351の観測を流用しません。

- [Issue #373](https://github.com/thkt/dotagents/issues/373)（2026-10-11T11:01:13Z版）：評価応答の実在行番号確認と初回不正評価後の新runによる検証。実際の#351の復帰結果と適用限界は「過去の観測と未検証事項」に記し、手順の実装と実行証拠を区別します。

- [Issue #345](https://github.com/thkt/dotagents/issues/345)：2026-09-30T04:46:18Z版の合意。設定は必須のままcommit・pushを任意にし、開始時の固定条件と設定の非混入を維持します。確認版は`2f5cae9115fccc53a05134eec4d5a7601fb3b880`です。

- [Issue #315](https://github.com/thkt/dotagents/issues/315)：2026-09-28T06:46:20Z版の合意。通常経路に含まれないホスト検証の担当AIへの引き継ぎと、新しい記録での再評価。基点は`8d452eade4824e300b80b7b0b874595330976b53`。

- [Issue #265](https://github.com/thkt/dotagents/issues/265)：2026-09-24T17:36:37Z版の合意。Issue #265の開始commitは`104082c8b586681f8142a2097730df654ec743a0`です。
- [Issue #85](https://github.com/thkt/dotagents/issues/85)・[PR #89の採用commit](https://github.com/thkt/dotagents/commit/7c869f80bd95ea01b47e1ffd35f89e2899657bf2)：初回実装の開始条件の由来。過去の整理は#90の引用と採用コードに基づき、当時のPR本文・CIの再検証ではありません。
- [開始時点の旧原本](https://github.com/thkt/dotagents/blob/104082c8b586681f8142a2097730df654ec743a0/docs/knowledge/implementation-start.json)・[DR-0001](../decisions/0001-separate-requirements-from-evidence.md)：旧モデルの範囲・合意・仮説・観測と採用理由を辿るための履歴です。現在の開始条件は上記コードと今回の合意へ照合します。
