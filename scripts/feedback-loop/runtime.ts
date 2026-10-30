import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createRequire } from 'node:module';
import { classification, matches, object, readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { selectVitest } from './vitest.ts';
import { changedFiles, mergeBase, selectAffected } from '../test-runtime/affected.ts';
import { loadRecords, saveRecords } from '../test-runtime/affected-records.ts';
import { checkReport } from '../test-runtime/report.ts';
import type * as Recorder from '../test-runtime/record-modules.ts';

function recorderModule(value: unknown): asserts value is typeof Recorder {
  object(value);
  assert(
    typeof value.recorderEnv === 'function' && typeof value.readRecords === 'function',
    '記録器を読み込めません',
  );
}

async function execute(argv: string[], env = process.env) {
  const [command, ...args] = argv;
  assert(command, '実行コマンドがありません');
  console.log(
    `実行: ${argv.join(' ')}; 再実行: ${process.versions.bun ? 'bun' : 'npm'} run test:affected`,
  );
  const child = spawn(command, args, { stdio: ['inherit', 'inherit', 'pipe'], env });
  // Bunの選択診断は先頭に出ます。テスト本体の大量ログは保持しません。
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(chunk);
    stderr += chunk.slice(0, Math.max(0, 4096 - stderr.length));
  });
  let cancelled = false;
  const forward = (signal: NodeJS.Signals) => {
    cancelled = true;
    child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done, fail) => {
        child.once('error', fail);
        child.once('close', (code, signal) => done({ code, signal }));
      },
    );
    assert(!cancelled && result.code === 0, `検査失敗または取消: ${result.signal ?? result.code}`);
    return stderr;
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
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
  const { records, warning } = loadRecords(root, true, changed);
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
    testFiles: quality.map((path) => join(root, path)),
    records: dependencies,
    readText: (path) => readFileSync(path, 'utf8'),
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

async function bunTests(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
) {
  const selected = select(root, config, quality, changed);
  const comparison = mergeBase(root, config.base);
  const bun = process.versions.bun ? process.execPath : 'bun';
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
    for (let index = 0; index < quality.length; index++) {
      const file = quality[index];
      assert(file);
      const recordDir = join(dir, String(index));
      const report = join(dir, `${index}.xml`);
      await mkdir(recordDir);
      const argv = [
        bun,
        ...config.bunArgs,
        'test',
        `./${file}`,
        ...config.testArgs,
        '--reporter=junit',
        '--reporter-outfile',
        report,
      ];
      const env = recorder.recorderEnv(process.env, recordDir, recorderFile);
      attempted.add(join(root, file));
      let excluded = false;
      if (!selected.all) {
        const stderr = await execute([...argv, `--changed=${comparison}`], env);
        const recorded: Map<string, Set<string>> = await recorder.readRecords(recordDir);
        // Bun 1.4.4は関連0件でも終了0で、JUnitを生成しません。
        // 診断と未読込みを確認し、選択されたテストの結果欠落とは区別します。
        excluded =
          !existsSync(report) &&
          recorded.size === 0 &&
          /^--changed: (?:\d+ changed files?, but no test files are affected|no changed files, nothing to run)\r?$/m.test(
            stripVTControlCharacters(stderr),
          );
      }
      if (excluded && !selected.files.includes(file)) {
        attempted.delete(join(root, file));
        continue;
      }
      if (selected.all || excluded) {
        await execute(argv, env);
      }
      const count = checkReport('bun', await readFile(report, 'utf8'), config.allowSkipped);
      completed += count;
      const recorded: Map<string, Set<string>> = await recorder.readRecords(recordDir);
      const owner = join(root, file);
      const modules: Set<string> | undefined = recorded.get(owner);
      assert(modules, `完了したテストの依存記録がありません: ${file}`);
      if (count > 0) {
        ran.set(owner, modules);
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
    await execute([
      process.execPath,
      cli,
      ...selection,
      ...config.testArgs,
      ...exclude,
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${report}`,
    ]);
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
    console.log(`quality選択: ${new Set(executed).size}件（Vitestの実行結果）`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

try {
  const root = process.cwd();
  const operation = process.argv[2];
  assert(
    operation === 'classification' || operation === 'affected',
    '操作はclassificationまたはaffectedです',
  );
  const config = readConfig(root);
  const classes = classification(root, config);
  if (operation === 'classification') {
    console.log(JSON.stringify(classes, null, 2));
  } else {
    const changed = changedFiles({ root, base: config.base, ignoredPathPrefixes: [] });
    console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
    assert(changed.length > 0, '変更なし: テストを実行しません');
    assert(classes.quality.length > 0, '候補0件: qualityがありません');
    if (config.prepare.length > 0) {
      await execute(config.prepare);
    }
    if (config.runner === 'bun') {
      await bunTests(root, config, classes.quality, changed);
    } else {
      await vitestTests(root, config, classes.quality, changed);
    }
    console.log('選択したqualityが成功しました。全体checkの成功ではありません');
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
