# scopingでIssueの成果単位と依存理由を明示する

## 目的と状態

複数Issueへ分ける要求整理で、それぞれの成果・検証・先行条件を対応させ、個別の作業が終わっても要求全体を確認できない分割や、不要な着手待ちを避ける。

2026-09-20、mattpocock/skillsの観点を既存Issueへ追加したりIssue化を検討する依頼を受けた下書き。範囲・完了条件は担当AIの提案であり、採用・実装は未合意、Issueは未公開。既知の障害の修正や効果の実証を主張するものではない。

## 現状と追加する観点

dotagents `a3f985bb90551b2eaea99126b4ed03e2dc64848c`の[scoping](https://github.com/thkt/dotagents/blob/a3f985bb90551b2eaea99126b4ed03e2dc64848c/skills/scoping/SKILL.md)と[Issue反映手順](https://github.com/thkt/dotagents/blob/a3f985bb90551b2eaea99126b4ed03e2dc64848c/skills/scoping/references/issue.md)は最小案・完了条件・検証・合意を扱うが、複数Issueの分割基準は具体化していない。

[to-tickets](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/to-tickets/SKILL.md)の、単独で確かめられる成果と本当に必要な先行条件を対応させる見方を使う。[to-spec](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/to-spec/SKILL.md)の、利用者の問題・検証・対象外を一緒に具体化する観点も同じ分割判断へつなぐ。

## 範囲と完了条件

- [ ] 複数Issueへの分割が必要な場合だけ、各Issueで確認できる成果と完了条件を示す。技術層の区切りだけで完成を定義せず、文書・CLI・調査を含め、その要求に合う検証可能なまとまりを選ぶ。
- [ ] 先行Issueに依存する理由と必要な成果物・状態を示し、希望する実施順序と区別する。先行Issueのclosed表示だけで満たされたとせず、着手先の版で必要な成果が使えるかを確認する。
- [ ] 元の要求・共通制約と各Issueの対応を辿れるようにし、分割で残る統合確認の範囲と担当を明らかにする。分割により調整・統合の負担が増えるならまとめる案も比較する。
- [ ] 小さな変更を無理に分割せず、横断的な変更の段階移行も必要な場合だけ選ぶ。必要な合意、個々の検証、ホストの実行・公開条件を維持する。

主な変更先は`skills/scoping/references/issue.md`。scoping本文は必要な参照だけ、代表例は既存のscoping手順確認へ統合する。新しいtracker・親子Issueの強制・依存実行runtime・ラベル・固定のIssue数・コンテキスト窓による上限は追加しない。

## 確認例と検証

以下は判断用の例であり、既存Issueの範囲を変更する指定ではない。

- 保存済み結果の表示なら、「1回分を読み、成功・失敗と根拠を確認できる」成果を一つの単位として検討する。自動更新が別要件なら、その依存理由と独立性を確認する。
- ドキュメントのリンク修正など、一つで検証・レビューできる小変更では分割しない。
- 複数の変更が共通形式へ移行する場合、途中の版で成立する条件と最後に残る統合確認を示す。作業件数の消化だけで要求充足としない。

採用候補の版を固定し、既存のscoping手順確認で判断と分割案を照合する。文字列一致テストやIssue件数を良い分割の証拠にしない。実装時のセットアップは`bun install --frozen-lockfile --ignore-scripts`、提出前は`bun run check`、既存の独立評価・日本語確認、同じPR headの`checks`・`verify`を使う。追加の実モデル比較基盤や商品画面媒体は不要。

本案と固定版の出典を実装への参照にできる。ローカルの全件比較メモは必須入力にしない。現時点では文書照合・下書き作成・執筆担当の日本語確認までで、代表例の実行、共通check、独立評価、改善効果の測定は未実施。
