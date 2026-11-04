import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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

type BunArguments = {
  paths: string[];
  options: string[];
};

function parseBunArguments(args: string[]): BunArguments {
  const paths: string[] = [];
  const options: string[] = [];
  for (const argument of args) {
    if (
      /^--parallel=[1-9]\d*$/.test(argument) ||
      /^--timings=.+/.test(argument) ||
      argument === '--update-timings'
    ) {
      options.push(argument);
    } else {
      assert(
        !argument.startsWith('-'),
        `Unsupported argument: ${argument}. Use TEST_PATH..., --parallel=N, --timings=FILE, --update-timings`,
      );
      const path = resolve(argument);
      assert(existsSync(path), `Test path does not exist: ${argument}`);
      paths.push(path);
    }
  }
  return { paths, options };
}

const usage =
  'Usage: runner.ts bun [TEST_PATH...] [--parallel=N] [--timings=FILE] [--update-timings] | playwright CONFIG REPORT_DIRECTORY';

function selectBunTests() {
  const { paths, options } = parseBunArguments(process.argv.slice(3));
  return [...(paths.length ? paths : [resolve('scripts/tests')]), ...options];
}

async function runSelected(
  runner: 'bun' | 'playwright',
  config: string | undefined,
  report: string,
  selected: string[],
) {
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
  await execute(executable, args, report);
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
  const selected = runner === 'bun' ? selectBunTests() : [];
  const artifacts = runner === 'bun' ? tmpdir() : resolve(reportDirectory ?? '');
  await mkdir(artifacts, { recursive: true });
  const dir = await mkdtemp(resolve(artifacts, `${runner}-report-`));
  const report = resolve(dir, runner === 'bun' ? 'results.xml' : 'results.json');
  return {
    runner,
    config,
    selected,
    report,
    temporaryReportDir: runner === 'bun' ? dir : undefined,
  } as const;
}

export async function main() {
  let temporaryReportDir: string | undefined;
  try {
    const prepared = await prepareRun();
    temporaryReportDir = prepared.temporaryReportDir;
    const { runner, config, selected, report } = prepared;
    await runSelected(runner, config, report, selected);
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
    console.log(runner === 'bun' ? 'All tests executed.' : `All tests executed. Report: ${report}`);
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
