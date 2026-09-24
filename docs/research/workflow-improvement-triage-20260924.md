# 蓄積した記録から選ぶフロー改善

確認日: 2026-09-24。公開Issueの状態とmain `7369b8cf3208ebefe7b4dc0f82be3830eea8b9f7`を再照合した。本文は次の作業を選ぶための記録であり、新たな実装合意ではない。

## 現在の判断

**新しいIssueは[#228](https://github.com/thkt/dotagents/issues/228)の一件**。[scoping参照分離の試行](scoping-reference-separation-trial-20260923.md)を現行版で評価し、採用・修正・見送りを決める調査Issueとして公開した。現時点で参照分離による品質・費用の改善は示せていないため、候補ファイルをそのまま採用する実装Issueにはしていない。

前回の整理直後に公開状態が更新され、[#196](https://github.com/thkt/dotagents/issues/196)、[#202](https://github.com/thkt/dotagents/issues/202)、[#209](https://github.com/thkt/dotagents/issues/209)、[#212](https://github.com/thkt/dotagents/issues/212)などはCLOSEDになった。#196・#202・#212にはPR参照が付いている。[#198](https://github.com/thkt/dotagents/issues/198)も後にPR #224への参照を伴ってCLOSEDになった。[#203](https://github.com/thkt/dotagents/issues/203)・[#205](https://github.com/thkt/dotagents/issues/205)・[#206](https://github.com/thkt/dotagents/issues/206)はローカルHTMLを扱う完了記録をIssue本文へ残して閉じられている。公開直前にOpenの既存Issueはなかった。#228でこれらの範囲を重ねない。CLOSEDをすべてmain上の機能導入と読み替えず、実装に進む際はPR・成果物の現在版を照合する。

## Issue #228の範囲

公開した題名: **scopingの参照分離を実務ケースで検証し採否を決める**。

目的は、要求整理が必要な参照だけを読み、要求・失敗条件・合意・権限の確認を維持できるかを調べること。対象はscopingの入口と条件付き参照に絞り、implement、runtime、公開権限の設計変更は含めない。

根拠と未確認点は次のとおり。

- [既存試行](scoping-reference-separation-trial-20260923.md)は合成した二つの依頼を各条件一回比較し、改訂版で想定した参照選択を確認した。一方、両ケースで総入力・出力tokenは増え、請求費用は測っていない。実務の要求整理からIssue公開までの再現性も未確認。
- ローカル候補では、元のSkill本文にあった要求と合意の整合確認の一部を`session.md`へ移したが、その参照は報告が必要な場合に限定している。`sufficiency.md`にも整合確認が残るため、報告不要の下書きで確認漏れが起きると断定しない。到達性を確認する。
- 比較元main `7134d2f`の[`skill-eval.ts`](https://github.com/thkt/dotagents/blob/7134d2ffa441985ee00d2dd1a6b6e79f5e9cc4ae/scripts/skill-eval.ts#L26)は、全`instructionFiles`をbefore/after両commitから通常ファイルとして読む。候補で追加する参照をそのまま比較入力に渡せない静的制約があった。試行の実行失敗を再現したわけではなく、現行版で比較方法を先に確認する。

完了条件:

1. 現行mainとローカル候補の差分を取り、関係ない未commit変更を評価入力から除く。
2. 「短い下書き」「再利用する調査報告」「Issue公開・更新」の各場面で、読む必要のある参照、要求の整合、失敗条件、許可範囲を確認する。参照を読まないことだけを成功条件にしない。
3. 保存済みの試行と静的確認で採否を判断できるか先に決める。不足する問いがあれば、同じ依頼・モデル・入力条件で実務に近い小さな比較を行い、要求充足、読込み量、時間、費用を測定範囲ごとに分けて記録する。新規参照を比較元だけへ誤って注入しない。
4. 採用・修正・見送りとその理由をIssueに残す。採用する場合は対象ファイル、既存の経路・保証を維持する条件、検証方法を確定して実装へ引き継ぐ。

既存の同条件eval入口を使える条件を調べることはこのIssueの方法に含む。入口を汎用的に拡張する別Issueは、必要な比較が既存手段でできないと確かめてから範囲を決める。

## 既存Issueと再検討条件

[#198](https://github.com/thkt/dotagents/issues/198)は、Issue取得と既存PR修正の対象照合の責任を分ける保守改善としてCLOSED。採用内容の確認が必要な場合はPR #224とmainのコードへ戻る。

[#197](https://github.com/thkt/dotagents/issues/197)は調査を終えてCLOSED。成功checkの再利用は現状維持で、同じ成果物snapshotでも依存や環境の変更により結果が変わる。限定したcheckの入力・環境と削減できる実行頻度が具体化したときに再検討する。[#204](https://github.com/thkt/dotagents/issues/204)・[#207](https://github.com/thkt/dotagents/issues/207)も調査済みでCLOSED。図の追加集約や公開順序の新しい仕組みを、結果の確認なく提案し直さない。

[TeamAIの試行](teamai-recall-evaluation.md)、[CodeGraphの評価案](issue-codegraph-evaluation.md)、[Portlessの試行](portless-worktree-trial-20260923.md)、[tantekiの試行](tanteki-evaluation-20260924.md)などは参照資料として保つ。必要資料の見落とし、repo外知識の探索負担、UI操作の保守負担など、対象とする困り事が実際に出た場合にその問いへ必要な比較を行う。既に採用した実行ログHTML、同条件eval入口、テストカタログ、日本語lint、fallowは新規Issueの候補から外す。

原因調査で既存記録から答えられない問いが出た場合は、その問いに必要な記録だけ補う。記録量や定期実行を先に増やさない。

## 確認と共有状態

前回の整理記録は公開Issueの状態更新により優先順が古くなったため、同じファイルを書き直した。#228の公開本文は[ローカル下書き](issue-scoping-reference-separation-evaluation.md)と一致し、URL・題名・OPEN状態を読み戻した。この報告と下書きは未commitで、スキル・runtimeは変更していない。前回の`bun run check`は当時のHEAD `16d70c2`と既存未commit差分で366件成功・失敗0件だった。現在のmain `7369b8c`の試験結果ではない。
