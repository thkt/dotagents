## 目的と実施順序

scopingの専用セッション・評価保存CLIを廃止し、要求整理を会話、既存のIssue下書き・Issue、必要なGit管理文書で完結させる。判断に必要な問いと不足時の停止を維持し、専用の状態管理と必須操作をなくす。

[#84](https://github.com/thkt/dotagents/issues/84)の専用校正廃止の後に実施する。旧計画の「CLIを残して任意化」は行わない。[#82](https://github.com/thkt/dotagents/issues/82)・[#85](https://github.com/thkt/dotagents/issues/85)・[#86](https://github.com/thkt/dotagents/issues/86)は、この2件の結果を見て必要性を再評価する後続候補とする。

## 廃止する責任と処理

- `discovery.ts`と`discovery-input.ts`を削除する。start・status・note・assess・gate・archive、SESSIONパス、revision、評価JSON、セッション用lock・一時ファイル・保存先bindingを新しい通常手順から外す。
- セッション開始の設定作成、判断ごとの全基準JSON保存、専用gateの実行、archive経由のコピーを進行条件にしない。別のCLI、必須の帳票、汎用状態管理へ置き換えない。
- `criteria.json`を機械入力として維持せず、六つの問いを既存の`sufficiency.md`などの短い判断基準へ集約する。JSONの版固定・入力検証が目的の処理とテストを削除する。
- scoping本文、参照手順、README、開発方針、CLI説明を新しい通常経路へ書き直す。過去の証拠文書と旧仕様へのGit参照は履歴として保持する。

## 新しい通常経路と残す判断

1. 担当AIが現在の依頼、Issue・下書き、関連コード・根拠を確認し、次に決めることと不足を整理する。目的、根拠、制約・代替案、不確実さ、整合、権限という六つの観点を使う。
2. 調べられる事実は調査し、意図・優先順位・許容範囲・権限は人へ確認する。不足や根拠の変化が判断を左右する場合は依存作業を止める。書式を埋めたことや保存成功を進行許可にしない。
3. 要求・完了条件・検証方法、合意の範囲と根拠、未解決事項、次の判断を、既存のIssue下書きまたはIssueに必要な範囲で更新する。質問ごとの転記、会話全文、機械用の別正本は作らない。公開前の下書きはローカルで扱い、公開権限を拡大しない。
4. Issueの記述と出典リンクで足りる場合は報告書を作らない。再利用する根拠や長い検証結果などが必要な場合はresearchへ直接保存・改訂し、既存内容、差分、版、共有範囲を確認する。既存ファイルを無確認で上書きしない。
5. 中断や担当交代では、Issue・下書きの決定、参照、不足、次の判断から再開する。現在のコード・要求に照らして再評価し、前回の完了表示を自動で引き継がない。新しい再開台帳を作らない。
6. 合意した要求をIssueへ反映し、対象repo・主体・権限と公開本文を照合する。必要報告を使う場合は、確認済みblobと開始commitを照合する既存のresearch-handoffを維持する。

## 失う機械的な確認と保全

全基準の入力漏れ、評価revisionの不一致、専用セッションの保存先bindingなどをdiscovery CLIで拒否する検査は終了する。その機械的な保証を保持したとは説明しない。要求の十分性と根拠の鮮度は担当AIが判断し、重要な判断と権限は人へ戻す。実装入口のIssue・報告版・公開対象の照合と最終独立評価は維持する。

既存セッション、lock、保存済み評価、research、生ログ、worktreeは削除・変換しない。旧セッションは参照資料として必要な事実だけ読み、旧CLIの実行や評価の自動移行を新しい通常経路にしない。進行中の旧タスクは内容と所有者を確認し、途中で実行コードを差し替えない。共通スキルへの切替と復帰は既存の保全方針に従う。

## 完了条件

- [ ] 専用2ファイルと機械入力の基準JSONが削除され、scopingは専用状態・gate・archiveなしで合意済みIssueまで到達する。
- [ ] 小さな既知の変更、判断を左右する不明点、根拠変更、中断・担当交代の代表例で、必要な問い・停止・決定の参照・再評価を新しいタスクから確認できる。
- [ ] 必要な報告の出典・対象版・適用条件・合意状態・未確認事項と、開始commitへの受け渡しを維持する。不要な報告や全文コピーを要求しない。
- [ ] 廃止したCLIの操作例が現行手順として残らず、代替の状態管理CLIや互換実行経路を作らない。旧記録は変更しない。
- [ ] discovery専用テストを削除し、実装入口・Gitによる報告版の照合・公開権限など残る保証のテストを維持する。スキル本文の文字列一致だけのテストで置き換えない。
- [ ] 実装・テストとも総量を純減させる。専用2ファイルは調査版で合計311行。六つの問いは消さず、通常の判断基準として残す。

## 既存Issueとの分担

[#64](https://github.com/thkt/dotagents/issues/64)のresearchでの共有と既存内容の保全を維持し、専用archiveを終了する。[#70](https://github.com/thkt/dotagents/issues/70)の全項目JSON・revision検査を終了するが、必要報告の版照合と不足時の停止は維持する。[#73](https://github.com/thkt/dotagents/issues/73)の出典・版・適用条件・合意の連続性を、Issueと既存文書の参照で保つ。

## 検証と引き継ぎ

対象は `thkt/dotagents`。セットアップは `bun install --frozen-lockfile --ignore-scripts`、提出前は引数なしの `bun run check`。必要な独立評価と同じPR headの `checks`・`verify` を確認し、人がレビュー・マージを判断する。プロダクト画面媒体は不要。共有が必要な根拠は `research/`、内部の実行記録は既存のcheckout外保存先に置く。

削除した機能だけを守るテストは削除する。残る要求の検出条件は既存テストへ集約し、削除で失う検出条件と代替の確認をPRに説明する。模擬コマンドのテスト、新しいタスクでの手順確認、実モデルの意味判断、実際のGitHub公開を区別する。テスト件数の維持や専用の計測基盤を要求しない。

実装コード・テスト・設定・実行分岐・必須操作について変更前後を示し、実装コードとテストの総量が純減していることを確認する。ファイル移動、圧縮、型検査の回避で量だけを減らす変更は含めない。必要な保証を失って数値を達成しない。

## 根拠と合意

確認日: 2026-09-17。調査版: `0b3c61115337c15f14db41ea8f3fee5291497e45`。

- [scripts/discovery.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/discovery.ts)
- [scripts/discovery-input.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/discovery-input.ts)
- [skills/scoping/SKILL.md](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/skills/scoping/SKILL.md)
- [skills/scoping/references/criteria.json](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/skills/scoping/references/criteria.json)
- [skills/scoping/references/sufficiency.md](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/skills/scoping/references/sufficiency.md)
- [skills/scoping/references/session.md](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/skills/scoping/references/session.md)
- [scripts/research-handoff.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/research-handoff.ts)
- [.codex/DEVELOPMENT.md](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/.codex/DEVELOPMENT.md)

依頼者は、従来の任意化案ではコード量が増える可能性と、専用校正・discoveryの役割を既存工程へ集約する案を確認した後、scopingで「運用とコードの両面でソリッドにする計画にして進めたい」と指示した。このIssueはその計画変更を反映する。旧本文の任意化と現行機能の併存は採用しない。

要求の正本は本Issue。根拠は本文と上記のコミット済み参照で足りるため、追加の必須調査報告はない。ローカルの計画・下書きは未コミットで、実装入力の前提にしない。実装開始時は先行変更を含む採用済みHEADで根拠を再確認し、開始commitを固定する。今回の作業は計画とIssue更新までで、実装・PR・マージは未実施。
