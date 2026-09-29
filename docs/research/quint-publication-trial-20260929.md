# 検証後の版変更と送信内容をQuintで調べた試行

2026-09-29、依頼者の「試行しましょう」に基づくローカル調査。**確認と送信の間にブランチが変わると、未検証のcommitが送信される経路を再現した。** Quintの反例と、現行の実行入口を通したローカルGit送信で同じ順序を確認した。後続の対象照合は停止するが、送信済みの内容は取り消せない。

推奨は、送信元を検証済みSHAに固定する修正を別途検討することと、状態遷移を扱う要求整理で操作の境界を明示すること。Quintの常設、共通checkへの追加、実装修正、GitHubへの公開は行っていない。試行の許可をこれらの採用への合意とは扱わない。

[前回のTLA+試行](formal-state-trial-20260921.md)は予約・中断・再起動を扱い、追加の検出力を確認できなかった。今回は対象版と送信を扱う。前回の結果を覆す比較実験ではない。

## 問いと対象版

問いは「実装前に状態と守る条件を明示し、モデル検査すると、公開前の対象確認で省いている前提を具体化できるか」。試行前の仮説は、確認と外部操作を別の遷移にすると、間に入る変更の影響を観測できる、というものだった。

コードの基点は `8d452eade4824e300b80b7b0b874595330976b53`。以下のコード・試験環境に未コミット差分がないことを確認した。既存の方針・スキル等には別作業の未コミット変更があり、今回変更していない。

- [orchestrator.ts](https://github.com/thkt/dotagents/blob/8d452eade4824e300b80b7b0b874595330976b53/scripts/implement/orchestrator.ts): `unchangedTarget` でcommitとブランチを確認した後、`pushArguments`、PR一覧照合を経てpushする。
- [target.ts](https://github.com/thkt/dotagents/blob/8d452eade4824e300b80b7b0b874595330976b53/scripts/shared/target.ts): `pushArguments` が送信元をブランチ名にする。
- [publish.ts](https://github.com/thkt/dotagents/blob/8d452eade4824e300b80b7b0b874595330976b53/scripts/implement/publish.ts): draft公開と公開後の照合。モデルではPR作成自体を扱わない。
- [development.tsの試験環境](https://github.com/thkt/dotagents/blob/8d452eade4824e300b80b7b0b874595330976b53/scripts/tests/support/development.ts): 実行入口とGitの操作を使い、担当AI・評価・GitHub応答を模擬する。

## 守る条件とモデルの前提

守る条件は「そのrunが送信したcommitは、そのrunで検証したcommitと一致する」。送信後のブランチが永久に同じであることは要求しない。

[publication.qnt](quint-publication-trial/publication.qnt)の状態は、現在の版、検証済み版、工程、送信済み版の4項目。初期版0と変更後の版1だけを扱い、検証後から送信前までに外部主体が一度だけブランチを更新できる。停止したrunは再開しない。変更は実運用で観測した事故ではなく、実行順序を調べるための注入である。

| 操作 | 意味と実装との対応 |
| --- | --- |
| `verify` | 成功した検証の対象版を記録する。検証処理内部は省く |
| `inspect` | 送信前の対象版照合。不一致なら停止する |
| `change` | 別主体がローカルブランチを進める。ハーネスの通常操作ではない |
| `branchPush` | push実行時にブランチを解決して送る。現行refspecに対応する |
| `pinnedPush` | 検証済みSHAを送る比較案。実装には未採用 |

一つのrun、ブランチ、送信だけに絞った。隔離checkoutへ他の主体が書き込まない運用なら、今回の反例の前提は成立しない。ネットワーク障害、remote側の更新競合、認証、Issue変更、PR本文、ready切替、複数run、巻戻し、電源断は検査していない。停止や待機を許す安全性の検査であり、進行性・公平性は評価対象外。

## モデルの粒度によって結果が変わった

[results.json](quint-publication-trial/results.json)は4条件の実測。TLCで有限状態を探索した。反例ありの条件は発見時に停止しているため、その状態数を全探索の規模として比較しない。

| 条件 | 結果 | 異なる状態数 | CLI経過秒 |
| --- | --- | ---: | ---: |
| 照合と送信を一つにまとめる `atomicStep` | 反例なし、探索完了 | 5 | 4.230 |
| 照合を省く対照 `uncheckedStep` | 反例あり | 5 | 3.907 |
| 照合とブランチ送信を分ける `splitStep` | 反例あり | 8 | 3.951 |
| 送信元を検証済みSHAにする `pinnedStep` | 反例なし、探索完了 | 8 | 3.920 |

`splitStep`の反例は「版0を検証 → 版0との一致を確認 → ブランチを版1へ更新 → 版1を送信」。初期状態を含め5状態で不変条件を破った。照合を意図的に省いた対照でも反例が出たため、検証器が性質を検査していることを確認できた。

粗いモデルの成功を実装の保証と解釈すると、この競合を見落とす。今回の収穫は、検証器の合否に加え、実装で別々に行う読取りと書込みを一つにまとめていないかを確認する観点を具体化できたことにある。

## 実行入口とローカルGitで反例を再現した

[push-race.test.ts](quint-publication-trial/push-race.test.ts)で現行の `develop` を呼び、pushコマンドの実行直前に別のcommitを作った。送信先だけを一時bare repoへ置き換え、file転送を許可した。その他のpush引数は現行コードが生成したものを使った。実際に受信したcommitと `result.txt` の内容を確認した。検証成功の応答はfixtureで模擬しており、実モデルによる評価を経た公開試行ではない。

| 条件 | 受信した内容 | 送信後の観測 |
| --- | --- | --- |
| 変更なし | 検証済み版、`implemented` | 模擬公開フローは `published_draft` |
| 照合後に変更 | 未検証版、`unverified` | 模擬公開の呼出し後、対象不一致で `stopped` |
| SHA固定案で同じ変更 | 検証済み版、`implemented` | 送信内容だけを評価。以降の公開フローは未検証 |

最終実行は3件成功、0件失敗、1.441秒。[probe-results.json](quint-publication-trial/probe-results.json)にcommitの対応を保存した。これらは反例を再現したことを成功とする調査用テストであり、現行処理が競合を防いだという意味ではない。

Gitの送信は実操作だが、GitHubと実モデルは呼んでいない。SHA固定案では既存fixtureのPR応答がローカルHEADを返すため、実remoteと一致しない。この条件の送信後の停止は、比較案の実GitHub挙動の証拠に使わない。今回は `publish` 自体もfixtureの模擬関数であり、実PRが作られることを再現した結果ではない。

## 既存テストとの差と採用判断

[development.test.ts](https://github.com/thkt/dotagents/blob/8d452eade4824e300b80b7b0b874595330976b53/scripts/tests/implement/development.test.ts)の `head_changed` は検証側でHEADを変え、送信前の停止を調べる。`ci_final_target_changed` などは公開後の対象変化を調べる。[target.test.ts](https://github.com/thkt/dotagents/blob/8d452eade4824e300b80b7b0b874595330976b53/scripts/tests/shared/target.test.ts)には、実Gitを使い要求外のタグの送信を抑止する例がある。

確認したこれらのケースには、最後の照合後・push直前にブランチを変更し、受信commitまで確認する条件はなかった。全テストの意味を網羅的に監査した結論ではない。

コード読解の時点で競合を疑ってからモデルを作っている。Quintだけが発見できた欠陥とも、Quintが通常のレビューより優れるとも主張しない。ただし、今回のモデルから得た順序を具体的な再現ケースへつなげられた。状態遷移が問題になる要求では、この使い方を候補にできる。

修正候補は、検証済みSHAをpush引数へ引き渡すこと。単に再照合を一回増やしても、照合と送信の間は残る。SHA固定は送信内容を拘束するが、対象・権限・remote更新の競合全体を解決しない。既存の照合を残し、公開処理が同じSHAを最後まで使うこと、既存PR修正や通常の送信への影響を別途確認する必要がある。後続の下書きは `.issue-drafts/quint-publication-followup.md` に置くとしていた。

参照の補足（2026-09-30）：この下書きは公開ツリーに存在せず、参照不能である。対応する公開Issue・PRは今回確認できなかった。GitHubの取得も失敗したため、後続が未公開であると断定するものではない。下書きの公開や内容の再構成は行わず、上記の修正候補と当時の未確認事項を保持する。

## 再現手順と環境

Quint 0.32.0と、Apalache 0.56.1に同梱されたTLC 2.19を使った。実行環境はTemurin JRE 21.0.12.1+1、Bun 1.4.2、macOS arm64。TLCはworker 1、heap 512MB、stack 4MB。QuintのTLC経路はデッドロック検査を無効にする。探索のfingerprintとseedはCLIが選び、生ログに残るが固定していない。

Quint・Java・Apalacheは一時領域へ取得し、repoの依存や共通登録を変更していない。以下は一時領域で環境を用意する例。`trial` は利用者が選ぶ新しい一時ディレクトリ、`trial_java_bin` は展開したJREの `Contents/Home/bin` とする。

```sh
npm install --prefix "$trial" --ignore-scripts --no-audit --no-fund @informalsystems/quint@0.32.0
```

[Apalache v0.56.1の配布物](https://github.com/apalache-mc/apalache/releases/download/v0.56.1/apalache.tgz)を `$trial/cache/apalache-dist-0.56.1/` へ展開する。その下に `apalache/lib/apalache.jar` がある状態にする。[Temurin JRE配布物](https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.12.1_1.tar.gz)も一時領域へ展開する。

repoルートから次を実行する。Python標準ライブラリのみを使う。モデルごとの上限は90秒で、反例・正常完了・ツール失敗を分ける。ログは指定した出力先へ保存される。

```sh
QUINT_HOME="$trial/cache" PATH="$trial_java_bin:$PATH" \
  python3 docs/research/quint-publication-trial/run-models.py \
  "$trial/node_modules/.bin/quint" "$trial/results"
bun test docs/research/quint-publication-trial/push-race.test.ts
```

モデルのSHA-256は `c7c4896efded47bdbd15fd705056164e48a8b2778451588799a01a5655a6638b`。JREアーカイブは `dec50fc6f9fcd4fe3ae8cabf5a5fa68f6afc48841f7698e468e9aa5d54beed84` で公式チェックサムと一致した。Apalacheアーカイブは `91125e5a3646b9c9d3a7d921d3323f321fac5071909f72b3960c66ff2f998ee1`。後者は取得物の識別用であり、公式チェックサムとの独立照合ではない。

初回はsandboxがローカルポートのbindを拒否した。モデルを変えず、許可されたsandbox外実行で検査した。最初の版確認ではJava未導入も確認し、一時JREを取得した。CLI実行4条件の合計は16.008秒だが、取得、モデル作成、初回試行、再現コード、報告作成、共通checkを含む総費用ではない。モデル60行に加え再現コードと実行補助が必要になった。対話モデルの使用量・金額、将来の保守費用、他手段との速度比較は未測定。

試行の基点資料は [Zenn記事](https://zenn.dev/nrs/articles/10a331bae98bc4)。実行方式は [Quint CLI公式資料](https://quint.sh/docs/quint)と導入版の `--help` を照合した。網羅探索の範囲はこの有限モデルに限り、実装との機械的な対応証明や独立評価は未実施。

## 保存・検証の状態

モデル、再現コード、結果はローカル保存。生ログ・取得物は `/tmp/dotagents-quint.fIYA2m` にあり、恒久保存は保証しない。GitHubへのIssue作成、commit、push、PR公開は行っていない。既存wiki・スキルの規則は変更していない。

`bun run check` は終了0。lint・書式・複雑度・型・未使用検査を通過し、制御テスト450件が成功、失敗0件、未実行なしだった。制御テストの表示時間は107.16秒。調査用の3テストとモデル検査は共通checkとは別に実行した。

日本語は固定版 `natural-japanese` のクイック手順で確認した。長い環境説明を分割し、タグ送信の説明を簡潔にした。語彙の反復と対象外・費用の列挙は、用語と条件を明確に保つため残した。観測値・条件・限界は実行結果と照合した。別評価者による独立評価と人の採用判断は残る。
