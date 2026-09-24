# fallowによる未使用検査を導入し、依存循環と重複処理を整理する

## 目的と合意

dotagentsのコードベース解析にfallowを採用し、未使用コードの検出と、重複・複雑度・循環依存の調査を同じツールで行えるようにする。ユーザーは2026-09-21の比較試行と入口をそろえた追試を踏まえ、「fallowに乗り換えた方が早くて機能が多いのでそうしたい」と採用を指定した。このrepoはKnipを常設していないため、作業はfallowの新規導入となる。

速度は採用理由の一つだが、常にKnipより速いことを要求・保証とはしない。既存の整形・lint・型検査・認知的複雑度・制御テストの保証を維持する。

## 範囲

- fallowを版固定の開発依存として導入し、lockfileと必要な設定を管理する。比較済みの版は3.27.0。
- CLI・テストなどの実際の入口を指定し、入口ファイルのexportも未使用検査の対象にする。formatterの対象に含まれるだけのファイルを使用中と扱わない構成にする。
- 未使用ファイル・export・型・依存を調べるコマンドを`bun run check`へ接続する。対象分類の指摘と解析失敗を成功扱いしない。使用中の入口や依存の例外が必要なら、その対象と利用根拠を限定して説明する。
- 導入で確認できた不要なexport指定など、検査を有効にするために必要な局所修正を行う。ファイル内で使う関数本体まで削除しない。無関係なコード整理は行わない。
- 重複・複雑度・循環依存を必要時に調べるコマンドと読み方を用意する。初回はこれらの追加指摘を共通checkの失敗条件にせず、既存のBiomeによる認知的複雑度15の検査は維持する。推定coverageや類似コードだけを根拠に、自動削除・強制分割をしない。
- 現行のsetup・check・操作説明を、今回影響する既存文書に反映する。
- 検出候補を実コードで調べ、`input.ts`と`revision.ts`の実行時依存の循環、および`revision.ts`内の同じ任意ファイル読取り処理を整理する。根拠と保持する条件は下記「検出候補の調査と追加修正」に従う。

他repoやグローバルのKnipの削除、MCP・hook・スキルの追加、有料Runtime、既存lint・型検査・Biomeの置換、境界規則の新設は対象外。

## 検出候補の調査と追加修正

2026-09-21、ユーザーはPR #175での実行結果を受けて「修正と、修正候補の調査してみよう」と指示した。公開済みの[commit 37d2685719fc0b378fbbe867ab4c9f8028a99a8f](https://github.com/thkt/dotagents/tree/37d2685719fc0b378fbbe867ab4c9f8028a99a8f)を確認し、未マージの本Issue・PRへ次の局所修正を追加する。初回導入の要求と保証は維持する。

| 候補 | 調査結果と今回の扱い |
| --- | --- |
| `input.ts` ↔ `revision.ts`の循環 | 入力検査の`assertConfig`が修正実行側の`assertRevision`を呼び、修正実行側が`assertConfig`・`assertState`を呼ぶ。`Revision`型と値の検証を既存の入力定義側へそろえ、検証内容を維持したまま実行時の循環を解消する。新しい中継moduleや互換用の再exportは追加しない。初期化時の障害は未観測で、障害修正や速度向上とは主張しない |
| `revision.ts`の任意ファイル読取り2箇所 | `result.json`と`verification/state.json`はいずれもENOENTだけをundefinedとし、他の読取りエラーを伝播する。同じI/O処理はmodule内で一本化できる。読取り時点と回数、空文字の扱い、JSON解析と記録の選別、未完了・不明な公開・active・lockの拒否は呼出側に残す。汎用I/O層や追加の保存状態は作らない |
| `capture-config.ts`のsemantic重複候補 | 検出範囲が設定objectと複数の関数境界をまたぐ。webServer objectのcwd補正とhook moduleの解決は入力型・失敗条件・処理が異なるため、同一処理として抽出しない |
| `checkRevision`・`previousRun`の複雑度 | 循環的複雑度は25・23だが、認知的複雑度は12・9で既存上限15以内。各条件は対象・Issue・主体・保存記録など別の拒否条件を持つ。今回の調査で重複した判定や不要な状態遷移は確認しておらず、数値を下げるだけの分割・条件削除は行わない |

通常の重複検査は0組、semanticでは上の2組を検出した。CRAPの指摘は推定coverageによるもので、未テストの確定根拠にはしない。調査しなかった箇所を含めた無欠陥保証や全体リファクタリングは範囲に含めない。

変更前後の同じ解析で、対象の循環が消え、任意ファイル読取りの同じcatch実装が重複しないことを確かめる。semanticの残った設定候補を消すために抑制・除外や閾値変更を追加しない。循環・重複・複雑度を共通checkの新しい失敗条件にはしない。既存の外部操作前の再照合、停止条件、データ保全、人の承認・マージの責任を維持する。

関連する[#98](https://github.com/thkt/dotagents/issues/98)は実行管理とinput/reviewの以前の循環を整理したもの、[#147](https://github.com/thkt/dotagents/issues/147)は設計規約の追加検査の調査である。今回のinput/revisionと局所I/O処理の整理とは分け、新しい常設検査や規約の採用は行わない。必要な根拠は本Issueへ記載し、未commitのローカル報告を必須入力にはしない。

## 実装に使える確認済みの根拠

対象の比較基準は[commit 59e9f7374c18dba415f9c1512e1b9116a9e8a28d](https://github.com/thkt/dotagents/tree/59e9f7374c18dba415f9c1512e1b9116a9e8a28d)。Bun 1.4.2、Node.js 26.9.0、fallow 3.27.0、Knip 6.36.0、oxfmt 0.66.0で一時コピーを解析した。未使用コード等の反復3回の実時間中央値はfallow 0.101秒、Knip 0.320秒。ただし小さな単一repoで、自動追加される入口の差が残った初回測定であり、性能の一般化はしない。

入口の差を除いた追試では、TypeScript入口25件を共通にすると、意図的な未使用ファイル・未使用export・使用中moduleの判定と、既存の未使用export 2件・循環依存1件が一致した。入口の差を残した結果からKnipの検出が優れているとは判断しない。

fallowの`entry`は自動発見への追加指定で、明示した入口だけに制限する指定ではない。元の`oxfmt --write "scripts/**/*.ts"`と`--check "scripts/**/*.ts"`では、glob対象がfallowの入口として追加された。次の候補は、一時コピーでformat機能を維持しつつこの過剰な入口を避けられた。

```json
{
  "scripts": {
    "format": "oxfmt --write scripts",
    "format:check": "oxfmt --check scripts"
  }
}
```

`.oxfmtrc.json`に既存の整形指定を残し、`"ignorePatterns": ["**/*", "!**/", "!**/*.ts"]`を追加する候補を使用した。旧・新コマンドはいずれも対照を含む40個のTSファイルを検査した。さらに直下・入れ子の未整形TS各1個、対象外のMarkdown・JavaScriptを加え、両方が同じTS 2個を不合格とし、write後の全scriptsファイルの内容も一致した。fallowはこのformat設定を維持したまま入口25件となり、未使用ファイルを検出できた。実装開始版で適用性を再確認する。

基準版の未使用exportは`research-handoff.ts`の`reportReferences`と`revision.ts`の`reconcileExecutions`。いずれも同一ファイル内で使用する。循環は`input.ts`と`revision.ts`の値import間にあるが、今回の調査では実害を確認していない。

公式参照: [fallow](https://github.com/fallow-rs/fallow)、[設定](https://fallow.tools/docs/configuration/overview/)、[重複検査](https://docs.fallow.tools/analysis/duplication)。本Issueに実装判断に必要な根拠を記載したため、未commitのローカル調査報告は実装の必須参照にしない。

## 完了条件と検証

1. 固定lockfileによる既存setupからfallowを導入でき、ローカルとCIの`bun run check`で未使用コード検査が実行される。解析エラーが成功に化けない。
2. format/checkを維持した実際の設定で、未参照ファイルと到達可能ファイル内の未使用exportを検出する。実際に使うCLI・テスト入口・importしたexportを未使用として扱わない。既存の対照例を使い、必要な検出条件だけを検証する。
3. 現行と同じ`scripts/**/*.ts`の整形対象・出力を保つ。未整形TSでcheckが失敗し、writeで修正され、対象外ファイルが変更されないことを確認する。
4. 重複・複雑度・循環依存の調査方法と、共通checkに含める範囲、指摘の限界が既存文書から分かる。
5. `bun run check`が成功し、独立評価と公開後確認を含む通常のPR経路を完了する。今回変更した検証の守る条件・制約をPRで説明する。人の承認・マージは代行しない。
6. `input.ts`と`revision.ts`の実行時依存の循環がなく、不正な修正入力の拒否を維持する。任意ファイル読取りはENOENTのみを許容し、他のI/O失敗と不正JSONを成功扱いしない。既存の未完了・不明な公開・active・lockの拒否と旧記録・作業の保全を維持する。既存テストを再利用し、移動・共通化で見逃す現実的な境界が不足する場合だけ検証を補う。

対象設定は`.dotagents.json`の既存setup `bun install --frozen-lockfile --ignore-scripts`、check `bun run check`、CI `checks` / `verify`を使用する。UI変更はなく、captureは既存の`null`。新しい媒体基盤・採点基盤・定期検査は追加しない。
