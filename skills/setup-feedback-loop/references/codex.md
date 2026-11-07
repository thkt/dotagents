<!-- 生成元: references/codex.md。直接編集せず、正本を変更して再生成してください -->

# Codexとの接続

## サンドボックスとの関係

Codexの既定の`workspace-write`は、作業ディレクトリへの書込みを許し、`.git`・`.codex`・`.agents`を読取り専用にし、ネットワークを止める。導入の操作は次のように扱う。

| 操作 | 既定のサンドボックスでの扱い |
| --- | --- |
| `inspect`、`apply`、`check:classification`、`test:affected` | 作業ディレクトリの中だけへ書くので、そのまま実行する |
| `install` | パッケージを取得するので、ネットワークの承認を得て実行する |
| `.codex/hooks.json`の作成 | `.codex`へ書くので、承認を得て実行する |
| 外部サービスを使う`prepare`やテスト | 止まった段を未完了として報告し、利用者に`sandbox_workspace_write.network_access`等の設定を確かめる |

`check:feedback`は既定のサンドボックスの中で全段を通す。サンドボックスの外で成功しても、Codexの反復で使えることの確認にはならない。

## hookによる実行

[`AGENTS.md`の指示](agents-md.md)だけでは実行が漏れる場合は、対象repoの`.codex/hooks.json`へ`Stop` hookを追加する。Codexが応答を終える時点で`check:feedback`を実行し、失敗したら診断を返して修正を続けさせる。設定は対象repoのスクリプトを呼ぶだけにする。

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$(git rev-parse --show-toplevel)\"/scripts/codex-feedback-hook.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

スクリプトの例は次のとおり。Codexは終了0の`Stop` hookの標準出力をJSONとして読むので、診断はすべて標準エラーへ出す。

```sh
#!/bin/sh
input=$(cat)
# 前回の停止取消で続けている場合は、同じ失敗で止め続けない。
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active')" = "true" ] && exit 0
cd "$(printf '%s' "$input" | jq -r '.cwd')" || exit 0
# 変更がなければtest:affectedは「変更なし」で失敗するため、実行しない。
[ -z "$(git status --porcelain)" ] && exit 0
bun run check:feedback >&2 || exit 2
```

終了コード2は応答の終了を取り消し、標準エラーを続きの指示としてCodexへ渡す。`stop_hook_active`が`true`のときに終了0にして、同じ失敗による繰返しを防ぐ。そのため、修正後の再実行はhookでは保証されない。修正後に`check:feedback`を再実行させるのは`AGENTS.md`への指示であり、hookを提出前の判定に使わない。

repoの`.codex/`は、利用者がプロジェクトを信頼した場合だけ読まれる。hookは内容のhashごとに利用者の確認が要るので、追加や変更の後は`/hooks`で確認するよう利用者に伝える。hookのイベント名・入力・終了コードの意味は、利用するCodexの版の[hooksの説明](https://developers.openai.com/codex/hooks)へ照合する。
