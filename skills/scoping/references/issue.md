# Issueへの反映

合意した要求をIssueへ公開・更新するときに使う。下書きの保存を公開許可に読み替えない。

1. [対象repoの設定](../../../scripts/README.md#対象repoの設定)を確認し、信頼するスキル実体から解決した `scripts/scoping/target.ts CHECKOUT [ISSUE_URL] --write` をBunで実行する。checkout・設定のrepo・fetch/push remote・base branch・ghの主体と権限の不一致を解消する。Issue URLのrepoを数字だけに変えて別repoへ流用しない。
2. `gh issue list --repo OWNER/REPO --state all --search '関連語'`と候補本文で重複を調べる。指定されたIssueは`gh issue view NUMBER --repo OWNER/REPO --json title,body,state,url`で読む。重複候補の範囲が異なれば統合しない。
3. 目的、今回の範囲、完了条件、対象repo固有のセットアップ・検証方法・必要媒体と保存先、合意の根拠をリポジトリ内のMarkdown下書きへまとめる。未解決事項と次の判断を残し、重要な判断を先送りするなら理由・再判断の条件・判断する人を記す。実装方法の細部や試行管理を要求へ混ぜず、未合意事項を合意済みと書かない。
4. 下書きを要求・合意・根拠と照合し、抜け・矛盾・曖昧さを解消する。人向け文書は[日本語確認の方針](../../../.codex/DEVELOPMENT.md#pr本文人向け文書の日本語確認)に従い、必要な独立評価と人の合意へつなぐ。
5. 公開直前に対象とghの主体・権限を再照合する。新規なら`gh issue create --repo OWNER/REPO --title '要求を表すタイトル' --body-file PATH`で作成する。既存Issueの更新が依頼範囲なら最新本文を読み、既存要求・他担当の内容を保持して`gh issue edit NUMBER --repo OWNER/REPO --body-file PATH`で反映する。
6. `gh issue view NUMBER --repo OWNER/REPO --json title,body,state,url`で読み戻し、対象repo・本文・URL、決定・合意範囲・根拠・未解決事項を確認する。

   通信断などで結果が不明なら、一覧と本文からGitHub上の実状態を確認してから再試行する。確認できない間は公開完了とせず、本文・判明した状態・残る確認を引き継ぐ。権限不足なら本文を保持して必要な対応を伝える。

   本文の不足・不一致は要求・合意・根拠と照合して修正し、再度読み戻す。判断を左右する不足は[十分性の判断](sufficiency.md)に戻す。

   Issue URLと合意範囲を報告し、[調査成果の引き継ぎ](session.md#調査成果の引き継ぎ)に従って報告の版・共有状態・未完了の操作を渡す。変更前の確認を報告改訂やIssue更新に流用しない。
