# Issue取得と既存PR修正の対象照合の責務を分ける

## 目的と現在の根拠

Issueの取得を呼ぶだけで既存PR修正全体の照合が動く構造を整理し、各操作の前後で確認する対象と責任をコードから追えるようにする。鮮度の異なる確認を一括削除して取得回数を減らす変更にはしない。

監査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。[correctionのreadIssue](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/correction.ts#L134-L151)はrevision時に[checkRevision](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/revision.ts#L101-L227)を呼び、修正依頼、対象・主体、branch、PR本文・head、remote ref、[他runとの衝突](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/revision.ts#L242-L266)まで照合する。

capture・修正なしでcheckとreviewが各1回成功する既存fixtureでは、Issue取得コマンドは5回だった。revisionの場合、その各取得は現在の呼出関係上ghコマンド6回に相当するが、これは静的な算出であり、実GitHubのHTTP回数や削減可能数ではない。[developmentのverify](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/development.ts#L530-L549)も返却後に修正対象を照合する。commit前後のverify再呼出しは終端状態の鮮度照合であり、check・reviewを再実行するものではない。

## 範囲・対象外

Issueの取得と修正対象の取得・照合を分離し、既存の各境界で必要な操作が明示される構成へ整理する。最初は現在の取得時点・順序・停止条件を保ち、責務の移動による重複や隠れた副作用を残さない。新しい汎用キャッシュ、CLI、状態台帳は作らない。

setup・check・capture・モデル実行・commit・push・draft切替・本文更新・添付をまたぐ観測の流用、CI最終照合やソース走査の削除、旧runの再開、PR同一性の検査内容変更は対象外。API数や実時間の削減は受入条件にせず、未実証の改善率を約束しない。

## 受入条件

- [ ] Issue取得と修正対象照合の呼出関係が明示され、取得済みのIssueを使う範囲と新しく読み直す境界を識別できる。対象・主体・権限・依頼・PR・remote ref・他runの照合が欠落しない。
- [ ] 単独correction、通常開発、既存PR修正、no-publish、終端状態の再照合で、既存の失敗分類・後続処理の抑止と証拠保全を維持する。
- [ ] #162で採用した保存先・lock・stateを先に確認する順序、active予約と既存lockの拒否、旧run・既知URL・作業の保全を維持する。
- [ ] 必要な検出の遅延や停止理由の変化を、共通化の副作用として黙って導入しない。必要なら影響と代替案を示して範囲を再判断する。処理移動だけをI/O削減と説明しない。

## 検証・関連・合意

既存のrevision/development/correctionテストを再利用し、correctionを成功応答へ置き換えない代表ケースで、Issue・依頼・主体・権限・branch・PR・remote refの変更とlock/state障害を注入する。拒否理由だけでなくモデル・公開の抑止と既存記録の保持を確認する。通常経路・変更を挟む経路の取得順を比較し、回数を固定するためだけの常設テストは増やさない。

セットアップは`bun install --frozen-lockfile --ignore-scripts`。実装提出前に`bun run check`、独立評価と日本語確認、PR公開時に同じheadの`checks`・`verify`を確認する。captureは`null`で媒体は不要。

完了済みの[#123](https://github.com/thkt/dotagents/issues/123)はcommit直前、[#150](https://github.com/thkt/dotagents/issues/150)は予約後・setup後、[#162](https://github.com/thkt/dotagents/issues/162)はcorrection入口へ照合を集約した変更。今回はそれらの削減をやり直さず、残るreadIssue内部の責務混在を整理する。PR同一性の共通化とIssue証拠表現の統一は別Issueとし、同時に境界や形式を変えない。

必要な根拠は本Issueと固定版リンクで足り、追加の必須調査報告や未commitの下書きを後続作業の入力にしない。着手時に最新の採用版で適用性を確認し直す。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
