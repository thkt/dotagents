import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execute } from './command.ts';

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
  bunWorkers: number;
  testArgs: string[];
  allowSkipped: boolean;
  globalChanges: string[];
  dependencies: { inputs: string[]; tests: string[] }[];
};

export const reviewPath = '.feedback-loop-review.json';

type ReviewRecord = { path: string; class: 'quality' | 'assurance'; sha256: string };

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
  const bunWorkers = value.bunWorkers === undefined ? 4 : value.bunWorkers;
  assert(
    typeof bunWorkers === 'number' && Number.isSafeInteger(bunWorkers) && bunWorkers > 0,
    'bunWorkersは正の安全な整数で指定してください',
  );
  assert(
    value.runner === 'bun' || value.bunWorkers === undefined,
    'VitestにはbunWorkersを指定できません',
  );
  if (value.runner === 'bun') {
    assert(
      ![...bunArgs, ...testArgs].some((arg) => /^--(?:no-)?(?:isolate|parallel)(?:=|$)/.test(arg)),
      'Bunの隔離は固定です。並列数はbunWorkersで指定してください',
    );
  }
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
    bunWorkers,
    testArgs,
    allowSkipped,
    globalChanges,
    dependencies,
  };
}

// 確認記録は分類の確認状況だけを扱い、実行範囲には使いません。
function readReview(root: string): ReviewRecord[] {
  const target = join(root, reviewPath);
  if (!existsSync(target)) {
    return [];
  }
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'));
    object(parsed);
    value = parsed;
  } catch (error) {
    throw new Error(
      `${reviewPath}: JSONオブジェクトを読めません: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(value.version === 1, `${reviewPath}: 未対応のversionです`);
  assert(Array.isArray(value.files), `${reviewPath}: files配列が必要です`);
  return value.files.map((item: unknown) => {
    object(item);
    assert(typeof item.path === 'string', `${reviewPath}: pathが必要です`);
    localPath(item.path);
    assert(
      item.class === 'quality' || item.class === 'assurance',
      `${reviewPath}: classはqualityまたはassuranceです: ${item.path}`,
    );
    assert(
      typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256),
      `${reviewPath}: sha256は小文字16進64文字です: ${item.path}`,
    );
    if (item.class === 'quality') {
      assert(
        typeof item.reason === 'string' && item.reason.trim().length > 0,
        `${reviewPath}: qualityには確認した理由のreasonが必要です: ${item.path}`,
      );
    } else {
      assert(
        item.reason === undefined,
        `${reviewPath}: assuranceにはreasonを書かず、理由は.feedback-loop.jsonだけに置きます: ${item.path}`,
      );
    }
    return { path: item.path, class: item.class, sha256: item.sha256 };
  });
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

export async function classification(
  root: string,
  config: FeedbackConfig,
  runtime: string,
  retryCommand?: string,
) {
  const expected = filesUnder(root)
    .filter((path) => config.testGlobs.some((glob) => matches(path, glob)))
    .sort();
  const { stdout } = await execute(config.collect, {
    runtime,
    cwd: root,
    captureStdout: true,
    retryCommand,
  });
  const actual: unknown = JSON.parse(stdout);
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

// test:affectedとapplyは呼ばず、記録の不整合で日常の実行を止めません。
export function review(root: string, classes: { all: string[]; assurance: string[] }) {
  const records = readReview(root);
  const recorded = new Map(records.map((record) => [record.path, record]));
  assert(recorded.size === records.length, `${reviewPath}: 同じpathの記録が重複しています`);
  const assurance = new Set(classes.assurance);
  const files = classes.all.map((path) => {
    const sha256 = createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex');
    const kind: ReviewRecord['class'] = assurance.has(path) ? 'assurance' : 'quality';
    const record = recorded.get(path);
    const status = !record
      ? 'unreviewed'
      : record.class !== kind
        ? 'mismatch'
        : record.sha256 === sha256
          ? 'reviewed'
          : 'stale';
    return { path, class: kind, sha256, status };
  });
  const orphans = records
    .map((record) => record.path)
    .filter((path) => !classes.all.includes(path));
  return {
    complete: orphans.length === 0 && files.every((file) => file.status === 'reviewed'),
    files,
    orphans,
  };
}
