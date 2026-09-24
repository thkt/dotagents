# fallow・Knipのローカル比較試行

2026-09-21。初回はユーザーの「やってみましょう」に基づく一時コピーでの試行。その後、ユーザーがfallow採用を指定し、[Issue #174](https://github.com/thkt/dotagents/issues/174)へ導入範囲を反映した。以下の試作は採用済み実装と区別する。

初回導入は[PR #175](https://github.com/thkt/dotagents/pull/175)のcommit `37d2685719fc0b378fbbe867ab4c9f8028a99a8f`でレビュー可能な状態まで完了した。main `3f6fd47`の統合後に`bun run check`（363件成功・0件失敗）、独立評価accepted、同じheadのCI `checks`・`verify`の成功を確認し、公開本文の照合とready切替・読戻しを終えた。`verify`の初回はステップ開始前に時間切れとなり、同じcommit・条件でそのジョブを再実行して成功した。停止したrunの記録と時間制限は変更していない。

その後、ユーザーの「修正と、修正候補の調査してみよう」を受けてIssue #174へ局所修正を追加し、同じPRのcommit `4fbc5bbb803c18c58ebb0d981fe51ae8785b2423`へ反映した。Revision型・検証をinput.tsへそろえ、任意ファイル読取りのENOENT処理を共有した。同じ設定・キャッシュ無効の解析で、循環1→0件、semantic重複候補2→1組、通常重複0→0組、未使用指摘0→0件を確認した。残るcapture-config.ts候補は異なる処理と関数境界をまたぐため抽出せず、複雑度2件も別々の拒否条件を保つため分割しない。失敗時の停止・保全を維持し、抑制や新しいゲートは追加していない。

追加修正版は`bun run check`（366件成功・0件失敗）、独立評価accepted、同じheadのCI `checks`・`verify`が成功した。公開本文の照合、ready切替・読戻しも完了した。ユーザーによるマージ後、GitHub上で2026-09-21 07:57:34 UTCのマージとmainのcommit `16d70c23918d69d4dbc01795ac1a886938ee573d`を確認した。他repoへの導入は未実施。

### 共有checkoutへの反映完了

共有ハーネスを使う実行が終了し、切替直前にも稼働がないことを確認して、`~/.agents`のmainをマージ済みcommit `16d70c23918d69d4dbc01795ac1a886938ee573d`へfast-forwardした。未commit文書2件と未追跡87ファイルを`/private/tmp/dotagents-main-sync-final-m8fh8ytj`へ保全し、文書の差分と資料の内容・モード・symlinkを照合した。稼働中の実行があった前2回はGit・依存の変更前に保留しており、過去のrunや別worktreeは変更していない。

事前の隔離コピーでは、保存済み実験の`research/formal-state-trial-20260921/probe.ts`だけが未使用ファイルとして検出された。この当時の1パスを`.git/info/exclude`へ加える対応を隔離コピーで検証し、共有checkoutにも反映した。実験ファイル本体は保持し、共有のfallow設定や検出基準は変更していない。隔離コピーの`bun run check`は366件成功・0件失敗（6754 assertions、114.09秒）だった。現在のファイル位置は`docs/research/formal-state-trial-20260921/probe.ts`であり、移設後の除外設定は新しいパスを指す。

同期後の共有checkoutで`bun install --frozen-lockfile --ignore-scripts`によりfallow 3.27.0を導入し、`bun run check`が366件成功・0件失敗（6754 assertions、103.61秒）となった。fallowの未使用指摘は0件、解析不全もなし。HEADとorigin/mainの一致、lockfileが採用commitのままであること、既存の文書変更と保存資料の保持を確認した。検証ログは`/private/tmp/dotagents-main-sync-final-m8fh8ytj/shared-check.log`に保持している。

このハーネスの共通checkはfallowを使用する。グローバルのKnipは残し、今回削除・更新していない。完了確認時のグローバル版は6.37.0で、初回比較時の6.36.0とは区別する。比較記録も保持し、他repoへの導入やKnipの整理は行っていない。

## 判断

追試により、未使用ファイル・export・循環依存は、実際のTypeScript入口をそろえた条件で両者の検出が一致した。最初の試行は手動指定の入口だけが同じで、自動追加される入口が異なっていた。その結果から「未使用コード検出はKnipを優先する」とした会話中の判断は撤回する。確認できた差は、このrepoのformat設定から入口を追加する挙動の違いであり、検出処理全体の優劣を示さない。

ユーザーは機能の広さと実行速度を理由にfallow採用を指定した。追加試行で、oxfmtの設定に対象の絞り込みを移すと、通常のformat機能と未使用ファイル検出を両立できた。導入範囲・完了条件はIssue #174を正本とする。なお、このrepoの共通checkには元からKnipも入っておらず、既存導入の置換試行ではない。

重複と循環的複雑度は、保守上の問題が出た箇所を調べる補助にはなる。ただし今回の追加指摘から、常設検査や今すぐのリファクタリングが必要だとは判断しない。採用判断では、通常の運用を維持できる設定・調整の負担と、関係する検出条件を確認する。

## 比較条件

- 対象はdotagentsのcommit `59e9f7374c18dba415f9c1512e1b9116a9e8a28d`。一時ディレクトリへローカルcloneし、未commitの変更・未追跡資料を除いた。
- macOS 27.0 / arm64、Bun 1.4.2、Node.js 26.9.0。fallow 3.27.0、Knip 6.36.0、既存Biome 2.5.12を使用。
- fallowとKnipは一時ディレクトリへ版を固定して導入した。対象の依存も固定lockfileからinstallし、install scriptsは実行しない指定を使用した。
- 初回は無設定で調べ、次に実際のCLI・テストの入口を両方へ明示した。入口exportも検査する指定を付けた。この時点では自動追加される入口が異なっていた。後述の追試では、その差を生むformat scriptを同じ比較用コピーから除き、両方のTypeScript入口を25件へそろえた。
- fallowは`--no-cache`、Knipはcacheを有効にせず実行。反復測定は順序を交互にした3回。OSのファイルcacheは冷却していない。
- 生のJSON・stderr・各コマンドの時間を一時領域へ保持。主要結果とコマンド記録は本稿の「実行記録」に統合する。

確認する条件は、既存検査との差、実際に使うコードの誤指摘、意図した未使用コードの検出、設定と実行の負担とした。自動修正は実行していない。

## 未使用コードと循環依存

| 条件 | fallow | Knip | 判断 |
| --- | --- | --- | --- |
| 無設定 | 循環依存1件、未使用0件 | 未使用ファイル30件・export 17件・型4件 | Knipの入口不足とfallowの入口の広さがあり、件数で優劣を決められない |
| CLI・テスト入口を補い、入口exportも検査 | 未使用export 2件、循環依存1件 | 同じ2件と1件。循環検査は明示的に有効化 | この範囲の実コードの指摘は一致 |
| 別コピーへ未参照ファイルを追加 | ファイルとしては見逃す。入口export検査を有効にすると、そのexportを検出 | 未使用ファイルとして検出 | 自動追加される入口が異なる条件での結果 |
| 到達可能な既存ファイルへ未使用exportを追加 | 入口export検査ありで検出、無設定では見逃す | 入口を補った条件で検出 | fallowは入口扱いの影響を受ける |
| 新規moduleを既存入口からimportし、その値を使用 | 使用中のmodule・exportとして扱う | 同じ | この1例では誤削除候補にならない |

入口を補ったKnipの全分類出力には、ホストが提供する`codex`の未宣言binaryも1件出た。これは今回のプロジェクト依存の削除候補ではない。共通分類に絞った時間比較には含めていない。

実コードで一致した指摘は次のとおり。

- `scripts/research-handoff.ts:11`の`reportReferences`と`scripts/revision.ts:288`の`reconcileExecutions`は、同じファイル内から呼ばれるが、他ファイルからの参照は見つからなかった。不要候補は`export`であり、関数本体ではない。
- `scripts/input.ts:2`の`assertRevision` importと、`scripts/revision.ts:5`の`assertConfig`・`assertState` importが循環する。どちらも値のimportで、型だけの循環ではない。循環の存在は確認したが、実害の発生はこの試行では確認していない。

### fallowの見逃しを切り分けた結果

別の一時コピーに、どこからもimportしない`scripts/trial-unused.ts`を追加した。中身は`export const trialUnusedFile = 712;`のみとした。対照として`values.ts`へ未使用exportを追加し、別の`trial-used.ts`は`knowledge.ts`からimportして値を使用した。この対照コードは静的解析だけに用い、実行していない。

fallowの`--trace-file scripts/trial-unused.ts`は、`imported_by: []`・参照数0なのに`is_entry_point: true`・`is_reachable: true`を返した。明示的な入口は25ファイルだが、追加後のdead-code出力は自動発見を含め40入口を報告した。

一時コピーの`package.json`から次の2つのscriptだけを除くと、入口数が25へ減り、この未使用ファイルが検出された。他のlint・複雑度・型検査scriptは残したままの結果である。

```json
{
  "format": "oxfmt --write \"scripts/**/*.ts\"",
  "format:check": "oxfmt --check \"scripts/**/*.ts\""
}
```

この版・構成ではformatterの対象が実行入口扱いになる挙動が、見逃しに関係している。実プロジェクトのformat scriptを削除して回避する案は採用しない。fallow内部の根本原因や、他formatter・別構成での再現性、設定だけで修正できるかは未確認。

`fallow list --entry-points`は無設定で17件、同じ対象の`dead-code.entry_points`は38件と報告した。今回、listだけでは追加された入口を説明し切れず、traceと対照例で判断した。

### 追試: 自動追加される入口の差を除いた比較

ユーザーの「fallowも同じ条件にしたらいいのでは？」を受け、上の対照コードを含むコピーから`format`・`format:check`だけを除いた別コピーを作成し、同じ入力に両ツールを実行した。ソース・手動入口・入口export検査・報告する分類は共通とした。fallowは手動入口25件のみを報告し、Knipのdebug出力でもTypeScript入口25件が同じ集合になることを照合した。Knipが別途読むJSON/YAML設定は残っており、全解析機能を同一化したという意味ではない。

| 観点 | fallow | Knip |
| --- | --- | --- |
| 対照の未使用ファイル | `scripts/trial-unused.ts`を検出 | 同じ |
| 対照の未使用export | `trialUnusedExport`を検出 | 同じ |
| 対照の使用中module・export | 未使用と指摘しない | 同じ |
| 既存の未使用export | `reportReferences`・`reconcileExecutions`を検出 | 同じ |
| 既存の循環依存 | `input.ts`と`revision.ts`の循環を検出 | 同じ |

依存の判定には差が残った。format scriptを除いたコピーでは、Knipだけが`oxfmt`を未使用devDependencyと報告した。これは入力を変更して作った条件での差であり、上のファイル・export・循環の一致と分けて記録する。元の運用で`oxfmt`が不要という意味ではない。

追試は解析2回とKnipの入口を確認するdebug実行1回で、いずれも指摘を含む出力を取得した。実時間はそれぞれ0.238秒・0.370秒・0.258秒。今回の主目的は検出差の切り分けであり、この1組から速度の優劣を再評価しない。初回26回の記録とは分けて、下記「実行記録」の追試3回として残した。

fallow 3.27.0のschemaと[公式設定説明](https://fallow.tools/docs/configuration/overview/)では、`entry`は自動発見に追加する指定である。今回調べたschema・CLI・公式説明では、format script由来の入口だけを外すfallow側の設定は確認できていない。fallowの`ignorePatterns`はファイル自体を解析から外すため、今回の未使用判定の修正にはならない。この時点で未解決だった実運用の調整方法は、次の追加試行で候補を確認した。

### 採用に向けた追加試行: format機能を維持する

元の対照コード入りコピーから、`format`を`oxfmt --write scripts`、`format:check`を`oxfmt --check scripts`へ変更し、`.oxfmtrc.json`の既存指定に`"ignorePatterns": ["**/*", "!**/", "!**/*.ts"]`を追加した別コピーを作った。対象の絞り込みをoxfmtの設定へ移したもので、format機能は残している。oxfmt 0.66.0のschemaでgitignore形式の否定パターンを確認した。

この構成でfallowのTypeScript入口は25件となり、未参照ファイル・未使用exportを検出し、使用中moduleを未使用とは指摘しなかった。devDependencyの未使用指摘はなく、追試でformat scriptを除いた場合と区別できた。

旧・新formatコマンドはどちらも対照を含む40個のTSファイルを検査した。さらに直下・入れ子の未整形TS各1個と、対象外のMarkdown・JavaScriptを追加したところ、両方とも同じTS 2個を不合格とした。write後の変更もこの2個だけで、全scriptsファイルの内容が旧・新で一致した。これで検査の省略による成功ではないことを確認した。

追加の記録済みコマンドは7回（fallow 1回、format検査・修正6回）。対照の未整形TSを検出するcheck 2回とfallowの指摘あり出力は想定どおりexit 1、残り4回はexit 0で完了した。Issue #174にはこの方法と再確認する条件を記載した。新しい実装開始版でのcheckと独立評価は実装工程で行う。

## 重複と複雑度

重複検査の既定値はmild、50 tokens以上・5行以上・2箇所以上。既定で15個の`*.test.*`を除外し、23ファイルを解析した。テスト支援ファイルはこの除外とは別であり、「本番コードだけ」とは扱わない。

| 検査 | 結果 | 指摘を読んだ判断 |
| --- | --- | --- |
| 既定の重複検査 | 0グループ | 対象・閾値内での結果。重複が存在しない証明ではない |
| semantic重複検査 | 2グループ・4箇所 | 識別子・リテラルを正規化した類似候補で、意味の等価性ではない |
| `health --complexity --max-cognitive 15` | 循環的複雑度2件、CRAP 25件 | CRAPの25件は実測coverageではなく`coverage_source: estimated`。未テストや危険の確定根拠にしない |
| 認知的複雑度15だけを閾値として照合 | fallow 0件、既存Biome 0件 | このrepoでは追加指摘なし。両者の計算法が完全に同じという検証ではない |

semantic重複の1グループは`capture-config.ts:64–97`と`:98–108`。異なる設定objectを含み、複数の関数境界をまたぐ範囲なので、そのままの抽出提案は採用しない。もう1グループは`revision.ts:299–305`と`:321–329`の「ファイルがなければundefined、それ以外の読み取り失敗はthrow」という共通部分。類似性は確認できるが、短い2箇所の共通化が総保守費用を下げるかは未確認であり、今回変更しない。

循環的複雑度は`checkRevision`が25、`previousRun`が23で、既定閾値20を超えた。認知的複雑度はそれぞれ12・9。既存Biomeとは別の観点だが、数値を下げるための分割を指示しない。関連変更時に分岐条件や責任を確認するための候補とする。

## 時間と負担

同じcommit・手動入口・入口export設定で、未使用ファイル／export／型／依存と循環依存に出力分類を絞った。自動発見の差は残るので、同等の検出品質を持つ実装同士の一般的なベンチマークとは扱わない。

| ツール | 反復3回の実時間 | 中央値 |
| --- | --- | --- |
| fallow | 0.112 / 0.101 / 0.099秒 | 0.101秒 |
| Knip | 0.320 / 0.352 / 0.239秒 | 0.320秒 |

初回の無設定実行はfallow 0.348秒、Knip 0.377秒。重複検査の初回は0.160秒、semanticは0.177秒。npmによる一時ツール導入は約4秒、対象依存のBun installはツール表示85msだった。測定の区間が異なるため、これらを精密な総時間として合算しない。

初回の探索・切り分け・再試行を含む記録済み解析コマンドは26回、壁時計時間の合計は約5.16秒。そのうち1回は`--max-cyclomatic 100000`が許容上限65535を超え、exit 2で失敗した。65535へ修正した再実行は完了した。残り25回は出力を得たが、出力完了は検出品質の合格を意味しない。help・schema・原コードの読解、版確認、準備、記録作成時間と、後続の入口をそろえた追試3回はこの合計の対象外。

LLM・有料Runtimeは呼び出していない。検査を動かす時間よりも、入口条件の調整と指摘の確認が今回の判断に必要だった。人手で換算した作業時間・金額、継続運用や将来の保守費用は未測定。

## 再実行に必要な設定

両ツールの`entry`へ次を指定した。CLIは`import.meta.main`、起動側、操作説明から選んだ。テスト入口は独自runnerが実行する範囲に対応する。

```json
[
  "scripts/capture.ts",
  "scripts/codex-actor.ts",
  "scripts/correction.ts",
  "scripts/development.ts",
  "scripts/knowledge.ts",
  "scripts/publish.ts",
  "scripts/target.ts",
  "scripts/test.ts",
  "scripts/verify-capture.ts",
  "scripts/verify-review.ts",
  "scripts/tests/**/*.test.ts"
]
```

fallowの設定は`{"entry": 上の配列}`、Knipはそれに`"project": ["scripts/**/*.ts"]`を加えた。設定ファイルは対象repoの外に置き、解析のcwdは固定commitの一時checkoutとした。以下の`fallow`・`knip`は、一時導入した固定版の実行ファイルを表す。

```sh
fallow dead-code --config ../fallow-config.json --include-entry-exports \
  --unused-files --unused-exports --unused-types --unused-deps --circular-deps \
  --format json --quiet --no-cache
knip --config ../knip-config.json --include-entry-exports \
  --include files,exports,types,dependencies,cycles --reporter json --no-progress
fallow dupes --format json --quiet --no-cache
fallow dupes --mode semantic --format json --quiet --no-cache
fallow health --complexity --max-cognitive 15 --format json --quiet --no-cache
fallow health --complexity --max-cognitive 15 --max-cyclomatic 65535 \
  --max-crap 1000000000 --format json --quiet --no-cache
```

最後のコマンドは今回の入力で他の数値閾値が発火しないようにした比較用で、採用する品質基準ではない。

## 範囲と後続判断

試行では元checkoutへ依存、設定、hook、MCP、check、CI、ソースの変更を加えていない。初回試行checkoutの追跡73ファイルは実行前後のSHA-256が一致し、git差分もない。その後の採用指示を受けてIssue #174を公開し、独立した実装工程へ引き継いだ。試行の成功を実装・マージの完了とは扱わない。

未使用検査の対照は、未使用ファイル・未使用export・使用中moduleの小さな例であり、全機能の精度・再現率は評価していない。monorepo、動的な利用、framework固有設定、隠しディレクトリ、type-aware解析、境界規則、有料Runtimeも未評価。境界規則未設定時の0件は検査済みとは扱わない。

採用範囲はIssue #174で管理する。未使用検査を共通checkへ加え、重複・複雑度・循環依存は必要時の調査に使う。既存のlint・型検査・Biomeの保証は維持する。今回の入口差だけを根拠にKnip優位としない。未使用exportの必要な局所修正と、循環依存の存在・未確認の実害を区別して引き継ぐ。

参照: [fallow公式repo](https://github.com/fallow-rs/fallow)、[重複検査](https://docs.fallow.tools/analysis/duplication)、[Knipのissue types](https://knip.dev/reference/issue-types)。版固有の引数・設定は導入した3.27.0 / 6.36.0のhelp・schemaで確認した。

## 実行記録

旧JSONから、対象条件と36回のコマンド実行記録を本稿へ統合した。数値は当時の試行値であり、現行版の速度や検出力を示さない。`${TRIAL}`は隔離した一時領域を表す。生のstdout・stderrはこの文書に収録していないため、SHA-256は後で同じ保存出力が見つかった場合の照合用であり、本文だけから出力を再現する証拠ではない。

初回の対象はcommit `59e9f7374c18dba415f9c1512e1b9116a9e8a28d`、macOS macOS 27.0 / arm64、Bun 1.4.2、Node 26.9.0、fallow 3.27.0、Knip 6.36.0、Biome 2.5.12。追跡ファイル73件に変更はなかった。未使用対照は`scripts/trial-unused.ts`と`trialUnusedExport`、使用中の対照は`scripts/trial-used.ts`と`trialUsedExport`。

記録済みの解析実行は初回26回、入口を揃えた追試3回、採用に向けた追加試行7回で計36回。実行時間の合計はそれぞれ5.155462秒、0.865768秒、0.456821秒、計6.478051秒。準備、読解、報告執筆、GitHub確認の時間は含まない。

以下の表の「出力」は`stdout bytes / SHA-256`を示す。stderrが空でない行だけ別表に記す。終了値1は指摘が出た場合を含み、失敗や成功の意味は本文の条件別判断に従う。

### 初回の比較

| 実行名 | 作業領域 | コマンド | 終了値 | 秒 | 出力 bytes / SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| `fallow-default` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --format json --quiet --no-cache` | 1 | 0.347708 | 3528 / `785cf2c196b236385f5281ae6aa877e439109d3b7e0517be12c487354389317f` |
| `knip-default` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/knip' --reporter json --no-progress` | 1 | 0.376545 | 12324 / `15ef59542bcbc02ec66f19bedbf6070fe3d258c70f53eb02d2e17ba559cbc18d` |
| `fallow-dupes` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' dupes --format json --quiet --no-cache` | 0 | 0.159656 | 491 / `c3af75c164f468741394e1a7f58311dbf9aa51b95c7b1237a45ba50306f4f567` |
| `fallow-dupes-semantic` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' dupes --mode semantic --format json --quiet --no-cache` | 0 | 0.176974 | 8575 / `e2dbeec3bf43fc7577f5af081efa66a82858fd16e84568d605a17847d5e59cd1` |
| `fallow-health` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' health --complexity --max-cognitive 15 --format json --quiet --no-cache` | 1 | 0.173169 | 27832 / `a930517bccf79c9421dc32862095a59a6f8de70ed851c44f2c646e5ae69aafd4` |
| `biome-existing` | `${TRIAL}/checkout` | `'${TRIAL}/checkout/node_modules/.bin/biome' lint scripts --reporter=json` | 0 | 0.704254 | 231 / `c4b7b639daed8dba41bed63d41215e6c1b3d21f4e39e76db75627c79fbc00475` |
| `fallow-entry-default` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' list --entry-points --plugins --format json --quiet --no-cache` | 0 | 0.095294 | 1158 / `c0bb0ce6d8ad052062b5edc95c058ed68d8cb491a6f4e1e1fa172ffcab3dcea6` |
| `fallow-aligned` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --format json --quiet --no-cache` | 1 | 0.223048 | 4556 / `969e19989b4718ae7fbba1f6e1107cd31aa6ac4e7fab8e2fd350e578580a519e` |
| `knip-aligned` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/knip' --config '${TRIAL}/knip-config.json' --include-entry-exports --reporter json --no-progress` | 1 | 0.334830 | 967 / `b6e5afafd0344832ddd2a0a2b0106dcbba28f55e2ee1ca3d0da80e09f37eaef8` |
| `knip-cycles` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/knip' --config '${TRIAL}/knip-config.json' --cycles --reporter json --no-progress` | 0 | 0.225375 | 253 / `c1b2dfc0a03366e21c4f982696ddd27beb8e713ef3c60b2ced6325b0ce6a01f2` |
| `fallow-health-cognitive` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' health --complexity --max-cognitive 15 --max-cyclomatic 100000 --max-crap 1000000000 --format json --quiet --no-cache` | 2 | 0.062890 | 178 / `1bca23a0220f4d8626c0f9c859f6fff177aa20e5f73856605161c26e4b9d5ec9` |
| `fallow-dupes-skipped` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' dupes --explain-skipped --format json --quiet --no-cache` | 0 | 0.086852 | 491 / `74bc1f1203f74bac94ea999184c661483fca2a259cb898455157403e7d32743f` |
| `fallow-health-cognitive-valid` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' health --complexity --max-cognitive 15 --max-cyclomatic 65535 --max-crap 1000000000 --format json --quiet --no-cache` | 0 | 0.123215 | 5201 / `88bf44ce63a01bebc25b7665abb3a18abb0ca47855df18e719ee341667b02ae1` |
| `fallow-control-default` | `${TRIAL}/control` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --format json --quiet --no-cache` | 1 | 0.098165 | 3390 / `f79ac502a1dbc08e412204203a90d69c3a37e663e0fececa2844873165815b95` |
| `fallow-control-aligned` | `${TRIAL}/control` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --format json --quiet --no-cache` | 1 | 0.093127 | 5277 / `39f600510a99c8baf1489fe927ddc12c5b05d0f69572e2fa1c632e36f4de3dd2` |
| `knip-control-aligned` | `${TRIAL}/control` | `'${TRIAL}/tools/node_modules/.bin/knip' --config '${TRIAL}/knip-config.json' --include-entry-exports --reporter json --no-progress` | 1 | 0.237804 | 1600 / `10276bed79f0307ae64faade86567126b8db1ad8421717256fd37efa6693c85e` |
| `fallow-control-trace` | `${TRIAL}/control` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --trace-file scripts/trial-unused.ts --format json --quiet --no-cache` | 0 | 0.115542 | 307 / `42165bfd17a0c9dc9ab5f801205bcd1ffd2bdc30bd7ea75fc3a453ebfd3057cb` |
| `fallow-control-no-format` | `${TRIAL}/control` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --format json --quiet --no-cache` | 1 | 0.116987 | 6378 / `dd072fbc77d76d4626675e93889266c39e3e6c97c82ffcd509d790a5471738fe` |
| `fallow-control-no-tooling` | `${TRIAL}/control` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --format json --quiet --no-cache` | 1 | 0.098785 | 6378 / `4ef15160d2dd08b2a0ae0ab244054fca035ff170ec9f4d6f31fe878eef5be46c` |
| `fallow-repeat-1` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --unused-files --unused-exports --unused-types --unused-deps --circular-deps --format json --quiet --no-cache` | 1 | 0.111916 | 4556 / `56a87464b9b6345623cdde92ce9a809f51e377ce639e2a59ae8b344e6fe4052e` |
| `knip-repeat-1` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/knip' --config '${TRIAL}/knip-config.json' --include-entry-exports --include files,exports,types,dependencies,cycles --reporter json --no-progress` | 1 | 0.319960 | 776 / `6dd9d527651b194b180a6cac213b0beded15242884e41b6d72562d2dd6859824` |
| `knip-repeat-2` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/knip' --config '${TRIAL}/knip-config.json' --include-entry-exports --include files,exports,types,dependencies,cycles --reporter json --no-progress` | 1 | 0.351929 | 776 / `6dd9d527651b194b180a6cac213b0beded15242884e41b6d72562d2dd6859824` |
| `fallow-repeat-2` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --unused-files --unused-exports --unused-types --unused-deps --circular-deps --format json --quiet --no-cache` | 1 | 0.101359 | 4556 / `db9bcb778dc8caec91f2ac71292c9e4e8319ea185b65cddf3c3063089ead7f36` |
| `fallow-repeat-3` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --unused-files --unused-exports --unused-types --unused-deps --circular-deps --format json --quiet --no-cache` | 1 | 0.098718 | 4556 / `a0ed397fb85de79e467eb2ea4725e8a65fb42573db80813a94cfdc94b316581c` |
| `knip-repeat-3` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/knip' --config '${TRIAL}/knip-config.json' --include-entry-exports --include files,exports,types,dependencies,cycles --reporter json --no-progress` | 1 | 0.238573 | 776 / `6dd9d527651b194b180a6cac213b0beded15242884e41b6d72562d2dd6859824` |
| `fallow-dupes-explain-human` | `${TRIAL}/checkout` | `'${TRIAL}/tools/node_modules/.bin/fallow' dupes --explain-skipped --no-cache` | 0 | 0.082788 | 0 / `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

### 入口を揃えた追試

| 実行名 | 作業領域 | コマンド | 終了値 | 秒 | 出力 bytes / SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| `fallow-equal-entries` | `${TRIAL}/equal-entries-control` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --unused-files --unused-exports --unused-types --unused-deps --circular-deps --format json --quiet --no-cache` | 1 | 0.238242 | 5218 / `064d9a012a7e584fcc7ac1b23a21bb2a6bc1b401b0171b0b139aff3dcd75f4d7` |
| `knip-equal-entries` | `${TRIAL}/equal-entries-control` | `'${TRIAL}/tools/node_modules/.bin/knip' --config '${TRIAL}/knip-config.json' --include-entry-exports --include files,exports,types,dependencies,cycles --reporter json --no-progress` | 1 | 0.369814 | 1347 / `99c6e0173ff40adc08edf5c461bcc42e41e95590ec4008bc65e0a341a470e1a3` |
| `knip-equal-entries-debug` | `${TRIAL}/equal-entries-control` | `'${TRIAL}/tools/node_modules/.bin/knip' --config '${TRIAL}/knip-config.json' --include-entry-exports --include files,exports,types,dependencies,cycles --debug --no-progress` | 1 | 0.257712 | 17397 / `68cacd0d02f5f0dc66ea34e024e841b8311e1a88a90f92bfbbcf79a80e958461` |

### 採用に向けた追加試行

| 実行名 | 作業領域 | コマンド | 終了値 | 秒 | 出力 bytes / SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| `fallow-adoption-format-preserved` | `${TRIAL}/adoption-probe` | `'${TRIAL}/tools/node_modules/.bin/fallow' dead-code --config '${TRIAL}/fallow-config.json' --include-entry-exports --format json --quiet --no-cache` | 1 | 0.135742 | 6378 / `bc8c5b79bbaf940875966b5f9fbe77800069a1e1a3a4248318fe5f8ba51ad4c9` |
| `oxfmt-adoption-check` | `${TRIAL}/adoption-probe` | `'${TRIAL}/adoption-probe/node_modules/.bin/oxfmt' --check scripts` | 0 | 0.054163 | 111 / `822ff5d15066bd806742300fdf7b91d4c3714c4a3e88d6e9de1b4af680f229e7` |
| `oxfmt-original-check` | `${TRIAL}/control` | `'${TRIAL}/adoption-probe/node_modules/.bin/oxfmt' --check 'scripts/**/*.ts'` | 0 | 0.051824 | 111 / `4e9624878ba4cbab1337cfff345e7f0938249a02dd12d7c1ec2c2d7b4ce1bd94` |
| `oxfmt-original-fixture-check` | `${TRIAL}/control` | `'${TRIAL}/control/node_modules/.bin/oxfmt' --check 'scripts/**/*.ts'` | 1 | 0.056813 | 267 / `17b7cc37acdc311fdc7868e5e274c6d9353898a55b63210403a84f16f3c4a8f4` |
| `oxfmt-original-fixture-write` | `${TRIAL}/control` | `'${TRIAL}/control/node_modules/.bin/oxfmt' --write 'scripts/**/*.ts'` | 0 | 0.057081 | 45 / `2e0dc9af0657c0158e6fdf657fe51f25188d931e5bd6ced7e452b89ffe23c2d1` |
| `oxfmt-adoption-fixture-check` | `${TRIAL}/adoption-probe` | `'${TRIAL}/adoption-probe/node_modules/.bin/oxfmt' --check scripts` | 1 | 0.051691 | 267 / `5a440513f3744cca1130f5aa248c800c3457f14765ba4dbe7706425bef350dc8` |
| `oxfmt-adoption-fixture-write` | `${TRIAL}/adoption-probe` | `'${TRIAL}/adoption-probe/node_modules/.bin/oxfmt' --write scripts` | 0 | 0.049506 | 45 / `1b7aa197df95117078e636e0621f5a4befce2caaa6a139e451ee5dced34f97ba` |

### stderrを伴った実行

| 実行名 | stderr bytes | SHA-256 |
| --- | ---: | --- |
| `biome-existing` | 90 | `0913004effb614bc48cd4a3dbeeb8ff43aca0acce8fa7b57a4681b43cfbfca1e` |
| `fallow-dupes-explain-human` | 120 | `36da13332ef7044e900b81645590a930adcfc985070047add9e3b11648aa65c9` |

stderrが空の34回のSHA-256は`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。機械出力から採用判断に使った指摘の種類・件数、対照の検出、入口差、重複・複雑度の限界は上の各節にまとめた。raw出力の全フィールド、作業ホストの一時パス・PID、再生不能な実行途中の状態は本稿へ移さない。
