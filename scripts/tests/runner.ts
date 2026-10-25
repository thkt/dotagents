import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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

async function execute(executable: string, args: string[], report: string) {
  const child = spawn(executable, args, {
    stdio: 'inherit',
    env: { ...process.env, CI: 'true', PLAYWRIGHT_JSON_OUTPUT_FILE: report },
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
    assert(
      !interrupted && result.code === 0,
      `Command did not succeed (${result.signal ?? result.code})`,
    );
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

if (import.meta.main) {
  let temporaryReportDir: string | undefined;
  try {
    const runner = process.argv[2];
    assert(
      runner === 'bun' || runner === 'playwright',
      'Usage: runner.ts bun [TEST_PATH...] [--parallel=N] [--timings=FILE] [--update-timings] | playwright CONFIG REPORT_DIRECTORY',
    );
    const config = process.argv[3];
    const reportDirectory = process.argv[4];
    assert(
      runner === 'bun' || (config && reportDirectory),
      'Playwright config and report directory required',
    );
    const selected: string[] = [];
    if (runner === 'bun') {
      const paths: string[] = [];
      const options: string[] = [];
      for (const argument of process.argv.slice(3)) {
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
      selected.push(...(paths.length ? paths : [resolve('scripts/tests')]), ...options);
    }
    const artifacts = runner === 'bun' ? tmpdir() : resolve(reportDirectory ?? '');
    await mkdir(artifacts, { recursive: true });
    const dir = await mkdtemp(resolve(artifacts, `${runner}-report-`));
    if (runner === 'bun') {
      temporaryReportDir = dir;
    }
    const report = resolve(dir, runner === 'bun' ? 'results.xml' : 'results.json');
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
