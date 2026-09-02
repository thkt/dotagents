# プロジェクトの成果

一次ソースに基づく Think/Research の判断を1つの公開 Issue にし、その Issue だけを契約として検証済み draft PR を作成できること。

## 検証可能な境界

- Think と Research は1つの immutable repository snapshot を使い、変化しうる source を handoff 前に再検証する。
- Issue は人間向けと machine-readable の canonical contract を1つ publish する。
- Build はその公開 contract に従って結果全体を検証し、明示的な authorization がある場合だけ Ship する。

検証には `bun run check` を使う。
