<!-- 生成元: skills/setup-feedback-loop/references/collect.md。直接編集せず、正本を変更して再生成してください -->

# Bunのテスト一覧を作る

Bun 1.4.4の`bun test`には、テストを実行せずにファイルを一覧する機能がない。`.feedback-loop.json`の`collect`には、通常checkの`bun test`と同じ範囲を一覧する入口を対象repoへ用意する。既存の一覧処理があればそれを使い、なければ次のスクリプトを`scripts/list-tests.ts`として置く。

```ts
// bun testの既定の収集規則に合わせ、引数のディレクトリ配下のテストファイルをrepo相対パスで一覧する。
const pattern = new Bun.Glob('**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}');
const roots = process.argv.slice(2);
const files = new Set<string>();
for (const root of roots.length > 0 ? roots : ['.']) {
  const base = root.replace(/^\.\/?/, '').replace(/\/$/, '');
  for (const path of pattern.scanSync({ cwd: root, onlyFiles: true })) {
    if (path.split('/').some((part) => part === 'node_modules' || part.startsWith('.'))) {
      continue;
    }
    files.add(base ? `${base}/${path}` : path);
  }
}
console.log(JSON.stringify([...files].sort()));
```

引数には、通常checkが`bun test`へ渡すディレクトリを同じ順で渡す。たとえば通常checkが`bun test ./test`なら、`collect`は`["bun", "scripts/list-tests.ts", "./test"]`とする。通常checkに`bunArgs`と同じ起動引数があれば、`collect`の`bun`の直後にも付ける。引数のない`bun test`はrepo全体を対象にするので、引数なしで呼ぶ。

`check:classification`は`collect`の一覧と`testGlobs`の集合を照合する。ただし、この照合では`collect`と`bun test`の食い違いを検出できない。`bunfig.toml`の`[test]`の設定、`--path-ignore-patterns`、名前の規則に合うが通常checkが読まない場所のファイルが、食い違いの原因になる。

## 一覧と実際の実行を照合する

導入時に、通常checkの`bun test`をJUnitの出力付きで一度実行し、記録されたファイルと`collect`の一覧を比べる。次のスクリプトを導入作業用の一時ファイルとして置き、対象repoのルートで実行する。対象repoへcommitしない。

```ts
// 使い方: bun compare-collect.ts <JUnitのパス> <collectのargv...>
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [report, ...collect] = process.argv.slice(2);
const xml = readFileSync(report ?? '', 'utf8');
const executed = new Set(
  [...xml.matchAll(/^ {2}<testsuite [^>]*\bfile="([^"]+)"/gm)].map((match) => match[1]),
);
const result = spawnSync(collect[0] ?? '', collect.slice(1), { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}
const listed = new Set(JSON.parse(result.stdout) as string[]);
const missing = [...listed].filter((path) => !executed.has(path)).sort();
const extra = [...executed].filter((path) => !listed.has(path)).sort();
console.log(JSON.stringify({ missing, extra }));
process.exit(missing.length + extra.length === 0 ? 0 : 1);
```

1. 通常checkと同じ引数で`bun test ./test --reporter=junit --reporter-outfile=/tmp/junit.xml`を実行する。
2. `bun compare-collect.ts /tmp/junit.xml bun scripts/list-tests.ts ./test`を実行する。
3. 終了0と`{"missing":[],"extra":[]}`を確かめる。

`missing`は、一覧にあるが`bun test`が実行しなかったファイルである。`extra`は、`bun test`が実行したが一覧にないファイルである。どちらかが空でなければ、一覧スクリプトの引数か除外規則を通常checkに合わせて直し、同じ手順で再確認する。`test()`を1件も持たないファイルはJUnitに出ないため、`missing`に出たファイルは本文も読む。比較したJUnitのファイル数と`collect`の件数を、導入の記録に残す。
