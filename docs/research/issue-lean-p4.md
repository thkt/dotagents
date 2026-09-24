## 目的と実施順序

専用のGemini校正・Codex意味照合を共有ハーネスから廃止し、文書の作成と内容評価を、既存の執筆・独立評価・公開前後の確認へ集約する。任意実行の設定や旧経路を併存させず、運用と保守対象の両方を減らす。

今回の初回改修。完了後に[#83](https://github.com/thkt/dotagents/issues/83)の専用セッション管理廃止へ進む。[#81](https://github.com/thkt/dotagents/issues/81)の無変更時の最適化は、対象機能を廃止するため実装しない。

## 廃止する責任と処理

- `writing.ts`、`writing-review.ts`、`writing-targets.ts`の専用校正機能を削除する。校正対象選択、モデルの起動・失敗分類、候補の構造保護、別モデルでの意味照合、校正結果のキャッシュ、採用中状態とファイル置換を廃止する。
- developmentの文書・PR校正呼び出し、correctionのwriting工程、`writing_failed`と関連する新規実行用設定・状態・イベント、codex-actorの`review-text`を削除する。`repair`と`review`、check・captureと通常の公開処理を維持する。
- このrepoの`.dotagents.json`から専用校正設定を外し、スキル・開発方針・CLI説明を更新する。`agy`の実行や認証をハーネス利用の前提から外す。利用者のCLIインストールや認証情報は削除しない。
- 廃止する処理だけを検証するwritingのテスト・fixtureを削除する。同じ機能を別モジュール、汎用hook、追加の校正モードへ移して残さない。

## 残す責任と停止条件

- 執筆担当は、事実・数量・条件・範囲・権限・未確認事項・参照を原資料と照合して文書を作る。既存の最終独立評価が文書とIssue・コード・検証結果の整合、読者が判断できる説明かを評価する。具体的な欠陥は修正へ戻す。新しいモデル呼び出しは追加しない。
- PR本文は既存のacceptedな評価と検証済みcommitから生成する。公開直前のIssue・commit・本文・対象・権限の照合、公開後の本文確認、媒体の実表示確認が必要な場合の担当を維持する。PR本文のためだけの別モデル生成・校正は加えない。
- 成果物を修正した場合は必要なcheckと独立評価を更新する。本文の直接変更でもIssue・根拠・対象commitとの整合を確認し、以前の成功を変更後の版へ流用しない。
- Issue・ソースの変化、無効な応答、プロセス中断、時間・回数の上限、公開先や主体の変化、同じPR headのCIを確認する既存の制御は維持する。
- 現在`writingHostTimeoutMs`は汎用コマンドと公開後の対象照合にも使われている。その用途に必要な有限の制限時間を実行側で保持し、校正の削除に伴って無制限化や予算変更をしない。大規模なプロセス基盤の再設計は含めない。

## 仕様変更と既存利用の扱い

専用校正による文体の統一、保護対象の機械比較、別モデルによる校正前後の意味照合は終了する。執筆・既存の独立評価・人の確認に役割を移すが、同じ独立検査を維持したとは説明しない。現行の日本語確認方針と[#59](https://github.com/thkt/dotagents/issues/59)・[#67](https://github.com/thkt/dotagents/issues/67)の専用校正部分を、この範囲で置き換える。

- 旧`writing`設定が対象repoまたはstandalone correction入力に残る場合は、対応終了と必要な変更を明示してモデル実行・公開前に拒否する。設定を黙って無視しない。新しい任意化設定や互換実行経路は追加しない。
- 設定未指定でも校正が走る現在の既定動作も、この版の採用で終了する。共有ハーネスの利用先へ適用する前に影響する方針・設定を確認し、対象ごとに変更を説明する。他repoの方針や設定を一括で書き換えない。専用校正が必要な利用先は、切替前に方針を決め、未解決なら旧版を保持する。
- 保存済みの原文・候補・評価・失敗記録・runを削除、変換、再開しない。実行中の旧版を差し替えず、採用版からの新規実行で新しい契約を使う。

## 完了条件

- [ ] 専用3ファイルと校正の実行経路が削除され、通常の文書変更、コード変更、`--no-publish`、PR公開で専用校正を起動しない。
- [ ] 原資料・変更文書・PR本文の照合と、内容不備を修正へ戻す担当が手順に残る。必要な独立評価や人の承認を校正廃止と一緒に外さない。
- [ ] 旧設定を残した入力は説明付きでモデル実行・公開前に止まり、旧記録を壊さない。新しいモードや校正用stateを導入しない。
- [ ] 既存のdevelopment・correction・review・publish・CIの検証で、対象変化、停止、時間制限、公開抑止とPR本文の根拠を確認する。単なる呼出順の一致を検証目的にしない。
- [ ] 新しいタスクで、文書変更が既存の独立評価へ届き、PR本文が要求・commit・検証結果から作られることを確認する。意味の評価を模擬テストだけで確認済みとしない。
- [ ] 実装・テストとも総量を純減させる。専用3ファイルは調査版で合計777行だが、接続部分の変更や残す検証を含む最終の純減量はPR差分で示す。

## 検証と引き継ぎ

対象は `thkt/dotagents`。セットアップは `bun install --frozen-lockfile --ignore-scripts`、提出前は引数なしの `bun run check`。必要な独立評価と同じPR headの `checks`・`verify` を確認し、人がレビュー・マージを判断する。プロダクト画面媒体は不要。共有が必要な根拠は `research/`、内部の実行記録は既存のcheckout外保存先に置く。

削除した機能だけを守るテストは削除する。残る要求の検出条件は既存テストへ集約し、削除で失う検出条件と代替の確認をPRに説明する。模擬コマンドのテスト、新しいタスクでの手順確認、実モデルの意味判断、実際のGitHub公開を区別する。テスト件数の維持や専用の計測基盤を要求しない。

実装コード・テスト・設定・実行分岐・必須操作について変更前後を示し、実装コードとテストの総量が純減していることを確認する。ファイル移動、圧縮、型検査の回避で量だけを減らす変更は含めない。必要な保証を失って数値を達成しない。

## 根拠と合意

確認日: 2026-09-17。調査版: `0b3c61115337c15f14db41ea8f3fee5291497e45`。

- [scripts/writing.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/writing.ts)
- [scripts/writing-review.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/writing-review.ts)
- [scripts/writing-targets.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/writing-targets.ts)
- [scripts/development.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/development.ts)
- [scripts/correction.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/correction.ts)
- [scripts/codex-actor.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/codex-actor.ts)
- [scripts/pr-body.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/pr-body.ts)
- [.codex/DEVELOPMENT.md](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/.codex/DEVELOPMENT.md)

依頼者は、従来の任意化案ではコード量が増える可能性と、専用校正・discoveryの役割を既存工程へ集約する案を確認した後、scopingで「運用とコードの両面でソリッドにする計画にして進めたい」と指示した。このIssueはその計画変更を反映する。旧本文の任意化と現行機能の併存は採用しない。

要求の正本は本Issue。根拠は本文と上記のコミット済み参照で足りるため、追加の必須調査報告はない。ローカルの計画・下書きは未コミットで、実装入力の前提にしない。実装開始時は先行変更を含む採用済みHEADで根拠を再確認し、開始commitを固定する。今回の作業は計画とIssue更新までで、実装・PR・マージは未実施。
