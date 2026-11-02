# Claude Codeとの接続

導入した`check:feedback`を、Claude Codeが変更のたびに実行して直す状態にする。手段は対象repoのCLAUDE.mdへの指示と、repo単位の`.claude/settings.json`のhookの2つである。まずCLAUDE.mdへの指示を用意し、実行漏れが観測された場合だけhookを追加する。プラグインにはhookを同梱しない。同梱すると、プラグインを有効にした全repoで発火するためである。

## CLAUDE.mdへの指示

対象repoのCLAUDE.md（チームで共有するもの）へ、次のような節を追加する。package managerとコマンド名は導入した内容に合わせる。

```markdown
## 変更後の確認

コードやテストを変更したら、作業を終える前に`bun run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では`bun run check`も実行する。`check:feedback`の成功を全体checkの成功として報告しない。
```

既存のCLAUDE.mdに検証の指示があれば、重ねて書かずにその節へ統合する。全体check・CI・提出前の確認の指示は残す。

## hookによる実行

指示だけでは実行が漏れる場合は、対象repoの`.claude/settings.json`へ`Stop` hookを追加する。Claude Codeが応答を終える時点で`check:feedback`を実行し、失敗したら診断を返して修正を続けさせる。設定は対象repoのスクリプトを呼ぶだけにする。

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

終了コード2は停止を取り消し、stderrを修正の理由としてClaude Codeへ渡す。`stop_hook_active`が`true`のときに終了0にして、同じ失敗による繰返しを防ぐ。変更の有無の判定は、分岐点以降のcommitを含めるか等を対象repoに合わせる。この例は`jq`を使う。スクリプトとhookの設定は対象repoの変更としてレビューを受ける。

hookのイベント名・入力・終了コードの意味は、利用するClaude Codeの版の[hooksの説明](https://code.claude.com/docs/en/hooks#stop-input)へ照合する。`.claude/settings.local.json`は個人用のため、チームで共有する接続には使わない。

## 接続後に確認する

- 小さな既知の違反を入れた変更で、Claude Codeが`check:feedback`の失敗を読み、修正して再実行することを確かめる。
- 違反を除いた後、`check:feedback`と全体checkが成功することを確かめる。
- 接続の確認と、実際の作業でClaude Codeがコマンドを選んだ観測を区別して報告する。
