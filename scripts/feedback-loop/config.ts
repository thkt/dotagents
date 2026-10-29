import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type FeedbackConfig = {
  version: 1;
  runner: 'bun' | 'vitest';
  base: string;
  collect: string[];
  testGlobs: string[];
  assurance: { path: string; reason: string }[];
  fullCheck: string[];
  prepare: string[];
  bunArgs: string[];
  testArgs: string[];
  allowSkipped: boolean;
  globalChanges: string[];
  dependencies: { inputs: string[]; tests: string[] }[];
};

export function object(value: unknown): asserts value is Record<string, unknown> {
  assert(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'オブジェクトが必要です',
  );
}

function strings(value: unknown): asserts value is string[] {
  assert(
    Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && item.trim().length > 0),
    '文字列配列が必要です',
  );
}

function localPath(path: string) {
  assert(
    !isAbsolute(path) &&
      !path.split('/').includes('..') &&
      !path.startsWith('./') &&
      !path.includes('\\'),
    `repo相対パスが必要です: ${path}`,
  );
}

export function readConfig(root: string): FeedbackConfig {
  const value: unknown = JSON.parse(readFileSync(join(root, '.feedback-loop.json'), 'utf8'));
  object(value);
  assert(value.version === 1, '未対応の設定versionです');
  assert(value.runner === 'bun' || value.runner === 'vitest', 'runnerはbunまたはvitestです');
  assert(typeof value.base === 'string' && value.base.trim().length > 0, '比較元baseが必要です');
  const { collect, testGlobs, fullCheck, prepare, testArgs, globalChanges } = value;
  strings(collect);
  strings(testGlobs);
  strings(fullCheck);
  strings(prepare);
  strings(testArgs);
  strings(globalChanges);
  assert(
    collect.length > 0 && fullCheck.length > 0 && testGlobs.length > 0,
    '収集・通常check・テストglobは必須です',
  );
  const bunArgs = value.bunArgs ?? [];
  const allowSkipped = value.allowSkipped === undefined ? true : value.allowSkipped;
  assert(typeof allowSkipped === 'boolean', 'allowSkippedはbooleanです');
  strings(bunArgs);
  assert(value.runner === 'bun' || bunArgs.length === 0, 'VitestにはbunArgsを指定できません');
  assert(Array.isArray(value.assurance), 'assurance配列が必要です');
  const assurance = value.assurance.map((item: unknown) => {
    object(item);
    assert(
      typeof item.path === 'string' &&
        typeof item.reason === 'string' &&
        item.reason.trim().length > 0,
      'assuranceにはpathと指定理由が必要です',
    );
    localPath(item.path);
    return { path: item.path, reason: item.reason };
  });
  assert(Array.isArray(value.dependencies), 'dependencies配列が必要です');
  const dependencies = value.dependencies.map((item: unknown) => {
    object(item);
    strings(item.inputs);
    strings(item.tests);
    assert(item.inputs.length > 0 && item.tests.length > 0, '依存対応は空にできません');
    item.inputs.forEach(localPath);
    item.tests.forEach(localPath);
    return { inputs: item.inputs, tests: item.tests };
  });
  testGlobs.forEach(localPath);
  globalChanges.forEach(localPath);
  return {
    version: 1,
    runner: value.runner,
    base: value.base,
    collect,
    testGlobs,
    assurance,
    fullCheck,
    prepare,
    bunArgs,
    testArgs,
    allowSkipped,
    globalChanges,
    dependencies,
  };
}

// *は同階層、**は階層をまたぐglobです。正規表現の記号はリテラルとして扱います。
export function matches(path: string, glob: string): boolean {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (glob.slice(i, i + 3) === '**/') {
      pattern += '(?:.*/)?';
      i += 2;
    } else if (glob.slice(i, i + 2) === '**') {
      pattern += '.*';
      i++;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`).test(path);
}

function filesUnder(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.name === '.git' || entry.name === 'node_modules') {
      return [];
    }
    return entry.isDirectory() ? filesUnder(root, `${path}/`) : entry.isFile() ? [path] : [];
  });
}

export function classification(root: string, config: FeedbackConfig) {
  const expected = filesUnder(root)
    .filter((path) => config.testGlobs.some((glob) => matches(path, glob)))
    .sort();
  const [command, ...args] = config.collect;
  assert(command);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert(
    !result.error && result.status === 0,
    `テスト収集失敗: ${String(result.error ?? result.signal ?? result.status)}\n${result.stderr}`,
  );
  const actual: unknown = JSON.parse(result.stdout);
  strings(actual);
  actual.forEach(localPath);
  assert(new Set(actual).size === actual.length, '収集結果が重複しています');
  assert(
    JSON.stringify([...actual].sort()) === JSON.stringify(expected),
    `通常収集とtestGlobsの集合が一致しません\ncollect=${JSON.stringify(actual)}\nglob=${JSON.stringify(expected)}`,
  );
  const assurance = new Set(config.assurance.map((item) => item.path));
  assert(assurance.size === config.assurance.length, 'assurance指定が重複しています');
  assert(
    [...assurance].every((path) => expected.includes(path)),
    'assuranceに存在しないテストか集合外の指定があります',
  );
  assert(
    config.dependencies.every((item) => item.tests.every((path) => expected.includes(path))),
    '依存対応に集合外のテストがあります',
  );
  return {
    all: expected,
    quality: expected.filter((path) => !assurance.has(path)),
    assurance: [...assurance],
  };
}
