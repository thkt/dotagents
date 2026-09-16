# ワークフローの記録・引き継ぎ・再確認を整理する根拠

確認日: 2026-09-16。対象: thkt/dotagents、commit 674f1a773eb26773a53b789c3d84c47b414504f2。これは整理する範囲と根拠の報告であり、変更が実装済みであることを示す文書ではない。

## 問いと合意した範囲

内部記録とPR本文、scopingから実装への引き継ぎ、文章確認の対象選択、撮影の要否と再利用、十分性評価の操作量、検証結果の再利用条件、CIの待機と失敗、ホストという役割をどう整理できるかを検討する。

依頼者は2026-09-16にこの8項目を整理対象に選び、再利用を同じ実行内に限定した。公開用の本文と必要な根拠を日本語確認およびCodexでの意味照合を経て、4件の新規Issueへまとめる範囲に合意した。文章確認の対象選択には既存の[Issue #59](https://github.com/thkt/dotagents/issues/59)を使う。この合意には成果物の実装やマージは含まない。

## 確認した事実と整理する方向

| 対象 | 確認した現状 | 整理する方向 |
| --- | --- | --- |
| 内部記録とPR本文 | 評価要約には指摘履歴やホスト内の記録パスがあり、その要約がPR本文案へ転記される。後続の日本語確認後に何が実際に公開されたかを実測した結果ではない。 | 内部記録を保全し、公開用には変更理由、対象版の検証結果、重要な指摘への対応、未確認事項と残作業を選んで説明する。 |
| ホストという役割 | CLIの自動処理と、操作担当による媒体表示確認などが「ホスト」という同じ呼称に含まれる。 | CLI、担当AI、人の操作を関連手順で明示し、残作業の担当を追えるようにする。 |
| scopingから実装への引き継ぎ | 報告はresearch/へ保存するが、実装先はcleanなcommitted HEADから作る。未commitの報告を退避しても引き継がれない。 | Issue、必要な報告、開始commit、保存・共有状態を既存の正本参照で揃え、欠落や版の違いを開始前に検出する。 |
| 十分性評価 | noteによって評価が無効になり、assessで保存、gateで進行可否を確認する。現行方針は質問ごとの記録を進行条件にしていない。 | 判断に影響する根拠を区切りでまとめ、重複入力や逐次操作を減らす。全基準への評価と不足時の停止を維持する。 |
| 文章確認 | 現行実装は変更Markdownを拡張子で選択する。Issue #59では人向けMarkdownとIssue/PR本文のみを対象にする合意がある。 | Issue #59を再利用し、AI向け指示、fixture、非Markdownへの適用を追加しない。 |
| 撮影と結果の再利用 | 文章確認の入力照合、撮影済み対象の照合、公開前の成果物照合が既にある。撮影が再利用できても共通checkと独立評価は実施する。 | 同じ実行内で各確認の入力と無効化条件を揃え、再利用、不要、利用不能による未実施を区別する。 |
| CI | 必要checkの登録と実行を待ち、失敗や対象変更を検出する。開発CLIの最終結果では待機と失敗がまとめられる。 | 未登録、実行中、失敗、時間切れ、取得不能、対象変更を伝え分け、次に必要な対応を判断できるようにする。 |

## 分担と適用条件

新規Issueは、PR本文と担当、要求整理と引き継ぎ、撮影と同じ実行内の再利用、CI結果の区別の4単位とする。文章確認の対象選択はIssue #59に重複して作成しない。内容を変えない書式変更の許容を扱う[Issue #67](https://github.com/thkt/dotagents/issues/67)も独立した範囲のまま扱う。

文章確認キャッシュ、captureSource、snapshot、Gitによる調査報告の共有、既存の十分性CLIとCI判定を優先して使う。別の正本、全文書の一括監査、汎用の実行エンジンや新しいレビュー工程を作ることを要件にしない。

再利用の整理は同じ実行内に限り、別実行・PR差し戻し・中断復旧を接続しない。修正後に必要な共通checkと独立評価、同じPR headのCI成功条件、人の要求判断・レビュー・マージを維持する。停止済み記録や旧stateの削除・変換、実行上限の変更を含めない。

## 検証と未確認事項

既存のwriting-review、correction-capture、discovery、ci、review、developmentの制御テストを再利用できる。本文と根拠の変更、確認対象の追加、媒体の再利用と再撮影、根拠更新による評価の無効化、必要報告のGit経由の引き継ぎ、CIの未登録や対象変更などを検証する入口がある。

今回の根拠は現行コード・方針・Issue・テスト内容の照合であり、整理後の処理を実装・実測した結果ではない。変更後に必要な現実的な失敗条件を選び、検証定義の妥当性を独立評価する。処理時間や操作数の改善量は未計測である。共有報告の保存、commit、公開、および実装先への取り込みはそれぞれ区別して確認する。

## 出典

- [開発方針](https://github.com/thkt/dotagents/blob/674f1a773eb26773a53b789c3d84c47b414504f2/.codex/DEVELOPMENT.md)
- [制御CLIの手順](https://github.com/thkt/dotagents/blob/674f1a773eb26773a53b789c3d84c47b414504f2/scripts/README.md)
- [開発実行とPR本文生成](https://github.com/thkt/dotagents/blob/674f1a773eb26773a53b789c3d84c47b414504f2/scripts/development.ts)
- [独立評価と要約](https://github.com/thkt/dotagents/blob/674f1a773eb26773a53b789c3d84c47b414504f2/scripts/review.ts)
- [修正・撮影・再検証](https://github.com/thkt/dotagents/blob/674f1a773eb26773a53b789c3d84c47b414504f2/scripts/correction.ts)
- [文章確認と再利用](https://github.com/thkt/dotagents/blob/674f1a773eb26773a53b789c3d84c47b414504f2/scripts/writing-review.ts)
- [十分性の記録](https://github.com/thkt/dotagents/blob/674f1a773eb26773a53b789c3d84c47b414504f2/scripts/discovery.ts)
- [CIの待機と判定](https://github.com/thkt/dotagents/blob/674f1a773eb26773a53b789c3d84c47b414504f2/scripts/ci.ts)
- [調査成果の引き継ぎ](https://github.com/thkt/dotagents/blob/674f1a773eb26773a53b789c3d84c47b414504f2/skills/scoping/references/session.md)
