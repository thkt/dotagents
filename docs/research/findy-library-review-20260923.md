# Findy Library 日本語版の照合（2026-09-23）

出典は [Findy Library](https://lib.findy.co.jp/ja)。日本語版のナビゲーションに表示された27ページを、表示順に読んだ。以下はこのハーネスへの適用判断であり、原文の転載ではない。サイトは更新され得るため、ページ数と判断は確認日時の状態に限る。

[クイックスタート](https://lib.findy.co.jp/ja/quickstart)には、ページURLへ `.md` を付けると本文をMarkdownとして取得できると明記されている。URLの直接指定は閲覧ツールで失敗したが、表示ページの「マークダウンで表示」から[コンテキストエンジニアリング](https://lib.findy.co.jp/ja/ai/context-engineering.md)と[セキュリティ](https://lib.findy.co.jp/ja/ai/security.md)の生のMarkdownを開き、採用判断に関係する節を再確認した。他のページの照合は表示ページで行っており、全ページの両形式を機械比較したわけではない。

| 順 | ページ | このハーネスでの判断 |
| ---: | --- | --- |
| 1 | [ホーム](https://lib.findy.co.jp/ja) | 索引。個別の運用ルールはなし。 |
| 2 | [クイックスタート](https://lib.findy.co.jp/ja/quickstart) | 読み方の案内。個別の運用ルールはなし。 |
| 3 | [利用規約](https://lib.findy.co.jp/ja/terms-of-service) | 出典を明記し、内容を転載しない。本記録も要約と適用判断に限定する。 |
| 4 | [プルリクエスト](https://lib.findy.co.jp/ja/development/pull-request) | 小さな変更・レビュー可能性は既存のIssue/PR方針にある。 |
| 5 | [コードレビュー](https://lib.findy.co.jp/ja/development/code-review) | 機械判定と意味判断の分担、差分の自己確認は既存の独立評価・人のレビューにある。 |
| 6 | [タスク分割](https://lib.findy.co.jp/ja/development/task-breakdown) | 単独で検証・引き継げる範囲はscopingにある。 |
| 7 | [変更容易性](https://lib.findy.co.jp/ja/development/modifiability) | 変更・削除のしやすさは設計判断の観点として有用。今回、新たな一律ルールにはしない。 |
| 8 | [リファクタリング](https://lib.findy.co.jp/ja/development/refactoring) | 振る舞いの保証を保つ観点は既存方針にある。構造変更と振る舞い変更の常時分離は課さない。 |
| 9 | [パフォーマンス](https://lib.findy.co.jp/ja/development/performance) | 目標・ボトルネック・実測を先に確認する観点は既存の比較方針にある。 |
| 10 | [テスト](https://lib.findy.co.jp/ja/development/testing) | 要求から独立した期待値、検出したい欠陥、テスト費用は既存の開発方針にある。 |
| 11 | [CI/CD](https://lib.findy.co.jp/ja/development/ci-cd) | 必須checkと実行時間の扱いは既存方針にある。 |
| 12 | [リリース戦略](https://lib.findy.co.jp/ja/development/release-strategy) | プロダクトの段階的公開が中心で、現在のハーネス変更に追加する条件はない。 |
| 13 | [通知](https://lib.findy.co.jp/ja/development/notifications) | 通知が必要な状態だけ知らせる観点は参考になるが、今回のルール変更対象ではない。 |
| 14 | [生産性を測る理由](https://lib.findy.co.jp/ja/productivity/why-measure) | 件数や速度を成果そのものにしない。既存の品質・費用比較の判断と整合する。 |
| 15 | [Vibe Coding](https://lib.findy.co.jp/ja/ai/vibe-coding) | AI生成物の検証と証拠の提示は既存の実装フローにある。 |
| 16 | [コンテキストエンジニアリング](https://lib.findy.co.jp/ja/ai/context-engineering) | 恒久ルールは広く使い、実際の誤りを防ぐものに絞る。狭い対象の知識は該当箇所へ置き、機械的に保証できる事項を指示だけに任せない。新規ルールを選ぶ基準に採用する。 |
| 17 | [Agentic Workflow](https://lib.findy.co.jp/ja/ai/agentic-workflow) | 人と実行ホストの責任、権限、検証の分担は既存のハーネス設計にある。 |
| 18 | [Subagent](https://lib.findy.co.jp/ja/ai/subagent) | 委譲の目的・境界・成果の確認は有用だが、今回の共通ルール追加に固有の欠落はない。 |
| 19 | [Skill](https://lib.findy.co.jp/ja/ai/skill) | 短い発火条件と必要時に読む詳細は既存のスキル方針にある。 |
| 20 | [MCP](https://lib.findy.co.jp/ja/ai/mcp) | 接続手段の選択だけで権限・品質は保証されない。CLIからの移行条件は発生していない。 |
| 21 | [Plugin](https://lib.findy.co.jp/ja/ai/plugin) | 再利用が確認された機能の配布形態。現時点で新しいプラグインは不要。 |
| 22 | [セキュリティ](https://lib.findy.co.jp/ja/ai/security) | 資料中の指示は権限の根拠にしない。指示文は緩和策であり、ホスト側の権限・実行範囲の制約が中心。個別案の採否は本記録の全体判断から切り離す。 |
| 23 | [E2Eテスト](https://lib.findy.co.jp/ja/frontend/e2e-testing) | 少数の重要経路、状態待ち、失敗の扱いは既存のE2E検討下書きと照合済み。重複Issueは作らない。 |
| 24 | [データベース選定](https://lib.findy.co.jp/ja/backend/database-selection) | 対象プロダクト固有の判断。現在の共通フローに適用するルールなし。 |
| 25 | [データベース性能](https://lib.findy.co.jp/ja/backend/database-performance) | 対象プロダクト固有の測定。現在の共通フローに適用するルールなし。 |
| 26 | [モバイル技術選定](https://lib.findy.co.jp/ja/mobile/technology-selection) | 対象プロダクト固有の判断。現在の共通フローに適用するルールなし。 |
| 27 | [エンジニアリング文化](https://lib.findy.co.jp/ja/devrel/engineering-culture) | 組織・DevRelの話題。現在の実行ルールに追加する条件なし。 |

## 全体の判断

共通ハーネスのタスク分割、独立評価、人の承認、要求から独立したテスト、費用を含む比較、必要な資料の選択は、Findy Libraryの主要な観点とおおむね整合する。資料を根拠に新しい共通工程やルールを一括追加しない。特に、常設指示を増やすだけでは必要な情報が埋もれ、指示だけでは権限を制限できない。

再検討するのは、実際の見落としや誤操作が起き、その失敗条件を特定できたとき。まずコード・ホストの制約や既存の検証で防げるかを確認し、それでは足りない場合に限り、対象を絞ったスキルまたは短い共通指示を比較する。採用判断では、正常な要求の充足、失敗の検出、読み込み・運用の費用を併せて見る。この判断は今回の資料照合による方針であり、新しいルールの有効性を実測した結果ではない。
