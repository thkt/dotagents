# 公開・既存PR修正・CIで重複するPR同一性の照合を共通化する

## 目的と現在の根拠

PRの状態・head・base・draftなどの共通条件を変更するときの同時修正箇所を減らす。取得時点と各経路固有の保証を保ち、RESTとGraphQLの応答形式の違いを判定本体から分ける。

監査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。[新規公開のREST照合](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/publish.ts#L33-L78)、[既存PR修正のGraphQL照合](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/revision.ts#L156-L227)、[CIのGraphQL照合](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/ci.ts#L149-L194)が共通する対象条件を別々に実装する。state・draft・headの表現が異なり、Issue参照の照合もrevisionとCIに分かれている。

## 範囲・対象外

必要な応答値の正規化と共通の純粋な照合処理を整理する。各入口が必要とする値を明示し、不足する値を成功の既定値で補わない。取得・保存・例外の処理は、各経路の責任が分かる形で残す。

GitHub取得の回数・時点の変更、API方式の一括移行、公開確認とCIの役割統合、PR本文の意味確認の自動化は対象外。新しい汎用キャッシュ、CLI、全GitHub応答用のスキーマ基盤を作らない。

## 受入条件

- [ ] 同じ意味のPR同一性条件を一箇所で保守でき、旧判定のコピーを残さない。経路ごとの違いを多数の暗黙の既定値やフラグに押し込めない。
- [ ] publishの作者・本文完全一致・repo・branch・commit・draft、revisionのIssue参照・依頼・remote ref・他run確認、CIの同一head・base・OPEN/draft・必要時のURL/Issue照合を維持する。
- [ ] 公開直後、draft変更後、本文更新後、添付前、CI待機中・終了時の取得と読戻しを維持し、前の操作の観測で代替しない。CIに現在取得しない作者・本文の完全一致を新たに要求しない。
- [ ] 不正応答と対象不一致を成功に変換せず、現在の停止分類・既知URL・診断・保存記録を保つ。新規/既存PR、単独publish、媒体あり/なしで動作が保たれる。

## 検証・関連・合意

既存のpublish/revision/ci/developmentテストで、作者・head・base・本文・draft・Issueの不一致、欠落・不正応答、取得・保存失敗を確認する。共通関数だけの成功で入口の検査接続を確認済みとしない。検証条件の重複追加は避け、保守する定義箇所と経路固有の条件を変更前後で示す。

セットアップは`bun install --frozen-lockfile --ignore-scripts`。実装提出前に`bun run check`、独立評価と日本語確認、PR公開時に同じheadの`checks`・`verify`を確認する。captureは`null`で媒体は不要。人のレビュー・マージと公開範囲の判断を維持する。

完了済みの[#102](https://github.com/thkt/dotagents/issues/102)は添付後の公開読戻しとCI初回取得の共用を採用し、publishの作者・本文検査とCI最終照合を残した。今回はその取得整理を再実施せず、残る照合コードの重複を扱う。[#150](https://github.com/thkt/dotagents/issues/150)の境界を越えて観測を流用しない条件も維持する。

必要な根拠は本Issueと固定版リンクで足り、追加の必須調査報告や未commitの下書きを後続作業の入力にしない。着手時に最新の採用版で適用性を確認し直す。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
