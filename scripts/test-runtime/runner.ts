import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

import { checkReport } from './report.ts';
export { checkReport } from './report.ts';

// commitなどが切り離して起動する自動maintenanceは、終了後もobjects/maintenance.lockを保持します。
// その間にverifyGitLocksが走ると、テストのGitリポジトリが断続的に拒否されます。
export function withoutAutoMaintenance(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  assert(
    Number.isInteger(count) && count >= 0,
    `Invalid GIT_CONFIG_COUNT: ${env.GIT_CONFIG_COUNT}`,
  );
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: 'maintenance.auto',
    [`GIT_CONFIG_VALUE_${count}`]: 'false',
    [`GIT_CONFIG_KEY_${count + 1}`]: 'gc.auto',
    [`GIT_CONFIG_VALUE_${count + 1}`]: '0',
  };
}

type Outcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  interrupted: boolean;
};

async function spawnAndWait(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Outcome> {
  const child = spawn(executable, args, {
    stdio: 'inherit',
    env: withoutAutoMaintenance(env),
  });
  let interrupted = false;
  const forward = (signal: NodeJS.Signals) => {
    interrupted = true;
    child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    return { ...result, interrupted };
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

function assertSucceeded(outcome: Outcome) {
  assert(
    !outcome.interrupted && outcome.code === 0,
    `Command did not succeed (${outcome.signal ?? outcome.code})`,
  );
}

function runEnvironment(report: string): NodeJS.ProcessEnv {
  return { ...process.env, CI: 'true', PLAYWRIGHT_JSON_OUTPUT_FILE: report };
}

async function execute(executable: string, args: string[], report: string) {
  assertSucceeded(await spawnAndWait(executable, args, runEnvironment(report)));
}

// 選択と記録の部品は --affected のときだけ読み込み、それ以外の実行は部品の有無に依存させない。
async function loadAffectedModules() {
  const [selection, records, recorder] = await Promise.all([
    import('./affected.ts'),
    import('./affected-records.ts'),
    import('./record-modules.ts'),
  ]);
  return { ...selection, ...records, ...recorder };
}

type AffectedModules = Awaited<ReturnType<typeof loadAffectedModules>>;

type AffectedPlan = {
  modules: AffectedModules;
  root: string;
  // 今回実行するテストファイルの絶対パスです。
  files: string[];
};

type BunArguments = {
  paths: string[];
  options: string[];
  // --affected[=REF] の基点です。指定がなければ undefined です。
  affectedBase: string | undefined;
};

const defaultAffectedBase = 'main';

function parseBunArguments(args: string[]): BunArguments {
  const paths: string[] = [];
  const options: string[] = [];
  let affectedBase: string | undefined;
  for (const argument of args) {
    const affected = /^--affected(?:=(.+))?$/.exec(argument);
    if (affected) {
      assert(affectedBase === undefined, '--affected is given more than once');
      affectedBase = affected[1] ?? defaultAffectedBase;
    } else if (
      /^--parallel=[1-9]\d*$/.test(argument) ||
      /^--timings=.+/.test(argument) ||
      argument === '--update-timings'
    ) {
      options.push(argument);
    } else {
      assert(
        !argument.startsWith('-'),
        `Unsupported argument: ${argument}. Use TEST_PATH..., --parallel=N, --timings=FILE, --update-timings, --affected[=REF]`,
      );
      const path = resolve(argument);
      assert(existsSync(path), `Test path does not exist: ${argument}`);
      paths.push(path);
    }
  }
  return { paths, options, affectedBase };
}

function testFilesUnder(modules: AffectedModules, paths: string[]): string[] {
  const files = new Set<string>();
  for (const path of paths) {
    if (!statSync(path).isDirectory()) {
      files.add(path);
      continue;
    }
    for (const entry of readdirSync(path, { recursive: true, encoding: 'utf8' })) {
      if (modules.testFilePattern.test(entry) && !entry.split(sep).includes('node_modules')) {
        files.add(join(path, entry));
      }
    }
  }
  return [...files].sort();
}

function gitRoot(): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  assert(result.status === 0, `--affected requires a git work tree: ${result.stderr}`);
  return result.stdout.trim();
}

// 変更の一覧と記録から、実行するテストファイルを決めます。実行を始める前に、変更なしなどで止めます。
async function planAffected(base: string, paths: string[]): Promise<AffectedPlan> {
  const modules = await loadAffectedModules();
  const root = gitRoot();
  const changed = modules.changedFiles({ root, base });
  assert(
    changed.length > 0,
    `変更なし: ${base} との分岐点以降に変更がないため、テストを実行しません`,
  );
  const testFiles = testFilesUnder(modules, paths.length ? paths : [join(root, 'scripts/tests')]);
  const { records, warning } = modules.loadRecords(root, true, changed, testFiles);
  if (warning !== undefined) {
    console.error(`警告: ${warning}`);
  }
  const selection = modules.selectAffected({
    root,
    changed,
    testFiles,
    records,
    readText: (path) => readFileSync(path, 'utf8'),
  });
  const qualityOnly =
    testFiles.length > 0 &&
    testFiles.every((file) => file.startsWith(join(root, 'scripts/tests/quality') + sep));
  const label = qualityOnly ? '品質' : 'テスト';
  console.log(`${label}候補: ${testFiles.length}件（全体checkではありません）`);
  const files = selection.kind === 'all' ? testFiles : selection.tests;
  if (warning !== undefined || testFiles.every((file) => !records.has(file))) {
    const reasons = [
      warning ?? '依存記録なし',
      ...(selection.kind === 'all' ? selection.reasons : []),
    ];
    console.log(`${label}全件を実行します。理由: ${reasons.join(', ')}`);
  } else if (selection.kind === 'all') {
    console.log(
      `全テストファイルを実行します。${label}全件の理由: ${selection.reasons.join(', ')}`,
    );
  } else if (files.length === testFiles.length) {
    console.log(
      `${label}候補全件が関連選択規則に該当しました（変更テスト自身・依存記録・本文照合・記録なし）`,
    );
  }
  console.log(`${label}選択: ${files.length}件`);
  assert(files.length > 0, '実行するテストファイルがありません');
  return { modules, root, files };
}

// JUnit レポートで、失敗も skip もなく完了したテストファイルの絶対パスを返します。
// 読み込みで止まったファイルはレポートに現れないため、成功に数えません。
function passedTestFiles(text: string): Set<string> {
  const passed = new Set<string>();
  for (const [, attributes = ''] of text.matchAll(/<testsuite\s+([^>]*)>/g)) {
    const file = /\bfile="([^"]+)"/.exec(attributes)?.[1];
    if (file && /\bfailures="0"/.test(attributes) && /\bskipped="0"/.test(attributes)) {
      passed.add(resolve(file));
    }
  }
  return passed;
}

// 成功したファイルの記録を今回の読み込みで置き換え、それ以外の選んだファイルは記録なしに戻します。
// レポートを検査で拒否した実行は成功に数えず、選んだ全ファイルを記録なしに戻します。
async function saveAffectedRecords(affected: AffectedPlan, recordDir: string, report: string) {
  let passed = new Set<string>();
  try {
    const text = await readFile(report, 'utf8');
    checkReport('bun', text);
    passed = passedTestFiles(text);
  } catch {
    // passed を空のままにし、選んだ全ファイルを記録なしに戻す。
  }
  const recorded = await affected.modules.readRecords(recordDir);
  affected.modules.saveRecords({
    root: affected.root,
    ran: new Map([...recorded].filter(([file]) => passed.has(file))),
    failed: affected.files.filter((file) => !passed.has(file)),
    trusted: true,
  });
}

const usage =
  'Usage: runner.ts bun [TEST_PATH...] [--parallel=N] [--timings=FILE] [--update-timings] [--affected[=REF]] | playwright CONFIG REPORT_DIRECTORY';

async function selectBunTests() {
  const { paths, options, affectedBase } = parseBunArguments(process.argv.slice(3));
  if (affectedBase === undefined) {
    return {
      selected: [...(paths.length ? paths : [resolve('scripts/tests')]), ...options],
      affected: undefined,
    };
  }
  const affected = await planAffected(affectedBase, paths);
  return { selected: [...affected.files, ...options, '--isolate'], affected };
}

async function runSelected(
  runner: 'bun' | 'playwright',
  config: string | undefined,
  report: string,
  selected: string[],
  affected: AffectedPlan | undefined,
) {
  const recordDir = resolve(report, '..', 'records');
  const argv =
    runner === 'bun'
      ? [
          process.execPath,
          'test',
          ...selected,
          '--no-orphans',
          '--only-failures',
          '--reporter=junit',
          '--reporter-outfile',
          report,
        ]
      : [
          process.execPath,
          createRequire(resolve(config ?? '')).resolve('@playwright/test/cli'),
          'test',
          `--config=${resolve(config ?? '')}`,
          '--forbid-only',
          '--reporter=list,json',
        ];
  const [executable, ...args] = argv;
  assert(executable);
  if (affected) {
    await mkdir(recordDir);
    const outcome = await spawnAndWait(
      executable,
      args,
      affected.modules.recorderEnv(runEnvironment(report), recordDir),
    );
    if (!outcome.interrupted) {
      await saveAffectedRecords(affected, recordDir, report);
    }
    assertSucceeded(outcome);
  } else {
    await execute(executable, args, report);
  }
}

async function prepareRun() {
  const runner = process.argv[2];
  assert(runner === 'bun' || runner === 'playwright', usage);
  const config = process.argv[3];
  const reportDirectory = process.argv[4];
  assert(
    runner === 'bun' || (config && reportDirectory),
    'Playwright config and report directory required',
  );
  const { selected, affected } =
    runner === 'bun' ? await selectBunTests() : { selected: [], affected: undefined };
  const artifacts = runner === 'bun' ? tmpdir() : resolve(reportDirectory ?? '');
  await mkdir(artifacts, { recursive: true });
  const dir = await mkdtemp(resolve(artifacts, `${runner}-report-`));
  const report = resolve(dir, runner === 'bun' ? 'results.xml' : 'results.json');
  return {
    runner,
    config,
    selected,
    affected,
    report,
    temporaryReportDir: runner === 'bun' ? dir : undefined,
  } as const;
}

export async function main() {
  let temporaryReportDir: string | undefined;
  try {
    const prepared = await prepareRun();
    temporaryReportDir = prepared.temporaryReportDir;
    const { runner, config, selected, affected, report } = prepared;
    await runSelected(runner, config, report, selected, affected);
    const text = await readFile(report, 'utf8');
    try {
      checkReport(runner, text);
    } catch (error) {
      if (runner === 'bun') {
        temporaryReportDir = undefined;
        console.error(`JUnit report retained: ${report}`);
      }
      throw error;
    }
    if (affected) {
      console.log(
        `選んだテストファイル ${affected.files.length} 件が成功しました。全体 check ではありません。提出前は bun run check を実行してください。`,
      );
    } else {
      console.log(
        runner === 'bun' ? 'All tests executed.' : `All tests executed. Report: ${report}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (temporaryReportDir) {
      await rm(temporaryReportDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  await main();
}
