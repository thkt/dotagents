export type Selection = { kind: 'tests'; tests: string[] } | { kind: 'all'; reasons: string[] };

export type SelectionInput = {
  root: string;
  changed: string[];
  testFiles: string[];
  records: Map<string, Set<string>>;
  readText: (path: string) => string;
};

// 記録の有無によらず、変更すると全部実行にするファイルです（root からの相対パス）。
const fixedAllPaths = [
  'scripts/tests/runner.ts',
  'scripts/tests/record-modules.ts',
  'scripts/tests/affected.ts',
  'package.json',
  'bun.lock',
  'tsconfig.json',
];

function pathTail(path: string): string {
  return path.split('/').slice(-2).join('/');
}

export function selectAffected(input: SelectionInput): Selection {
  const { root, changed, testFiles, records, readText } = input;
  const fixed = new Set(fixedAllPaths.map((path) => `${root}/${path}`));
  const testSet = new Set(testFiles);
  // 記録のないテストファイルは何を読むか分からないため、常に選ぶ。
  const unrecorded = testFiles.filter((file) => !records.has(file));
  const selected = new Set(unrecorded);
  const reasons: string[] = [];
  const bodies = new Map<string, string>();
  const body = (file: string) => {
    const cached = bodies.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const text = readText(file);
    bodies.set(file, text);
    return text;
  };

  for (const path of changed) {
    if (fixed.has(path)) {
      reasons.push(path);
      continue;
    }
    if (testSet.has(path)) {
      selected.add(path);
      continue;
    }
    let reached = false;
    for (const file of testFiles) {
      if (records.get(file)?.has(path)) {
        selected.add(file);
        reached = true;
      }
    }
    const tail = pathTail(path);
    for (const file of testFiles) {
      if (body(file).includes(tail)) {
        selected.add(file);
        reached = true;
      }
    }
    // 記録にも本文にもない変更は、記録のないテストファイルが読む可能性があるときだけ、そのテストに任せる。
    if (!reached && unrecorded.length === 0) {
      reasons.push(path);
    }
  }

  if (reasons.length > 0) {
    return { kind: 'all', reasons };
  }
  return { kind: 'tests', tests: testFiles.filter((file) => selected.has(file)) };
}
