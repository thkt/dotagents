import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

if (import.meta.main) {
  let temporaryReportDir: string | undefined;
  try {
    const runner = process.argv[2];
    assert(
      runner === 'bun' || runner === 'playwright',
      'Usage: runner.ts bun [TEST_DIRECTORY] | playwright CONFIG REPORT_DIRECTORY',
    );
    const config = process.argv[3];
    const reportDirectory = process.argv[4];
    assert(
      runner === 'bun' || (config && reportDirectory),
      'Playwright config and report directory required',
    );
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
            config ?? 'scripts/tests',
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
    const result = spawnSync(executable, args, {
      stdio: 'inherit',
      env: { ...process.env, CI: 'true', PLAYWRIGHT_JSON_OUTPUT_FILE: report },
    });
    if (result.error) {
      throw result.error;
    }
    assert(result.status === 0, `${runner} did not succeed (${result.signal ?? result.status})`);
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
