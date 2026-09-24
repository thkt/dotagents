# Portlessのworktree別URL試行

確認日: 2026-09-23。対象は[Portless 0.15.6](https://portless.sh/)と、`dotagents-workflow-trial` のcommit `d0134086ad9bdddb5ed2693327cb1ffb0859c4a2`。元repoは変更せず、一時cloneの二つのlinked worktree（`pilot-a`、`pilot-b`）で試した。

## 問いと方法

複数worktreeのWeb画面を同時に起動したとき、名前付きURLが別のサーバーへ届き、ブラウザーのoriginも分かれるかを確認した。Node.js 26.10.0、macOS、Portlessの状態・パッケージは一時領域に限定した。システム証明書やhostsを変えないため、プロキシはHTTP・`127.0.0.1`の高いポート48333、`PORTLESS_SYNC_HOSTS=0`で起動した。各worktreeから `portless run --name dotagents-trial bun trial/server.js` を実行した。

| worktree | Portless URL | アプリの割当ポート | ブラウザーの結果 |
| --- | --- | ---: | --- |
| `pilot-a` | `http://pilot-a.dotagents-trial.localhost:48333/` | 4178 | HTTP 200、元のタイトルを表示 |
| `pilot-b` | `http://pilot-b.dotagents-trial.localhost:48333/` | 4578 | HTTP 200、`pilot-b`側だけで変更したタイトルを表示 |

Chromeの一時プロファイルで両URLを開き、`pilot-a`で設定したlocalStorage項目が`pilot-b`では読めないことも確認した。試行後に両アプリとプロキシを停止し、Portlessのactive routeが残っていないことを確認した。

## 適用判断と限界

worktreeごとの手動プレビューURLとしては有効だった。対象repoの現行Playwright設定は `baseURL`・`webServer.url`・`PORT`を `127.0.0.1:4173` に固定しているため、この試行は既存E2E・撮影フローへの統合を検証していない。共通ハーネスは対象repoのPlaywright設定を使う。自動検証へ適用するなら、対象repo側でURLとサーバー起動を同じ設定から導き、同時実行、停止・再試行、CIでの動作を別に確かめる必要がある。

今回はローカルHTTPによる経路分離だけを測った。Portlessの標準HTTPS、証明書登録、他の開発フレームワーク、異なるホスト・ブラウザー環境での動作は未確認。共通ハーネスの必須依存へ変更する根拠にはしない。
