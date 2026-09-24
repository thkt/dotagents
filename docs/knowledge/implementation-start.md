# 実装開始の目的・概念・規則

正本: implementation-start.json / Git blob: f0ce4423369ef041f5ec2e441a3f5dab33b645aa / この表示に含むID: preserve-work, start-objects, authority, start-identity, isolation, setup-recheck, less-rework, index-counterexample, revisit-identity

適用範囲: thkt/dotagentsで新しいIssueの初回実装を始める際の条件を中心に扱う。#85・PR #89を採用した#90の内容に基づく。既存PRの修正では各定義の適用条件を確認し、初回実装の隔離条件を流用しない。

これは対象repoの知識です。今回の要求・許可はIssueと合意記録、実行制御は信頼するホストが担当します。形式照合は意味・合意・効果を保証しません。関係先のIDは参照であり、未選択の定義を要求へ追加しません。

## preserve-work — 目的（合意済み）

分類: teleology / purpose / agreed

確認した要求と開始条件で実装し、今回無関係な作業を失わない。開始のためだけの退避・準備・やり直しを減らす。

問い直す前提: 誰の作業を保全し、どの準備が実装開始に本当に必要か。

適用条件: dotagents自身の実装開始。アプリ固有の知識や全repoへのモデル整備要求は含めない。

根拠: issue-90, issue-85

関係: preserve-work → start-identity: 必要入力の確定で支える

関係: preserve-work → isolation: 他の作業を保全する

関係: preserve-work → less-rework: 期待する効果は未計測

## start-objects — 概念（合意済み）

分類: ontology / concept / agreed

元checkoutは既存作業の場所、開始commitは実装元の版、隔離worktreeは新しい成果物の場所である。対象設定は実行・検証方法、選択した必要報告とモデルは根拠であり、Issueと合意記録が今回の要求と許可範囲を定める。

問い直す前提: 本文、Git index（ステージ領域）、モード、HEAD、場所、参照一致と要求合意を同じものとして扱っていないか。

適用条件: development入口。修正中の成果物差分と開始時の未確認差分を区別する。

根拠: issue-90, start-code, reference-code

関係: start-objects → start-identity: 版と場所を照合する

関係: start-objects → authority: 内容・合意・実行を区別する

## authority — 規則（合意済み）

分類: ontology / rule / agreed

機械はID・関係・参照・版と既存Git条件を照合する。AIは内容、適用条件、矛盾と追加根拠を独立に調べる。人は目的・許容範囲・要求・権限の重要な変更を判断する。報告やモデルの参照一致は要求の合意ではない。

問い直す前提: 形式の成功を意味の正しさや人の合意へ読み替えていないか。

適用条件: モデルは対象repoの知識でありホスト制御ではない。改訂だけで実行権限・停止条件・予算・Issue合意範囲を変更しない。

根拠: issue-90, reference-code

関係: authority → start-objects: 責任と対象を区別する

関係: authority → revisit-identity: 不一致の戻り先を判断する

## start-identity — 規則（合意済み）

分類: nomology / rule / agreed

開始HEAD、.dotagents.json、選択した必要入力を照合する。必要入力は開始commitの通常ファイルで確認済みblob・checkout本文が一致し、Git indexやモードを含む未commit差分がないことを要求する。欠落や違いでは停止し、未確認のIDへ差し替えない。報告を指定するCLIでは--start-commitも必要である。

問い直す前提: 本文一致だけで開始可能と説明すると、どの版や状態の違いを見落とすか。

適用条件: 開始時の選択済み入力。必要報告も開始commit指定もない入口では起動時HEADを使う。モデル選択はIssueの版付き参照から取得する。

根拠: issue-90, issue-85, start-code, reference-code

関係: start-identity → start-objects: 照合する版・場所

関係: start-identity → index-counterexample: 本文だけでは不足する確認例

関係: start-identity → setup-recheck: 異なる時点で同じ条件を確認する

## isolation — 規則（合意済み）

分類: nomology / rule / agreed

照合済み開始commitから隔離worktreeを作る。元checkoutの無関係な追跡差分・未追跡ファイルは内容、モード、追跡状態を保ち、隔離先へ移さない。開始のためのstash、reset、clean、一括add、無関係な差分のcommitを要求しない。

問い直す前提: 必要入力の確定のために、無関係な作業まで退避やcommitを強いていないか。

適用条件: 新しいIssueの初回実装。既存runや同名branchは再利用せず、旧記録を変換・削除しない。既存PRを修正する実行には適用しない。

根拠: issue-85, issue-90, start-code, pr-89

関係: isolation → preserve-work: 保全する目的

関係: isolation → start-identity: 隔離元を確定する

## setup-recheck — 規則（合意済み）

分類: nomology / rule / agreed

隔離先で設定済みsetupを順に実行し、担当AIの起動前に元checkoutのHEAD・設定・必要入力と隔離先の開始入力を再照合する。準備・setup中の変化も停止対象とする。

問い直す前提: 準備前の成功をsetup後へ流用していないか。

適用条件: 準備前後とsetup後は異なる時点の検査であり、抽出の集約を理由に削らない。

根拠: issue-90, start-code

関係: setup-recheck → start-identity: 同じ必要入力の条件

関係: setup-recheck → isolation: 元checkoutと隔離先の両方

## less-rework — 仮説（未検証）

分類: teleology / hypothesis / unverified

開始のための準備が減れば、時間や手戻りも減る可能性がある。改善値は未計測であり成功条件や必須ゲートへ変換しない。

問い直す前提: 作業を移しただけではないか。時間や手戻りの改善は実際に観測されたか。

適用条件: 目的との関係を示す仮説。実モデル・利用者の操作時間の実測は未実施。

根拠: issue-90

関係: less-rework → preserve-work: 期待する望ましい状態

## index-counterexample — 観測（確認済み）

分類: nomology / observation / observed

採用済み検証定義には、必要報告や設定のGit indexを変更した後で本文を元へ戻しても停止するケースがある。本文一致だけで開始可能という説明ではこの条件を表せない。これは既存検証条件による確認例であり、新しい実障害の発生報告ではない。

問い直す前提: 観測した検証条件から、どの概念や規則の説明不足へ戻れるか。

適用条件: start-testsのconfig_index・report_index。今回の実行結果は対象差分の検証記録で別に確認する。

根拠: start-tests, issue-90

関係: index-counterexample → start-identity: 本文・Git index・モードを含む説明が必要

関係: index-counterexample → start-objects: 本文とGit indexの区別

関係: index-counterexample → revisit-identity: 結果から前提を見直す

## revisit-identity — 提案（提案中）

分類: nomology / proposal / proposed

本文一致だけを開始可能と説明する資料が見つかった場合、index-counterexampleの条件と実行結果を示し、start-identityとstart-objectsへ戻って説明の修正差分を提案する。事実不足は追加調査へ、停止条件や要求・権限を変える案は人の判断へ返す。モデルを自動改訂・自動承認しない。

問い直す前提: 反する結果が説明不足なのか、適用範囲の違いなのか、規則を変更すべき根拠なのか。

適用条件: 既存のIssue・Git差分・findings/assessmentsで扱う。新規台帳は作らず、変更前の評価を変更後へ流用しない。

根拠: issue-90, start-tests

関係: revisit-identity → index-counterexample: 見直しの根拠

関係: revisit-identity → start-identity: 影響する開始判断

関係: revisit-identity → authority: 調査と人の判断を分担する

## 根拠の参照

- issue-90: [出典](https://github.com/thkt/dotagents/issues/90) / 版: updatedAt 2026-09-17T11:38:02Z（実装依頼で提示された本文） / agreed / 適用: 初回対象、#85の採用済み要求と共有モデルの範囲。モデル作成時は#85・PR #89をIssue #90の引用と採用コードで照合

- issue-85: [出典](https://github.com/thkt/dotagents/issues/85) / 版: PR #89 採用commit 7c869f80bd95ea01b47e1ffd35f89e2899657bf2 / agreed / 適用: 開始条件の合意への参照。モデル作成時はIssue #90の引用と採用コードで照合

- pr-89: [出典](https://github.com/thkt/dotagents/pull/89) / 版: 7c869f80bd95ea01b47e1ffd35f89e2899657bf2 / observed / 適用: 採用commitのmerge履歴と差分。PR本文や当時のCI結果の検証根拠ではない

- start-code: [出典](https://github.com/thkt/dotagents/blob/765adbb29c51747b2d4ada473ca03a3e40ed7651/scripts/development.ts) / 版: 765adbb29c51747b2d4ada473ca03a3e40ed7651 / observed / 適用: prepare、verifyStartInputs、implementの実行条件

- reference-code: [出典](https://github.com/thkt/dotagents/blob/765adbb29c51747b2d4ada473ca03a3e40ed7651/scripts/research-handoff.ts) / 版: 765adbb29c51747b2d4ada473ca03a3e40ed7651 / observed / 適用: verifyReportBase、verifyReports、researchContextの参照と権限の区別

- start-tests: [出典](https://github.com/thkt/dotagents/blob/765adbb29c51747b2d4ada473ca03a3e40ed7651/scripts/tests/development.test.ts) / 版: 765adbb29c51747b2d4ada473ca03a3e40ed7651 / observed / 適用: 模擬外部コマンドと一時Git repoによる保全・開始停止の検証定義。実モデルの意味判断や時間削減の実測ではない
