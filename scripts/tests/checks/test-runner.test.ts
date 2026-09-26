import { test, expect } from 'bun:test';
import { checkReport } from '../runner.ts';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const entry = resolve(import.meta.dir, '../runner.ts');

async function runnerFixture(
  cwd: string,
  scenario: 'normal' | 'only' | 'skip' | 'failure' | 'syntax' | 'empty',
) {
  const temporaryReports = join(cwd, 'temporary-reports');
  await mkdir(temporaryReports);
  const dir = join(cwd, 'scripts/tests');
  await mkdir(dir, { recursive: true });
  const bodies = {
    normal: "test('second', () => { console.log('application output'); expect(1).toBe(1); });",
    only: "test.only('second', () => expect(1).toBe(1));",
    skip: "test.skip('second', () => expect(1).toBe(2));",
    failure: "test('second', () => expect(1).toBe(2));",
    syntax: 'const broken = ;',
    empty: '',
  };
  const source =
    scenario === 'empty'
      ? ''
      : `import {test,expect} from 'bun:test';
    test('first', () => expect(1).toBe(1)); ${bodies[scenario]}`;
  await writeFile(join(dir, 'probe.test.js'), source);
  return temporaryReports;
}

const diagnostics = {
  normal: [/2 pass/, /0 fail/, /Ran 2 tests across 1 file/, /application output/],
  only: [/\.only/, /probe\.test\.js/],
  skip: [/Unexecuted tests/],
  failure: [/second/, /probe\.test\.js/, /Expected: 2/, /Received: 1/],
  syntax: [/error:/, /probe\.test\.js:\d+/],
  empty: [/ENOENT/, /results\.xml/],
};

for (const scenario of ['normal', 'only', 'skip', 'failure', 'syntax', 'empty'] as const) {
  test(`bun runner: ${scenario}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'test-completion-'));
    try {
      const temporaryReports = await runnerFixture(cwd, scenario);
      const result = spawnSync(process.execPath, [entry, 'bun'], {
        cwd,
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, CI: 'false', TMPDIR: temporaryReports },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(scenario === 'normal' ? 0 : 1);
      const output = result.stdout + result.stderr;
      for (const diagnostic of diagnostics[scenario]) {
        expect(output).toMatch(diagnostic);
      }
      expect(output.includes('All tests executed.')).toBe(scenario === 'normal');
      if (scenario === 'normal') {
        expect(output).not.toContain('first');
        expect(output).not.toContain('second');
      }
      if (scenario === 'skip') {
        const report = /JUnit report retained: (.+)/.exec(result.stderr)?.[1];
        expect(report).toBeDefined();
        const xml = await readFile(report ?? '', 'utf8');
        expect(xml).toMatch(/<testcase\b[^>]*name="second"[^>]*>[\s\S]*?<skipped\b/);
        expect(xml).toContain('file="scripts/tests/probe.test.js"');
      } else {
        expect(await readdir(temporaryReports)).toEqual([]);
        expect(output).not.toContain('JUnit report retained:');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);
}

// Alter the generated report at the read boundary, then use real I/O and cleanup.
for (const scenario of ['invalid', 'unreadable'] as const) {
  test(`bun runner report: ${scenario}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'test-report-'));
    const rawReport = '<?xml version="1.0"?><testsuites tests="1" skipped="0">';
    try {
      const temporaryReports = await runnerFixture(cwd, 'normal');
      const preload = join(cwd, 'file-hooks.js');
      await writeFile(
        preload,
        `import { mock } from 'bun:test';
import * as filesystem from 'node:fs/promises';
const fs = { ...filesystem };
mock.module('node:fs/promises', () => ({ ...fs, async readFile(report, encoding) {
  if (${JSON.stringify(scenario)} === 'invalid') {
    await fs.writeFile(report, ${JSON.stringify(rawReport)});
  } else {
    await fs.rm(report);
    await fs.mkdir(report);
  }
  return fs.readFile(report, encoding);
} }));`,
      );
      const result = spawnSync(process.execPath, ['--preload', preload, entry, 'bun'], {
        cwd,
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, TMPDIR: temporaryReports },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('All tests executed.');
      if (scenario === 'invalid') {
        expect(result.stderr).toContain('Missing or incomplete Bun JUnit summary');
        const report = /JUnit report retained: (.+)/.exec(result.stderr)?.[1];
        expect(report).toBeDefined();
        expect(await readFile(report ?? '', 'utf8')).toBe(rawReport);
      } else {
        expect(result.stderr).toContain('EISDIR');
        expect(result.stderr).not.toContain('JUnit report retained:');
        expect(await readdir(temporaryReports)).toEqual([]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);
}

// Keep the runner's format valid so each case reaches the intended summary rule.
for (const { name, bun, playwright } of [
  {
    name: 'zero total',
    bun: [
      '<?xml version="1.0"?><testsuites tests="0" skipped="0"></testsuites>',
      'No completed tests',
    ],
    playwright: ['{"stats":{"expected":0,"skipped":0}}', 'No completed tests'],
  },
  {
    name: 'invalid skipped count',
    bun: [
      '<?xml version="1.0"?><testsuites tests="1" skipped="invalid"></testsuites>',
      'Unexecuted tests or invalid skipped count',
    ],
    playwright: [
      '{"stats":{"expected":1,"skipped":"invalid"}}',
      'Unexecuted tests or invalid skipped count',
    ],
  },
  {
    name: 'missing summary',
    bun: ['<?xml version="1.0"?><report/>', 'Missing or incomplete Bun JUnit summary'],
    playwright: ['{}', 'Missing Playwright stats'],
  },
  {
    name: 'missing total',
    bun: ['<?xml version="1.0"?><testsuites skipped="0"></testsuites>', 'No completed tests'],
    playwright: ['{"stats":{"skipped":0}}', 'No completed tests'],
  },
  {
    name: 'missing skipped count',
    bun: [
      '<?xml version="1.0"?><testsuites tests="1"></testsuites>',
      'Unexecuted tests or invalid skipped count: undefined',
    ],
    playwright: [
      '{"stats":{"expected":1}}',
      'Unexecuted tests or invalid skipped count: undefined',
    ],
  },
] as const) {
  test(`reports reject ${name}`, () => {
    expect(() => checkReport('bun', bun[0])).toThrow(bun[1]);
    expect(() => checkReport('playwright', playwright[0])).toThrow(playwright[1]);
  });
}

test('reports reject truncated output', () => {
  expect(() =>
    checkReport('bun', '<?xml version="1.0"?><testsuites tests="1" skipped="0">'),
  ).toThrow('Missing or incomplete Bun JUnit summary');
});
