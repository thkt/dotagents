---
name: implement
description: 合意済みGitHub Issueを実装し、検証・独立評価を経てPRを作成する。文書のみの変更を含め、Issue番号やURLを指定した開発依頼に使う。
---

# IssueからPR作成

対象Issueが不明なら確認する。このスキルの実体から[development.ts](../../scripts/development.ts)を解決し、呼び出し元のrepoを指定して実行する。小さな変更と文書変更も合意済みIssueに紐づける。対象のREADME・開発方針・適用される指示を読み、[対象repoの設定](../../scripts/README.md#対象repoの設定)でcheckout・Issue・remote・公開先・base branch・検証・必要媒体を照合する。対象repoにBunやPlaywrightの構成を推測で追加しない。ハーネス自身はBunで実行する。

対象の設定や検証が未設定なら依存する実行を止める。要求変更は人の合意へ戻す。GitHubにはユーザーの既存gh認証でアクセスし、実効ユーザーと対象repoの権限を確認する。認証や権限が不足する場合は停止し、別の主体へ自動切替しない。

文書のみの変更も同じ入口で扱う。実装に伴う更新と共通の[文書更新の方針](../../DEVELOPMENT.md#ドキュメントの更新)を適用する。何を変更するか未確定の相談やレビューだけの依頼は、その依頼の範囲で扱う。

```sh
bun /absolute/path/to/trusted/scripts/development.ts 99 --repo /absolute/path/to/target-checkout
```

文書とPR本文は[日本語確認の方針](../../DEVELOPMENT.md#issuepr文書の日本語確認)に従い、ホストがGeminiの確認・修正と意味の照合を行う。利用不能によるスキップ記録があれば、Gemini未実施の理由と通常の検証結果を分けて報告する。`writing_failed`では原文と候補を保持して停止理由を確認し、公開処理だけを直接呼んで迂回しない。

検証・独立評価・検証済み対象の同一性確認を経て、明示的な開発依頼はPR作成までを含む。「公開しない」指定は`--no-publish`へ渡す。スキルの自動選択だけを公開許可にしない。人の承認・マージは含めない。

結果に`rendered_media_check`があれば[公開後の確認手順](../../scripts/README.md#prへの画像動画の添付)に従い、PR内の画像表示・動画再生と配置・説明の読みやすさを確認し、必要なら本文を整える。PR URL、検証結果、未確認事項、または停止理由と記録の場所を返す。
