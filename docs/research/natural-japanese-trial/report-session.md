# Portlessのworktree別URL試行

Portlessは、worktreeごとにURLを分けて手動でプレビューする用途では有効だった。今回のローカルHTTP環境では、二つのworktreeのURLがそれぞれのサーバーにつながり、ブラウザーのoriginも分かれることを確認した。既存のE2E・撮影フローへの統合は未検証であり、この結果を共通ハーネスの必須依存にする根拠にはしない。

## 対象と試行条件

確認日は2026-09-23。対象は[Portless 0.15.6](https://portless.sh/)と、`dotagents-workflow-trial` のcommit `d0134086ad9bdddb5ed2693327cb1ffb0859c4a2`。元repoは変更せず、一時cloneに作った二つのlinked worktree（`pilot-a`、`pilot-b`）で試した。

試行の目的は、複数worktreeのWeb画面を同時に起動したとき、名前付きURLがそれぞれ別のサーバーに届き、ブラウザーのoriginも分かれるかを確かめることだった。環境はmacOS、Node.js 26.10.0で、Portlessの状態とパッケージは一時領域に限定した。

システム証明書やhostsを変更しないよう、プロキシはHTTPを使い、`127.0.0.1`の高いポート48333で起動した。hostsとの同期は`PORTLESS_SYNC_HOSTS=0`で無効にした。各worktreeから実行したコマンドは `portless run --name dotagents-trial bun trial/server.js`。

## URLの接続先とブラウザーでの結果

両URLはHTTP 200を返し、それぞれのworktreeのタイトルを表示した。

| worktree | Portless URL | アプリの割当ポート | ブラウザーの結果 |
| --- | --- | ---: | --- |
| `pilot-a` | `http://pilot-a.dotagents-trial.localhost:48333/` | 4178 | HTTP 200、元のタイトルを表示 |
| `pilot-b` | `http://pilot-b.dotagents-trial.localhost:48333/` | 4578 | HTTP 200、`pilot-b`側だけで変更したタイトルを表示 |

Chromeの一時プロファイルで両URLを開き、`pilot-a`で設定したlocalStorage項目が`pilot-b`では読めないことも確認した。試行後は両アプリとプロキシを停止し、Portlessにactive routeが残っていないことを確認した。

## 自動検証への適用に必要な確認

対象repoの現行Playwright設定は、`baseURL`・`webServer.url`・`PORT`を`127.0.0.1:4173`に固定している。共通ハーネスも対象repoのPlaywright設定を使うため、今回の試行だけでは既存のE2E・撮影フローに統合できるかは判断できない。

自動検証に適用する場合は、対象repo側でURLとサーバー起動を同じ設定から導く必要がある。そのうえで、同時実行、停止・再試行、CIでの動作を別に確かめる。

今回測ったのは、ローカルHTTPによる経路の分離だけである。Portlessの標準HTTPS、証明書登録、他の開発フレームワーク、異なるホスト・ブラウザー環境での動作は未確認。
