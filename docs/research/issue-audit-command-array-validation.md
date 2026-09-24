# targetとcorrection入力のコマンド配列検証を整理する

## 目的と現在の根拠

コマンド配列の共通条件を二重に保守する負担を減らし、入口ごとに異なる条件を明示する。似た関数を統合するために現在の入力契約を黙って変更しない。

監査版はmain `7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae`。[target.tsのargv](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/target.ts#L17-L25)と[input.tsのcommand](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/input.ts#L156-L160)は、配列、先頭文字列の非空、全要素が文字列という条件をそれぞれ検査する。ただしtargetは先頭要素をtrimした後で非空か判定し、inputはlengthで判定するため、空白だけの実行名に対する採否は異なる。先頭以外の空文字・空白引数は保持する必要がある。

## 範囲・対象外

配列と要素の型など共通する検査を小さな既存の入力検査部品へ集約し、先頭要素の空白に関する差は呼出側で明示する。targetのsetup/check/captureと、correctionのissue/check/repair/review/captureを対象とする。不要になる旧実装を残さない。

空白だけの実行名に関する拒否強化・緩和、引数のtrimや書換え、shell文字列への変換、コマンド実行の方式変更、全設定のZod移行、新しい依存・汎用スキーマ基盤は対象外。

## 受入条件

- [ ] 共通の配列・要素条件を一箇所で保守し、入口固有の先頭要素条件とエラーメッセージの責任が分かる。単純な重複を多数のモード引数へ置き換えない。
- [ ] 空配列、非文字列要素、空の実行名、空白だけの実行名について各入口の現在の採否を維持する。後続引数の空文字・空白・順序・内容を変更しない。
- [ ] setupの空配列許容、captureの未設定・必須条件など、コマンド配列の外側にある契約を共通化へ巻き込まない。不正入力は現在どおり実行前に拒否する。
- [ ] 型検査と既存の依存方向を維持し、再exportや新しい循環依存を作らない。減る定義箇所と増える呼出側の条件を比較する。

## 検証・関連・合意

既存のtarget/correctionの入力検査テストを使い、上記の境界と空文字・空白引数の保持を確認する。共有関数の形や行数を固定するためのテストは追加せず、共通化で見落とす現実的な条件だけ補う。

セットアップは`bun install --frozen-lockfile --ignore-scripts`。実装提出前に`bun run check`、独立評価と日本語確認、PR公開時に同じheadの`checks`・`verify`を確認する。captureは`null`で媒体は不要。

完了済みの[#174](https://github.com/thkt/dotagents/issues/174)はfallow導入、input/revisionの循環とrevision内の任意ファイル読取りを整理したが、この2つのコマンド配列検証は対象外だった。[#182](https://github.com/thkt/dotagents/issues/182)はレビュー応答に限ったZod移行であり、今回も全入力のスキーマ移行へ広げない。

必要な根拠は本Issueと固定版リンクで足り、追加の必須調査報告や未commitの下書きを後続作業の入力にしない。着手時に最新の採用版で適用性を確認し直す。

2026-09-24の監査結果に対する依頼者の「全てissue化する」に基づく。今回はIssue公開まで。
