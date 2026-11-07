<!-- 生成元: references/claude-code.md。直接編集せず、正本を変更して再生成してください -->

# Claude Codeのhook

[`AGENTS.md`の指示](agents-md.md)だけでは実行が漏れる場合は、対象repoの`.claude/settings.json`へ`Stop` hookを追加する。Claude Codeが応答を終える時点で`check:feedback`を実行し、失敗したら診断を返して修正を続けさせる。設定は対象repoのスクリプトを呼ぶだけにする。

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/claude-feedback-hook.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

スクリプトの例は次のとおり。hookの入力の`cwd`で作業中のディレクトリへ移る。worktreeに入ったセッションでも、`$CLAUDE_PROJECT_DIR`は開始時のcheckoutを指すためである。

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

終了コード2は停止を取り消し、stderrを修正の理由としてClaude Codeへ渡す。`stop_hook_active`が`true`のときに終了0にして、同じ失敗による繰返しを防ぐ。そのため、修正後の再実行はhookでは保証されない。修正後に`check:feedback`を再実行させるのは`AGENTS.md`への指示であり、hookを提出前の判定に使わない。変更の有無の判定は、分岐点以降のcommitを含めるか等を対象repoに合わせる。この例は`jq`を使う。スクリプトとhookの設定は対象repoの変更としてレビューを受ける。

hookのイベント名・入力・終了コードの意味は、利用するClaude Codeの版の[hooksの説明](https://code.claude.com/docs/en/hooks#stop-input)へ照合する。`.claude/settings.local.json`は個人用のため、チームで共有する接続には使わない。
