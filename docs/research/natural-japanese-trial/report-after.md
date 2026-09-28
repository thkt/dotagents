# Portlessはworktree別の手動プレビューに使えた

Portlessで二つのworktreeに別々のURLを割り当て、各サーバーへの接続とブラウザーのoriginの分離を確認した。worktreeごとの手動プレビューには有効だった。ただし、既存E2E・撮影フローとの統合は未検証であり、共通ハーネスの必須依存にする根拠にはしない。

確認日は2026-09-23。対象は[Portless 0.15.6](https://portless.sh/)と、`dotagents-workflow-trial` のcommit `d0134086ad9bdddb5ed2693327cb1ffb0859c4a2`。元repoは変更せず、一時cloneに作った二つのlinked worktree（`pilot-a`、`pilot-b`）で試した。

## 二つのURLが別のサーバーへ届くかを試した

複数worktreeのWeb画面を同時に起動し、名前付きURLが別のサーバーへ届くか、ブラウザーのoriginも分かれるかを確認した。環境はNode.js 26.10.0とmacOSで、Portlessの状態・パッケージは一時領域に限定した。

システム証明書やhostsを変えないよう、プロキシはHTTPで起動した。接続先は `127.0.0.1`、ポートは48333、設定は `PORTLESS_SYNC_HOSTS=0` とした。各worktreeで `portless run --name dotagents-trial bun trial/server.js` を実行した。

| worktree | Portless URL | アプリの割当ポート | ブラウザーの結果 |
| --- | --- | ---: | --- |
| `pilot-a` | `http://pilot-a.dotagents-trial.localhost:48333/` | 4178 | HTTP 200、元のタイトルを表示 |
| `pilot-b` | `http://pilot-b.dotagents-trial.localhost:48333/` | 4578 | HTTP 200、`pilot-b`側だけで変更したタイトルを表示 |

Chromeの一時プロファイルで両URLを開いた。`pilot-a`で設定したlocalStorage項目は、`pilot-b`では読めなかった。試行後は両アプリとプロキシを停止し、Portlessのactive routeが残っていないことを確認した。

## 自動検証への組込みには追加の確認が必要

対象repoの現行Playwright設定は、`baseURL`・`webServer.url`・`PORT`を `127.0.0.1:4173` に固定している。共通ハーネスも対象repoのPlaywright設定を使うため、今回の試行では既存E2E・撮影フローへの統合を確認していない。

自動検証に適用するには、対象repo側でURLとサーバー起動を同じ設定から導く必要がある。そのうえで、同時実行、停止・再試行、CIでの動作を別に確かめる。

今回測ったのはローカルHTTPによる経路分離に限られる。Portlessの標準HTTPS、証明書登録、他の開発フレームワーク、異なるホスト・ブラウザー環境での動作は未確認である。
