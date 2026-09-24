# scopingの調査成果を共有する保存先

確認日: 2026-09-15。対象: thkt/dotagents。[Issue #64](https://github.com/thkt/dotagents/issues/64)で合意した保存先整理の根拠を記録する。提案の実装・採用状況は同Issueに紐づくPRから確認する。

## 問いと確認した事実

調査成果を別の開発者やcloneから参照でき、コードと合わせてレビューできるようにするには、何をリポジトリへ残すべきか。

調査元の[discovery.ts](https://github.com/thkt/dotagents/blob/20b2c7ebde7b01735714dde43887e1ca1aec27be/scripts/discovery.ts)は、報告にセッションの絶対パスとrevisionを付け、checkout外のcontextDir/researchへ保存していた。Gitでcloneしてもこの保存先の内容は引き継がれない。セッションはGit管理ディレクトリに紐づき、別cloneによる同じcontextDirの利用は拒否される。

[development.ts](https://github.com/thkt/dotagents/blob/20b2c7ebde7b01735714dde43887e1ca1aec27be/scripts/development.ts)は、開始元がcleanであることを確認し、committed HEADから実装worktreeを作る。調査報告を未コミットのまま退避してcleanにしても、実装worktreeへは渡らない。

## 結論と適用条件

共有する調査成果は、セッションに紐づく対象checkoutのresearch/へ報告本文だけを保存し、通常の変更・PRに含める。セッション状態・評価・lockはGit管理外に残す。保存名はscoping-research-storage.mdのように内容を表すものにする。本文のハッシュは一致判定には使えるが、人が内容を探す手がかりにならない。同じ調査の改訂は同じファイルに反映し、Gitで履歴を残す。archiveは入力Markdownの名前を使い、同名の別内容を自動で上書きしない。

引き継ぎ時は、確認済みの報告本文が開始元のHEADに含まれることと、checkoutがcleanであることを確かめる。共有先は報告を含むコミットを取り込み、現在の要求に対する評価を新しいセッションで行う。保存・コミット・公開の状態は別々に報告する。現行手順は[保存・評価CLI](../../skills/scoping/references/session.md)を参照する。

既存の外部保存庫の一括移管は行わない。そこには会話記録・内部評価・ホスト固有情報が含まれ得るため、再利用する根拠を選び、共有用の報告として確認する。採用した仕様や方針は関連する既存ドキュメントやIssueへ反映する。

## 検証と残る制約

[CLIの回帰テスト](https://github.com/thkt/dotagents/blob/f85cdbf1a266c1d8f407deb2a1e89b5a20cbe4f4/scripts/tests/discovery.test.ts)で、入力本文の保存、再保存、既存内容の保全、保存先のsymlink・Git ignoreによる拒否、Git経由のworktree・cloneへの引き継ぎ、セッション評価の分離を確認する。実行結果と独立評価は対応PRに記録する。

保存CLIは報告本文の機密性や十分な説明を自動判定しない。共有する本文と公開範囲の確認は担当者が行う。Gitへの保存や十分性gateの成功は、仕様の採用・要求の合意・実装許可の代替にはならない。実モデルによるscopingから実装までの通し試行は、この調査では行っていない。
