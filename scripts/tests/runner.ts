import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { isRecord } from '../shared/values.ts';

export function checkReport(runner: 'bun' | 'playwright', text: string) {
  let total: unknown, skipped: unknown;
  if (runner === 'bun') {
    // Read only the root summary emitted by pinned Bun, not testcase text or logs.
    const summary = /^<\?xml[^>]*>\s*<testsuites\s+([^>]*)>/.exec(text)?.[1];
    assert(
      summary && text.trimEnd().endsWith('</testsuites>'),
      'Missing or incomplete Bun JUnit summary',
    );
    const testsAttribute = /\btests="(\d+)"/.exec(summary)?.[1];
    const skippedAttribute = /\bskipped="(\d+)"/.exec(summary)?.[1];
    total = testsAttribute === undefined ? undefined : Number(testsAttribute);
    skipped = skippedAttribute === undefined ? undefined : Number(skippedAttribute);
  } else {
    const report: unknown = JSON.parse(text);
    assert(isRecord(report) && isRecord(report.stats), 'Missing Playwright stats');
    total = report.stats.expected;
    skipped = report.stats.skipped;
  }
  assert(typeof total === 'number' && Number.isInteger(total) && total > 0, 'No completed tests');
  assert(skipped === 0, `Unexecuted tests or invalid skipped count: ${String(skipped)}`);
}

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
  const { records, warning } = modules.loadRecords(root);
  if (warning !== undefined) {
    console.error(`警告: ${warning}`);
  }
  const testFiles = testFilesUnder(modules, paths.length ? paths : [join(root, 'scripts/tests')]);
  const selection = modules.selectAffected({
    root,
    changed,
    testFiles,
    records,
    readText: (path) => readFileSync(path, 'utf8'),
  });
  if (selection.kind === 'all') {
    console.log(`全テストファイルを実行します。理由: ${selection.reasons.join(', ')}`);
  }
  const files = selection.kind === 'all' ? testFiles : selection.tests;
  assert(files.length > 0, '実行するテストファイルがありません');
  return { modules, root, files };
}

const usage =
  'Usage: runner.ts bun [TEST_PATH...] [--parallel=N] [--timings=FILE] [--update-timings] [--affected[=REF]] | playwright CONFIG REPORT_DIRECTORY';

if (import.meta.main) {
  let temporaryReportDir: string | undefined;
  try {
    const runner = process.argv[2];
    assert(runner === 'bun' || runner === 'playwright', usage);
    const config = process.argv[3];
    const reportDirectory = process.argv[4];
    assert(
      runner === 'bun' || (config && reportDirectory),
      'Playwright config and report directory required',
    );
    const selected: string[] = [];
    let affected: AffectedPlan | undefined;
    if (runner === 'bun') {
      const { paths, options, affectedBase } = parseBunArguments(process.argv.slice(3));
      if (affectedBase === undefined) {
        selected.push(...(paths.length ? paths : [resolve('scripts/tests')]), ...options);
      } else {
        affected = await planAffected(affectedBase, paths);
        // 記録は読み込みをテストファイルごとに分けるため、ファイルごとにモジュールを読み直させる。
        selected.push(...affected.files, ...options, '--isolate');
      }
    }
    const artifacts = runner === 'bun' ? tmpdir() : resolve(reportDirectory ?? '');
    await mkdir(artifacts, { recursive: true });
    const dir = await mkdtemp(resolve(artifacts, `${runner}-report-`));
    if (runner === 'bun') {
      temporaryReportDir = dir;
    }
    const report = resolve(dir, runner === 'bun' ? 'results.xml' : 'results.json');
    const recordDir = resolve(dir, 'records');
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
      if (!outcome.interrupted && outcome.code !== 0) {
        // 失敗したファイルは読み込みが途中で止まった可能性があるため、実行した全ファイルを記録なしに戻す。
        affected.modules.saveRecords({
          root: affected.root,
          ran: new Map(),
          failed: affected.files,
        });
      }
      assertSucceeded(outcome);
    } else {
      await execute(executable, args, report);
    }
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
      affected.modules.saveRecords({
        root: affected.root,
        ran: await affected.modules.readRecords(recordDir),
        failed: [],
      });
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
