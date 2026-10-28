import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
  'scripts/test-runtime/runner.ts',
  'scripts/test-runtime/record-modules.ts',
  'scripts/test-runtime/affected.ts',
  'scripts/tests/runner.ts',
  'package.json',
  'bun.lock',
  'tsconfig.json',
];

function pathTail(path: string): string {
  return path.split('/').slice(-2).join('/');
}

// 変更ファイルを記録に持つか、パスの末尾2要素を本文に書いたテストファイルを返す。
function reachingTests(
  path: string,
  testFiles: string[],
  records: Map<string, Set<string>>,
  body: (file: string) => string,
): string[] {
  const tail = pathTail(path);
  return testFiles.filter((file) => records.get(file)?.has(path) || body(file).includes(tail));
}

function cachedReader(readText: (path: string) => string): (path: string) => string {
  const texts = new Map<string, string>();
  return (path) => {
    const text = texts.get(path) ?? readText(path);
    texts.set(path, text);
    return text;
  };
}

export function selectAffected(input: SelectionInput): Selection {
  const { root, changed, testFiles, records } = input;
  const fixed = new Set(fixedAllPaths.map((path) => `${root}/${path}`));
  const testSet = new Set(testFiles);
  const body = cachedReader(input.readText);
  // 記録のないテストファイルは何を読むか分からないため、常に選ぶ。
  const selected = new Set(testFiles.filter((file) => !records.has(file)));
  const reasons: string[] = [];

  for (const path of changed) {
    if (testSet.has(path)) {
      selected.add(path);
      continue;
    }
    const reached = fixed.has(path) ? [] : reachingTests(path, testFiles, records, body);
    // 固定一覧の変更と、どのテストにも届かない入力ファイルの変更は全部実行にする。
    if (reached.length === 0) {
      reasons.push(path);
    }
    for (const file of reached) {
      selected.add(file);
    }
  }

  if (reasons.length > 0) {
    return { kind: 'all', reasons };
  }
  return { kind: 'tests', tests: testFiles.filter((file) => selected.has(file)) };
}

export type ChangedFilesInput = {
  root: string;
  base: string;
};

// 読み込まれず、実行の理由にならない作業用のパスです（root からの相対パスの接頭辞）。
const workPathPrefixes = ['.claude/workspace/', 'docs/issues/', '.issue-drafts/'];

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function nulSeparated(text: string): string[] {
  return text.split('\0').filter((path) => path !== '');
}

// base との分岐点以降の commit・未 commit の変更・未追跡ファイルを、root 配下の絶対パスで返す。
// --no-renames により rename は旧パスと新パスの両方を数える。
export function changedFiles({ root, base }: ChangedFilesInput): string[] {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  // --relative と ls-files の既定出力は root からの相対パスで、root の外は含まない。
  const tracked = git(root, ['diff', '--name-only', '--no-renames', '--relative', '-z', mergeBase]);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])]
    .filter((path) => !workPathPrefixes.some((prefix) => path.startsWith(prefix)))
    .map((path) => join(root, path));
}

// 変更一覧のうち、作業ツリーに存在するテストファイルだけを返す。
export function existingTestFiles(changed: string[]): string[] {
  return changed.filter((path) => path.endsWith('.test.ts') && existsSync(path));
}
