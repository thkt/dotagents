// `.feedback-loop.json`のcollectの入口です。bun testの既定の収集規則で、引数のディレクトリ配下をrepo相対パスで一覧します。
const pattern = new Bun.Glob('**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}');
const files = new Set<string>();
for (const root of process.argv.slice(2)) {
  for (const path of pattern.scanSync({ cwd: root, onlyFiles: true })) {
    if (!path.split('/').some((part) => part === 'node_modules' || part.startsWith('.'))) {
      files.add(`${root}/${path}`);
    }
  }
}
console.log(JSON.stringify([...files].sort()));
