<!-- 生成元: references/private/dotagents.md。直接編集せず、正本を変更して再生成してください -->

# thkt/dotagentsの私用版

私用版は`contract.md`の呼出し仕様に従い、次の点だけが異なる。プラグイン版のCLIは`.dotagents.json`を読まず書かない。

## `.dotagents.json`との接続

| 操作 | 私用版の動作 |
| --- | --- |
| `inspect` | `.dotagents.json`があれば`configFiles`へ含める |
| `apply`（`.dotagents.json`あり） | `.dotagents.json.feedbackCheck`を対象package managerの`check:feedback`呼出しへ設定し、標準出力のJSONの`feedbackCheck`へ同じ値を出す |
| `apply`（`.dotagents.json`なし） | 接続を省いたことを表示して終了0にする。標準出力のJSONの`feedbackCheck`は`null`である |
| `apply --update` | `.dotagents.json`を変更せず、`feedbackCheck`と接続先の差分を表示する |

`.dotagents.json`へ分類やrunnerの設定を追加しない。分類とrunnerの設定は`.feedback-loop.json`に置く。

`.dotagents.json`の変更は、実行記録にも`dependencies`にもなければ全qualityへ広がる。常に全qualityへ広げる場合は`.feedback-loop.json`の`globalChanges`へ指定する。

## 導入の進め方

`.dotagents.json`の更新を含む導入は、対象repoのimplementを開始する前に行う。実行中のrunが使う設定・旧run・保護規則を変更せず、更新後の設定を新しいrunで固定する。

テスト・fixture・検証接続の作成と変更は独立テスト担当が行う。導入作業の独立テスト・独立評価は省略しない。

共有の検証用repoで成立させた後、展開先へ適用する。実導入結果と未完了箇所は既存のfindings・PR説明に記録する。

実装担当へコマンドが渡る接続確認と、実モデルが実際にそのコマンドを使った観測は区別する。
