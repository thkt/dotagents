---
name: cleanup
description: 検証済み Build Ship receipt からマージ後の整理を準備し、明示承認後に dirty state と無関係な Git データを保持して実行する。
---

# Cleanup

先頭の明示的な `$cleanup <issue>` または `$cleanup approve <prepared digest>` からのみ実行する。hook が指定した `codex-cleanup` コマンドと input を変更せずに使う。`--run-id` は hook が task に拘束して注入するため省略する。CLI は `codex-cleanup describe` で確認する。

準備結果の戻り先 base、削除対象、保存する dirty state、prepared digest を説明する。準備だけでは整理を許可しない。この具体的な preview を提示してから `$cleanup approve <prepared digest>` を求める。

承認は repository と task に拘束された不変の preimage にのみ適用する。runtime が保存状態を復元・検証してから expected-OID の対象を削除する。完了・pending・未着手の工程、保持した recovery OID/ref、停止理由を報告する。中断後は元の hook 指定 input を使い `codex-cleanup resume --input` で再開する。再度 arm したり過去の Ship receipt を推測して作ったりしない。

pending の remote 削除で expected OID が残っている場合は結果を判別できない。local と recovery ref を保持し、手動解決が必要な理由を説明する。削除の再送、再作成履歴の推測、Stop hook からの自動再開をしない。remote の不在を検証できれば、元の承認済み操作を再開できる。
