<!-- 生成元: references/agents-md.md。直接編集せず、正本を変更して再生成してください -->

# エージェントへの指示

導入した`check:feedback`を、Claude CodeとCodexが変更のたびに実行して直す状態にする。指示は対象repoの`AGENTS.md`だけに置く。どちらも同じファイルを読むので、エージェントごとの複製を作らない。

指示だけで実行が漏れる場合は、[Claude Code](claude-code.md)か[Codex](codex.md)のhookをrepo単位で追加する。プラグインにはhookを同梱しない。同梱すると、プラグインを有効にした全repoで発火するためである。

## AGENTS.mdの節

対象repoの`AGENTS.md`へ、次のような節を追加する。package managerとコマンド名は導入した内容に合わせる。

```markdown
## 変更後の確認

コードやテストを変更したら、作業を終える前に`bun run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では`bun run check`も実行する。`check:feedback`の成功を全体checkの成功として報告しない。

`check:classification`が「分類の確認記録が未完了です」と表示したら、該当するテストを読み直し、`bun run check:classification`が出力する`sha256`で`.feedback-loop-review.json`を更新する。
```

既存の`AGENTS.md`に検証の指示があれば、重ねて書かずにその節へ統合する。全体check・CI・提出前の確認の指示は残す。

## CLAUDE.mdとの関係

Claude Codeは、作業ディレクトリかその上に`CLAUDE.md`か`CLAUDE.local.md`があると、既定では`AGENTS.md`を読まない。`~/.claude/CLAUDE.md`はこの判定に数えない。Codexは`CLAUDE.md`を読まない。そのため、対象repoの状態で次のように分ける。

| 対象repoの状態 | すること |
| --- | --- |
| `CLAUDE.md`がない | `AGENTS.md`だけを用意し、`CLAUDE.md`を作らない |
| `CLAUDE.md`がある | 先頭へ`@AGENTS.md`を足す。検証の指示は`AGENTS.md`へ移し、`CLAUDE.md`に残さない |
| 共有しない`CLAUDE.local.md`だけがある | `CLAUDE.local.md`は変更せず、その利用者に`@AGENTS.md`の追加を伝える |

読込みの条件は、利用するClaude Codeの版の[AGENTS.mdの説明](https://code.claude.com/docs/en/memory#agents-md)へ照合する。

## 接続後に確認する

- 小さな既知の違反を入れた変更で、エージェントが`check:feedback`の失敗を読み、修正して再実行することを確かめる。
- 違反を除いた後、`check:feedback`と全体checkが成功することを確かめる。
- テストファイルを変更し、エージェントが未完了の表示を読んで確認記録を更新することを確かめる。
- 接続の確認と、実際の作業でエージェントがコマンドを選んだ観測を区別して報告する。
