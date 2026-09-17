# Issueへの反映

合意した要求を公開・更新するときに使う。依頼と既存の許可範囲に従い、対象・合意・実行条件を担当者が照合する。公開前の下書きはローカルで扱い、保存を公開許可に読み替えない。

1. [対象repoの設定](../../../scripts/README.md#対象repoの設定)を照合し、信頼するスキル実体から解決した `scripts/target.ts CHECKOUT [ISSUE_URL] --write` をBunで実行する。checkout・設定のrepo・fetch/push remote・base branch・ghの主体と権限を確認し、不一致や未設定は公開前に解消する。`gh api user` の主体がIssue作成・更新を行う。Issue URLのrepoを数字だけへ変換して別repoへ流用しない。`gh issue list --repo OWNER/REPO --state all --search '関連語'`と候補の本文で重複を調べる。指定されたIssueは`gh issue view NUMBER --repo OWNER/REPO --json title,body,state,url`で読む。
2. 目的、今回の範囲、完了条件、対象repo固有のセットアップ・検証方法・必要媒体と保存先、合意の根拠を、リポジトリ内のMarkdown本文へまとめる。既存の下書きがあれば更新し、新規なら`research/issue-N.md`や`issues/`など、用途が分かる場所でローカルに扱う。未解決事項と次の判断も必要な範囲で残し、質問ごとの転記や別の再開台帳は作らない。実装方法の細部や試行管理の条件を要求へ混ぜず、未合意事項を合意済みと書かない。
3. 要求の抜け・矛盾・曖昧さ、既存の要求と会話の合意・根拠との一致を確認する。未確定事項を合意済みにせず、必要な独立評価と人の合意を維持する。人向けの調査報告も[日本語確認の方針](../../../.codex/DEVELOPMENT.md#pr本文人向け文書の日本語確認)に従い、原資料との照合と既存の評価を行う。
4. 公開直前にも対象とghの主体・権限を再照合する。Issueと後続のimplementによるPRは、確認したユーザーのgh認証で作成する。新規なら`gh issue create --repo OWNER/REPO --title '要求を表すタイトル' --body-file PATH`で作成する。既存Issueの更新が依頼範囲なら最新本文を読み、既存の要求・他担当の内容を保持して`gh issue edit NUMBER --repo OWNER/REPO --body-file PATH`で反映する。重複候補の範囲が異なる場合は勝手に統合しない。
5. 返されたIssueを`gh issue view`で読み、対象repo・本文・URLを確認する。通信断などで作成結果が不明なら一覧と本文を照合してから再試行し、重複作成しない。権限不足の場合は本文を保持して、必要な対応を伝える。
6. 公開したIssueから今回の決定、合意範囲と根拠、未解決事項、次の判断を辿れることを確認する。Issue URLと合意範囲を報告し、[調査成果の引き継ぎ](session.md#調査成果の引き継ぎ)に従って必要な報告と共有状態を実装担当へ渡す。商品実装や実装CLIの起動はこの呼び出しに含めない。
