# 操作の契約

このディレクトリは公開可能な合成プロジェクトです。履歴資料も合成であり、実在の開発者の記録ではありません。依存の導入、外部API、Git履歴、認証は必要ありません。

## 保存後の通知

`src/messages.ts`の`advance`は、queuedからstartでrunningへ、runningからcompleteでcompletedへ、runningからfailでfailedへ移ります。それ以外は状態を維持します。通知はrunningからcompletedへ移るときだけ1回送ります。完了メッセージを「保存が完了しました。」へ変更することが合意済みです。状態遷移、通知回数、失敗時の非通知は維持します。

確認は`bun test fixtures/workspace/tests/messages*.test.ts`です。

## READMEの参照先

READMEの保存操作の参照先は、同じディレクトリの`docs/current-guide.md`へ訂正します。現在の操作説明を案内するリンクです。

確認は`bun test fixtures/workspace/tests/guide.test.ts`です。

## 一時作業領域

`src/reports.ts`の帳票出力とプレビューは、`src/archive.ts`の`exportArchive`と`src/preview.ts`の`renderPreview`を使います。前者はrootの下に一時領域を作って所有し、後者は呼出側が所有する既存directoryを使います。actionにdirectoryを渡し、その返値を返します。正常・action失敗・取消のすべてで、内部所有の領域だけを終了時に削除します。外部所有の領域とその内容は削除しません。actionの失敗は同じエラーを伝えます。action開始前、またはactionから戻る前にsignalが取り消された場合はAbortErrorで終了し、成功扱いにしません。開始前の取消ではactionを呼びません。action実行中の強制終了は契約に含めません。

共通化しても既存の呼出元の引数、結果、終了責任を維持します。共通部分の関数名・API形は指定しません。

確認は`bun test fixtures/workspace/tests/work-areas.test.ts`です。

## 保存結果の診断

`src/results.ts`は外部入力を受け取ります。kindがresultなら、successでは空白以外のartifact、failureでは空白以外のreasonが必要です。statusがそれ以外なら拒否します。kindがeventの記録にはresult用の条件を適用しません。それ以外の入力は拒否します。拒否時にはwriteを呼ばず、許可時には元の値を1回渡します。

変更する診断は、artifact不足を「成功結果には成果物参照が必要です。」、reason不足を「失敗結果には理由が必要です。」、不正statusを「結果の状態が不正です。」とする3件です。その他の診断と条件は維持します。

確認は`bun test fixtures/workspace/tests/results*.test.ts`です。

## 過去の保存形式と実行履歴

profileの保存JSONのversion 1にはlast_folderがあり、`src/load-profile.js`が読み込みます。旧形式の正常例は`data/profile.json`です。version 1の読込み互換性を維持します。

`src/history.ts`は別の履歴保存処理です。successにはartifact、failureにはreasonが必要という仕様は合意済みです。外部JSONの読込みは`importHistory`、保存の通常入口は`appendHistory`です。既存検査は`src/check-history.ts`にあります。改善範囲の整理が依頼されており、本実装は未合意です。

## CLIの説明

`src/help.ts`の「結果を保孫する」は「結果を保存する」の誤記です。説明文以外の操作契約、API、所有・終了責任は変更しません。依頼は修正範囲と確認方法の整理までです。
