## 目的と合意

過去の調査を使って要求や設計を見直す担当者が、読む場面に合う原文を選べるようにする。`research/README.md`へ3件の「読む条件と参照先」を短く追加する。

2026-09-20、依頼者は比較結果を確認したうえで索引ありを選び、3件・10行程度に絞る案に合意した。採用理由は読む条件と参照先の明示であり、速度・費用・検索品質の改善が実測で確立したという判断ではない。本Issueで要求を確定し、実装・独立評価・PRは後続のimplementへ引き継ぐ。

## 変更範囲

変更先は既存の`research/README.md`だけとし、次の3件を載せる。冒頭へ見出し、原文確認の短い案内、参照表を加える10行程度の案を基本とし、行数の厳密一致は要求しない。

| 読むとき | 参照先（research/からの相対パス） |
| --- | --- |
| 調査の根拠を実装・修正・独立評価・PR説明へ引き継ぐ方法を見直すとき | `context-handoff-73.md` |
| 独立レビューの分担や並列化を、過去の品質・時間・使用量と照らして判断するとき | `implement-review-foundation.md` |
| 調査成果の保存先や共有方法を変える前に、当時の背景を確認するとき | `scoping-research-storage.md` |

問いに該当する資料の原文を選び、対象版・確認結果・適用条件・未確認事項を現在の方針と照合するよう案内する。過去の調査を今回の合意や現行仕様として無条件に扱わず、索引に必要な資料がなければ既存の検索を続ける。

本文の結論・評価結果・版情報を索引へ複製しない。既存の保存・改訂・共有の説明と旧資料を保全する。AGENTS.md・スキル・runtimeの変更、全資料の必読化、自動索引・検索基盤、資料の一括移管は含めない。

## 根拠と比較の限界

参考は[agentic workflowの記事](https://blog.lai.so/agentic-workflow/)と[Whisttの読む条件を持つスキル](https://github.com/laiso/whistt/blob/main/.agents/skills/whistt-decisions/SKILL.md)。外部スキルの導入は行わない。

比較対象は公開commit [`d9dbf72446e7c2d80cd1d830d3c93933d92f35fc`](https://github.com/thkt/dotagents/tree/d9dbf72446e7c2d80cd1d830d3c93933d92f35fc)。現在の入口と3資料がこの比較版から変わっていないこともIssue作成前に確認した。原文は[引き継ぎ調査](https://github.com/thkt/dotagents/blob/d9dbf72446e7c2d80cd1d830d3c93933d92f35fc/research/context-handoff-73.md)、[独立レビュー比較](https://github.com/thkt/dotagents/blob/d9dbf72446e7c2d80cd1d830d3c93933d92f35fc/research/implement-review-foundation.md)、[保存先調査](https://github.com/thkt/dotagents/blob/d9dbf72446e7c2d80cd1d830d3c93933d92f35fc/research/scoping-research-storage.md)。

「資料を保存・指定できても後の担当へ根拠が届かない問題はあったか」を、同じcommit・質問・Codex CLI 0.155.1・gpt-6-astra/highの新規read-only実行で各1回比較した。変更は入口への3件の索引だけで、前の回答・個人メモリ・未commitの調査は渡していない。事前に定めた6観点を両方とも満たし、索引は読まれたが、主要資料は両条件とも最初の検索で見つかった。

索引なし／ありの順に、時間は121.568／132.020秒、コマンドは11／8回、入力tokenは246,727／252,481、キャッシュ入力は177,536／187,008、出力tokenは3,239／3,581だった。使用量はCLIが報告した実行全体の集計で、単一プロンプトの長さではない。請求額は未取得。固定順序・各1回・担当AIによる原文照合のため、安定した効果や一般的な検索精度を示さない。両実行とも正常終了し、予定した索引以外のソース変更はなかった。

比較の詳細・生ログはローカルで保持し、このIssueへは判断に必要な要約だけを記載する。ローカル資料の公開や移管を実装条件にしない。[#66](https://github.com/thkt/dotagents/issues/66)に残る`docs/evidence`全体の索引案と、[#141](https://github.com/thkt/dotagents/issues/141)のCodeGraph評価は本Issueの範囲へ含めない。

## 完了条件と検証

- [ ] 既存の調査入口に上記3件の読む条件と原文リンクがあり、対象版の各ファイルへ解決する。
- [ ] 各条件が原文の内容に合い、過去の記録と現行方針を区別できる。原文の版・適用条件等を確認する案内と、該当資料がない場合の検索を含む。
- [ ] 既存の保存・改訂・共有手順を維持し、索引への結論の複製、必読範囲や実行ゲートの追加、未確認の効果の断定がない。
- [ ] 差分・3リンク・案内文を原資料と照合し、既存の日本語確認と最終独立評価へ含める。

実装時は`.dotagents.json`に従って`bun install --frozen-lockfile --ignore-scripts`、引数なしの`bun run check`、独立評価、公開した同じPR headの`checks`・`verify`を確認する。文書案内だけの変更なので新しいテストや実モデル比較の再実行は要求しない。画面媒体は不要。人がレビュー・マージを判断する。

Issue本文は執筆担当が会話の合意、原資料、保存した比較結果と照合した。別評価者によるIssue本文の独立評価は未実施。今回の作業はIssue公開までで、実装待ちとして引き継ぐ。
