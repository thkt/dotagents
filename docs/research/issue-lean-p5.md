## 実施時期の変更

2026-09-17の計画見直しにより、初回は[#84](https://github.com/thkt/dotagents/issues/84)の専用校正廃止→[#83](https://github.com/thkt/dotagents/issues/83)の専用状態管理廃止とする。本Issueは着手を保留し、その2件の結果を見て再優先付けする。元checkoutの段取りを減らす価値は残るが、個別の開始判定を増やすため、初回のコード削減から分ける。

## 目的と現状

実装に使わない未コミット作業を退避・commit・復元する段取りをなくす。現在は確定したHEADから隔離worktreeを作るにもかかわらず、元checkout全体がcleanであることを要求している。

## 範囲と完了条件

- [ ] 全体のcleanを要求する代わりに、開始commit、そのcommitの対象設定、選択した必要報告の版を照合する。実装先は確定したcommitから作る隔離worktreeのままにする。
- [ ] 元checkoutの `.dotagents.json` が開始commitと異なる場合、必要報告の欠落・未commit・本文不一致、開始commitの不一致は、モデル起動前に停止する。必要な未commit成果物を自動で取り込まない。
- [ ] 無関係な追跡ファイルの差分と未追跡ファイルがあっても開始でき、元checkoutの内容・モード・追跡状態を保持する。stash、reset、clean、一括addを行わない。
- [ ] 実装先へは確定commitの内容だけを渡し、確認した設定・報告の版と一致する。準備中のHEAD変更、repo・fetch/push remote・主体の不一致を既存どおり拒否する。
- [ ] 開始手順と引き継ぎ説明を新条件に合わせる。未追跡ファイルの自動整理、作業中の状態の移植、旧runの再開は含めない。

## 重点的に確認する振る舞い

`development.test.ts` と対象・報告の既存検証を使う。無関係な差分がある元checkoutから実worktreeを作り、その差分が実装先へ紛れず、元の内容が保全されることを確認する。必要な入力だけが変わったケースと準備中の変化も確認し、無関係な差分との扱いを分ける。

## 既存Issueとの分担

[#64](https://github.com/thkt/dotagents/issues/64)の元checkoutをcleanにする条件を、対象入力の照合へ置き換える。[#70](https://github.com/thkt/dotagents/issues/70)と[#73](https://github.com/thkt/dotagents/issues/73)の、必要報告の確認済み版を開始commitから渡す条件は維持する。

## 実施順序

#84→#83の採用後に必要性を再評価する後続候補。#81の完了は前提にしない。

## 検証と引き継ぎ

対象repoのセットアップは `bun install --frozen-lockfile --ignore-scripts`、提出前の検証は引数なしの `bun run check`。既存の検証を再利用し、不足する現実的な失敗条件だけを追加・更新する。削除する検出条件は理由と残る検証を示す。独立評価と、同じPR headの `checks`・`verify` を確認し、人がレビューとマージを判断する。

プロダクト画面媒体は不要。必要な共有報告は `research/`、内部の確認記録は既存CLIのcheckout外保存先へ置く。模擬コマンドの制御テスト、実モデル、実際の公開は別の証拠として扱う。

要求と合意、対象版・公開権限の照合、独立評価、人の承認を維持する。旧run・失敗記録・他作業の差分を削除・変換せず、予算の変更や自動再開を含めない。新しい実行エンジンや承認工程は作らない。

## 根拠と合意

確認日: 2026-09-17。調査版: `0b3c61115337c15f14db41ea8f3fee5291497e45`。

- [scripts/development.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/development.ts)
- [scripts/target.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/target.ts)
- [scripts/research-handoff.ts](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/research-handoff.ts)
- [skills/scoping/references/session.md](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/skills/scoping/references/session.md)
- [scripts/README.md](https://github.com/thkt/dotagents/blob/0b3c61115337c15f14db41ea8f3fee5291497e45/scripts/README.md)

依頼者はリーン生産方式を参考にした簡素化を依頼し、P1〜P6の修正計画を提示した後、2026-09-17にscopingでIssue化するよう指示した。本Issueはそのうちの範囲を定める。今回の作業はIssue公開までで、実装・マージは未実施。改善時間や品質への効果は未計測である。

今回必要な根拠と条件は本Issueと上記のコミット済み参照に含めたため、追加の必須調査報告はない。ローカルの計画・Issue下書きは未コミットであり、実装入力の前提にしない。実装または調査の開始時には、先行変更を含む採用済みHEADで参照の適用性を再確認する。調査版を後続作業の開始commitへ固定しない。
