# Issueへの反映

合意した要求を公開・更新するときに使う。依頼と既存の許可範囲に従い、対象・合意・実行条件を担当者が照合する。保存・評価CLIはIssueを作成しない。

1. [対象repoの設定](../../../scripts/README.md#対象repoの設定)を照合し、信頼するスキル実体から解決した `scripts/target.ts CHECKOUT [ISSUE_URL] --write` をBunで実行する。checkout・設定のrepo・fetch/push remote・base branch・ghの主体と権限を確認し、不一致や未設定は公開前に解消する。`gh api user` の主体がIssue作成・更新を行う。Issue URLのrepoを数字だけへ変換して別repoへ流用しない。`gh issue list --repo OWNER/REPO --state all --search '関連語'`と候補の本文で重複を調べる。指定されたIssueは`gh issue view NUMBER --repo OWNER/REPO --json title,body,state,url`で読む。
2. 目的、今回の範囲、完了条件、対象repo固有のセットアップ・検証方法・必要媒体と保存先、合意の根拠を、リポジトリ内のMarkdown本文へまとめる。下書きは`research/issue-N.md`や`issues/`へ保存し、任意名を使う場合は[対象選択の設定](../../../scripts/README.md#日本語の確認と修正)の`writing.exclude`に指定するかfrontmatterに`writing-purpose: issue`を記載する。調査報告を兼ねる本文もIssue用途として除外する。実装方法の細部や試行管理の条件を要求へ混ぜず、未合意事項を合意済みと書かない。
3. 要求の抜け・矛盾・曖昧さ、既存の要求と会話の合意・根拠との一致を確認する。未確定事項を合意済みにせず、必要な独立評価と人の合意を維持する。Issue本文・下書きはGemini校正とその候補の意味照合の標準対象外であり、通常の作成・更新では起動しない。校正対象外を要求精査の省略や正しさの保証にしない。別に作成した人向け調査報告には[日本語確認CLI](../../../scripts/README.md#日本語の確認と修正)を適用し、Issue本文を校正入力へ混ぜない。
4. 公開直前にも対象とghの主体・権限を再照合する。Issueと後続のimplementによるPRは、確認したユーザーのgh認証で作成する。新規なら`gh issue create --repo OWNER/REPO --title '要求を表すタイトル' --body-file PATH`で作成する。既存Issueの更新が依頼範囲なら最新本文を読み、既存の要求・他担当の内容を保持して`gh issue edit NUMBER --repo OWNER/REPO --body-file PATH`で反映する。重複候補の範囲が異なる場合は勝手に統合しない。
5. 返されたIssueを`gh issue view`で読み、対象repo・本文・URLを確認する。通信断などで作成結果が不明なら一覧と本文を照合してから再試行し、重複作成しない。権限不足の場合は本文を保持して、必要な対応を伝える。
6. セッションのnoteへIssueの参照と今回の決定を残し、再評価・調査保存を終える。[調査成果の引き継ぎ](session.md#調査成果の引き継ぎ)に従い、共有する報告を含むコミット・公開先をIssueへ記録する。Issue URLと合意範囲に加え、報告の保存・コミット・公開の状態を伝える。商品実装や実装CLIの起動はこの呼び出しに含めない。
