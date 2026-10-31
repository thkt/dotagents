import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createRequire } from 'node:module';
import { classification, matches, object, readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { selectVitest } from './vitest.ts';
import { changedFiles, mergeBase, selectAffected } from '../test-runtime/affected.ts';
import { loadRecords, recordsPath, saveRecords } from '../test-runtime/affected-records.ts';
import { readBunReport } from './bun-report.ts';
import { execute } from './command.ts';
import type * as Recorder from '../test-runtime/record-modules.ts';

const runtime = fileURLToPath(import.meta.url);
// 導入時に判定したpackage managerを、生成時のdefineで埋め込みます。
declare const targetPackageManager: 'bun' | 'npm';

function recorderModule(value: unknown): asserts value is typeof Recorder {
  object(value);
  assert(
    typeof value.recorderEnv === 'function' && typeof value.readRecords === 'function',
    '記録器を読み込めません',
  );
}

function select(root: string, config: FeedbackConfig, quality: string[], changed: string[]) {
  const fixed = [
    'package.json',
    'package-lock.json',
    'bun.lock',
    'bun.lockb',
    '.feedback-loop.json',
    '.dotagents.json',
    'scripts/feedback-loop/**',
  ];
  const relative = changed.map((path) => path.slice(root.length + 1));
  const global = relative.filter((path) =>
    [...fixed, ...config.globalChanges].some((glob) => matches(path, glob)),
  );
  const testFiles = quality.map((path) => join(root, path));
  const { records, warning } = loadRecords(root, true, changed, testFiles);
  const dependencies = new Map(records);
  for (const path of relative) {
    for (const dependency of config.dependencies) {
      if (dependency.inputs.some((glob) => matches(path, glob))) {
        dependency.tests.forEach((test) => {
          const file = join(root, test);
          // 明示対応を補い、同じ入力へ到達する実行記録も選択に残します。
          dependencies.set(file, new Set([...(dependencies.get(file) ?? []), join(root, path)]));
        });
      }
    }
  }
  const selection = selectAffected({
    root,
    changed,
    testFiles,
    records: dependencies,
  });
  const reasons = [
    ...global,
    ...(warning ? [warning] : []),
    ...(selection.kind === 'all' ? selection.reasons : []),
  ];
  if (records.size === 0) {
    reasons.push('信頼できる依存記録なし');
  }
  if (reasons.length > 0) {
    console.log(`quality全件の理由: ${reasons.join(', ')}`);
    return { files: quality, all: true };
  }
  assert(selection.kind === 'tests');
  return { files: selection.tests.map((path) => path.slice(root.length + 1)), all: false };
}

async function runBunBatch(
  root: string,
  config: FeedbackConfig,
  batch: {
    files: string[];
    comparison: string | undefined;
    dir: string;
    recorderFile: string;
    recorder: typeof Recorder;
  },
) {
  const candidates = new Set(batch.files.map((file) => join(root, file)));
  const report = join(batch.dir, 'results.xml');
  const recordDir = join(batch.dir, 'records');
  await mkdir(recordDir, { recursive: true });
  const argv = [
    process.versions.bun ? process.execPath : 'bun',
    ...config.bunArgs,
    'test',
    ...batch.files.map((file) => `./${file}`),
    ...config.testArgs,
    '--no-orphans',
    '--isolate',
    `--parallel=${config.bunWorkers}`,
    '--reporter=junit',
    '--reporter-outfile',
    report,
    ...(batch.comparison === undefined ? [] : [`--changed=${batch.comparison}`]),
  ];
  const { stderr } = await execute(argv, {
    runtime,
    retryCommand: `${targetPackageManager} run test:affected`,
    env: batch.recorder.recorderEnv(process.env, recordDir, batch.recorderFile),
  });
  const recorded = await batch.recorder.readRecords(recordDir);
  // 関連0件の終了0と、選択されたファイルの結果欠落を区別します。
  const excluded =
    batch.comparison !== undefined &&
    !existsSync(report) &&
    recorded.size === 0 &&
    /^--changed: (?:\d+ changed files?, but no test files are affected|no changed files, nothing to run)\r?$/m.test(
      stripVTControlCharacters(stderr),
    );
  const results = excluded
    ? new Map<string, number>()
    : readBunReport(await readFile(report, 'utf8'), root, candidates, config.allowSkipped);
  assert(
    recorded.size === results.size && [...recorded.keys()].every((file) => results.has(file)),
    '読み込んだテストとJUnitのファイル集合が一致しません',
  );
  assert(
    batch.comparison !== undefined || results.size === candidates.size,
    '指定したテストの結果が欠落しています',
  );
  return new Map(
    [...results].map(([owner, count]) => {
      const modules = recorded.get(owner);
      assert(modules, `完了したテストの依存記録がありません: ${owner}`);
      return [owner, { count, modules }];
    }),
  );
}

async function bunTests(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
) {
  const selected = select(root, config, quality, changed);
  const comparison = mergeBase(root, config.base);
  const dir = await mkdtemp(join(tmpdir(), 'feedback-loop-'));
  // npm/Vitestの実行にはBunを要求しません。記録器はBunの分岐でだけ読み込みます。
  const recorderFile = join(root, 'scripts/feedback-loop/record-modules.ts');
  const recorder: unknown = await import(pathToFileURL(recorderFile).href);
  recorderModule(recorder);
  const ran = new Map<string, Set<string>>();
  const attempted = new Set<string>();
  let completed = 0;
  let succeeded = false;
  try {
    // ホストのSIGKILLではfinallyを実行できません。旧記録を残し、完了まで選択には使いません。
    const pending = `${recordsPath(root)}.pending`;
    await mkdir(dirname(pending), { recursive: true });
    await writeFile(pending, 'incomplete\n');
    const batches = [{ files: quality, changed: !selected.all }];
    for (const [index, batch] of batches.entries()) {
      const candidates = new Set(batch.files.map((file) => join(root, file)));
      candidates.forEach((file) => attempted.add(file));
      const results = await runBunBatch(root, config, {
        files: batch.files,
        comparison: batch.changed ? comparison : undefined,
        dir: join(dir, String(index)),
        recorderFile,
        recorder,
      });
      candidates.forEach((file) => {
        if (!results.has(file)) {
          attempted.delete(file);
        }
      });
      results.forEach(({ count, modules }, owner) => {
        completed += count;
        if (count > 0) {
          ran.set(owner, modules);
        }
      });
      if (batch.changed) {
        const remaining = selected.files.filter((file) => !results.has(join(root, file)));
        if (remaining.length > 0) {
          batches.push({ files: remaining, changed: false });
        }
      }
    }
    console.log(`quality選択: ${attempted.size}件（Bunの実行結果と補完依存の和集合）`);
    assert(attempted.size > 0, '候補0件: 関連テストがありません');
    assert(completed > 0, '未実行: 選択したテストがすべてskipされています');
    succeeded = true;
  } finally {
    saveRecords({
      root,
      ran: succeeded ? ran : new Map<string, Set<string>>(),
      failed: [...attempted].filter((file) => !succeeded || !ran.has(file)),
      trusted: true,
    });
    await rm(dir, { recursive: true, force: true });
  }
}

async function vitestTests(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
) {
  const require = createRequire(join(root, 'package.json'));
  const packagePath = require.resolve('vitest/package.json');
  const installed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
  object(installed);
  object(installed.bin);
  assert(typeof installed.bin.vitest === 'string', 'Vitestの公開CLIがありません');
  const cli = join(dirname(packagePath), installed.bin.vitest);
  const relative = changed.map((path) => path.slice(root.length + 1));
  const selected = await selectVitest(
    root,
    config,
    quality,
    changed,
    require.resolve('vitest/node'),
  );
  assert(selected.files.length > 0, '候補0件: Vitestの関連qualityがありません');
  const exclude = config.assurance.flatMap((entry) => ['--exclude', join(root, entry.path)]);
  const selection =
    selected.reasons.length > 0
      ? ['run', ...quality]
      : ['related', ...relative, ...selected.files, '--run'];
  if (selected.reasons.length > 0) {
    console.log(
      `quality全件の理由: 設定変更、削除、または依存先不明: ${selected.reasons.join(', ')}`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), 'feedback-vitest-'));
  try {
    const report = join(dir, 'results.json');
    await execute(
      [
        process.execPath,
        cli,
        ...selection,
        ...config.testArgs,
        ...exclude,
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { runtime, retryCommand: `${targetPackageManager} run test:affected` },
    );
    const result: unknown = JSON.parse(await readFile(report, 'utf8'));
    object(result);
    assert(
      result.success === true &&
        typeof result.numTotalTests === 'number' &&
        result.numTotalTests > 0,
      'Vitestが完了していません。候補0件または結果欠落',
    );
    assert(Array.isArray(result.testResults), 'Vitestのファイル結果がありません');
    assert(
      typeof result.numPassedTests === 'number' && result.numPassedTests > 0,
      '未実行: Vitestで成功したテストがありません',
    );
    if (!config.allowSkipped) {
      assert(
        result.numPassedTests === result.numTotalTests,
        '未実行: Vitestにskipまたはtodoがあります',
      );
    }
    const executed = result.testResults.map((item: unknown) => {
      object(item);
      assert(typeof item.name === 'string', 'Vitest結果のファイル名が不正です');
      return item.name.startsWith(root + '/') ? item.name.slice(root.length + 1) : item.name;
    });
    assert(
      executed.length > 0 && executed.every((file) => quality.includes(file)),
      'Vitestの実行結果がquality集合と一致しません',
    );
    const completed = new Set(executed);
    assert(
      selected.files.every((file) => completed.has(file)),
      'Vitestの選択したテストの結果が欠落しています',
    );
    console.log(`quality選択: ${new Set(executed).size}件（Vitestの実行結果）`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

try {
  const root = process.cwd();
  const operation = process.argv[2];
  if (operation === 'execute-child') {
    assert(
      process.connected && typeof process.send === 'function',
      '内部の検査監視には親とのIPC接続が必要です',
    );
    const input: unknown = await new Promise((done, fail) => {
      const disconnected = () => {
        process.off('message', received);
        fail(new Error('検査の開始前に親との接続が切れました'));
      };
      const received = (value: unknown) => {
        process.off('disconnect', disconnected);
        done(value);
      };
      process.once('disconnect', disconnected);
      process.once('message', received);
    });
    object(input);
    const { argv, env } = input;
    assert(Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === 'string'));
    object(env);
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
      assert(typeof value === 'string');
      environment[key] = value;
    }
    // 親の出力pipeが閉じても監視を維持し、取消と強制終了を完了させます。
    process.stderr.on('error', () => {
      process.exitCode = 1;
      if (process.connected) {
        process.disconnect?.();
      }
    });
    await execute(argv, { runtime, env: environment, monitorParent: true });
  } else {
    assert(
      operation === 'classification' || operation === 'affected',
      '操作はclassificationまたはaffectedです',
    );
    const config = readConfig(root);
    const classes = await classification(
      root,
      config,
      runtime,
      `${targetPackageManager} run test:affected`,
    );
    if (operation === 'classification') {
      console.log(JSON.stringify(classes, null, 2));
    } else {
      const changed = changedFiles({ root, base: config.base, ignoredPathPrefixes: [] });
      console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
      assert(changed.length > 0, '変更なし: テストを実行しません');
      assert(classes.quality.length > 0, '候補0件: qualityがありません');
      if (config.prepare.length > 0) {
        await execute(config.prepare, {
          runtime,
          retryCommand: `${targetPackageManager} run test:affected`,
        });
      }
      if (config.runner === 'bun') {
        await bunTests(root, config, classes.quality, changed);
      } else {
        await vitestTests(root, config, classes.quality, changed);
      }
      console.log('選択したqualityが成功しました。全体checkの成功ではありません');
    }
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
