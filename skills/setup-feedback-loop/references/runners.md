# 分類と関連テストの接続

設定形式は[呼出し仕様](../../../docs/wiki/setup-feedback-loop-contract.md)を使う。`.dotagents.json`へ分類やrunnerの設定を追加しない。通常checkが収集する自動テストを既定のquality集合にし、内容を確認したassuranceだけを理由付きで指定する。実サービス・手動検証等は別扱いのまま一覧へ残し、呼出し方と範囲を保つ。

qualityは要求、入出力、権限、保存、状態遷移、公開契約を確認する。assuranceは環境障害、中断・復帰、後始末、履歴保全、repo全体の整合等を主目的とする。異常系・DB・結合範囲・遅さだけでassuranceにしない。混在ファイルはqualityに残すか、必要性を確かめて独立テスト担当が分割する。意味分類をOxlintへ任せない。

`collect`は通常checkと同じ収集処理からJSON文字列配列を返す。`check:classification`でglob集合と実収集の差、重複、存在しない指定を拒否する。通常checkの対象が導入前後で減っていないことも照合する。globの誤設定と収集側の同時変更までは集合比較だけで防げない。

通常runnerが許可する条件付きskipは既定で維持する。対象repoのcheckがskipを禁止している場合は`allowSkipped: false`を指定し、その失敗条件も照合する。skipを許可していても、選択した全テストがskipで一件も実行されなければ非ゼロ終了にする。package managerとrunnerは別々に確認し、npm管理のBunテストもBunで起動する。

## Bun

既存の`scripts/test-runtime/record-modules.ts`を配置し、通常のモジュール読込み、JSON・非ASCII・動的import・子Bunの帰属を再利用する。各テストファイルを別プロセスで起動し、`bunArgs`と`testArgs`を保つ。Bunの実行版は対象repoの固定runtimeを使う。`prepare`を一度完了してからテストを起動し、分類検査では準備を行わない。

関連選択は分岐点以降のcommit、staged／unstaged、未追跡、削除・改名の旧パスを含める。変更したqualityテスト自身も選ぶ。通常のファイル読込み、変数import、子プロセス・Python・生成入力は、明示した`dependencies`か`globalChanges`で補う。対応できない変更が一つでもあれば全qualityへ広げる。

記録はworktree固有のGit dirへ保存する。HEAD、実行runtime、記録器・runnerの内容、読込みモジュールのhashを照合する。現在の変更一覧へ含まれる入力は選択処理で扱い、それ以外の内容不一致や基点不明は記録を信頼しない。commit後の基点変更では全件へ広がる。旧形式には基点がないため、新しい成功の証拠に変換しない。失敗時は直前の原記録を内容別の`.previous`へ保持し、失敗したテストの利用中の記録を無効にする。

実行されなかった分岐、環境変数を引き継がない子、ファイル読込み等を完全追跡するものではない。assuranceやその検証対象を変えた場合は直接実行し、影響を判断できなければ`fullCheck`へ広げる。提出前・CIには全体checkを使う。

## Vitest

対象repoのローカルVitestで、公開APIの`createVitest`と`getRelevantTestSpecifications`を使い、変更ごとの関連qualityをテスト本体を実行せずに確認する。明示対応もVitestの到達先もない変更が混じれば全qualityへ広げる。実行は公開CLIの`related ... --run`を使う。既存のconfig・global setup・環境変数・codegen・DB準備を保つ。収集用コマンドは導入版の`list`の出力をrepo相対パスのJSON文字列配列へ整え、通常checkと照合する。[Vitest 4のAPI](https://v4.vitest.dev/advanced/api/vitest.html#getrelevanttestspecifications)と[CLIガイド](https://v4.vitest.dev/guide/cli.html)を導入版へ照合する。公開APIの対応が確認できない版では、正常に選択できたと扱わない。

補助スクリプトは変更テスト自身と明示した依存先を関連入力へ含め、assuranceを除外する。設定・lock・選択器・削除、依存先不明の入力は全qualityへ広げる。静的importで追えると推測しただけの入力を、関連選択の根拠にしない。JSONレポートで完了・実行集合を確認し、関連0件の終了0を成功に数えない。skip等は対象repoの既存契約へ照合する。

## 導入時の確認

変更・削除・改名・未追跡、新規テスト、記録なし・破損・古い記録、設定変更、不明な入力と既知依存が混じる場合を独立テストへ照合する。Bunの通常実行と記録付き実行の値・assertion・成功失敗、並列の帰属も確認する。既存の保証が十分なら重複ケースを増やさない。診断・対象・再実行方法と、変更なし・候補0・選択不能・失敗・成功を区別する。

時間を報告する場合は準備とテスト本体を分け、実行した版・対象・件数・終了状態を生ログへ残す。未実行・失敗・処理省略を高速化へ読み替えず、固定閾値や変異スコアを合否条件にしない。
