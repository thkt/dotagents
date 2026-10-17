import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { checkReport } from '../runner.ts';
import { isRecord } from '../../shared/values.ts';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const entry = resolve(import.meta.dir, '../runner.ts');

// 実際のpackage入口とJUnit runnerを使い、無関係な静的検査だけを模擬する。
async function commandFixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'test-commands-'));
  const repo = resolve(import.meta.dir, '../../..');
  for (const directory of ['scripts/tests', 'scripts/shared', 'eval/tests']) {
    await mkdir(join(cwd, directory), { recursive: true });
  }
  for (const path of ['scripts/tests/runner.ts', 'scripts/shared/values.ts']) {
    await cp(join(repo, path), join(cwd, path));
  }
  const manifest: unknown = await Bun.file(join(repo, 'package.json')).json();
  assert(isRecord(manifest) && isRecord(manifest.scripts));
  for (const name of ['lint', 'format:check', 'complexity', 'typecheck', 'check:unused']) {
    manifest.scripts[name] = `${process.execPath} -e 'console.log("STATIC_GATE")'`;
  }
  await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest));
  return cwd;
}

async function commandProbe(cwd: string, directory: string, marker: string, valid: boolean) {
  await writeFile(
    join(cwd, directory, 'probe.test.js'),
    `import { test, expect } from 'bun:test';
test('probe', () => { console.log('${marker}'); expect(${valid}).toBe(true); });`,
  );
}

function runCommand(cwd: string, name: string) {
  const result = spawnSync(process.execPath, ['run', name], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CI: 'true' },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { code: result.status, output: result.stdout + result.stderr };
}

test('通常とevalのpackage入口はそれぞれのテストだけをJUnit runnerで実行する', async () => {
  const cwd = await commandFixture();
  try {
    for (const [name, selected, other] of [
      ['test:control', 'scripts/tests', 'eval/tests'],
      ['test:eval', 'eval/tests', 'scripts/tests'],
    ] as const) {
      await commandProbe(cwd, selected, 'SELECTED_SUITE', true);
      await commandProbe(cwd, other, 'OTHER_SUITE', false);
      const normal = runCommand(cwd, name);
      expect(normal.code, normal.output).toBe(0);
      expect(normal.output).toContain('SELECTED_SUITE');
      expect(normal.output).not.toContain('OTHER_SUITE');
      expect(normal.output).toContain('All tests executed.');
      await commandProbe(cwd, selected, 'SELECTED_SUITE', false);
      const failure = runCommand(cwd, name);
      expect(failure.code, failure.output).toBe(1);
      expect(failure.output).toContain('SELECTED_SUITE');
      expect(failure.output).not.toContain('All tests executed.');
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('総合checkは通常とevalを実行し、evalの失敗を成功へ変換しない', async () => {
  const cwd = await commandFixture();
  try {
    await commandProbe(cwd, 'scripts/tests', 'CONTROL_SUITE', true);
    await commandProbe(cwd, 'eval/tests', 'EVAL_SUITE', true);
    const normal = runCommand(cwd, 'check');
    expect(normal.code, normal.output).toBe(0);
    expect(normal.output).toContain('CONTROL_SUITE');
    expect(normal.output).toContain('EVAL_SUITE');
    await commandProbe(cwd, 'eval/tests', 'EVAL_SUITE', false);
    const failure = runCommand(cwd, 'check');
    expect(failure.code, failure.output).toBe(1);
    expect(failure.output).toContain('EVAL_SUITE');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function runnerFixture(
  cwd: string,
  scenario: 'normal' | 'only' | 'skip' | 'failure' | 'syntax' | 'empty',
  directory = 'scripts/tests',
) {
  const temporaryReports = join(cwd, 'temporary-reports');
  await mkdir(temporaryReports);
  const dir = join(cwd, directory);
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

const selections = [
  ...(['normal', 'only', 'skip', 'failure', 'syntax', 'empty'] as const).map((scenario) => ({
    scenario,
    directory: 'scripts/tests',
  })),
  ...(['normal', 'skip', 'empty'] as const).map((scenario) => ({
    scenario,
    directory: 'eval/tests',
  })),
];
for (const { scenario, directory } of selections) {
  test(`bun runner: ${directory} ${scenario}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'test-completion-'));
    try {
      const temporaryReports = await runnerFixture(cwd, scenario, directory);
      const result = spawnSync(process.execPath, [entry, 'bun', directory], {
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
        expect(xml).toContain(`file="${directory}/probe.test.js"`);
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

test('Playwrightの総件数は整数1を受け入れ、小数1.5を拒否する', () => {
  expect(() => checkReport('playwright', '{"stats":{"expected":1,"skipped":0}}')).not.toThrow();
  expect(() => checkReport('playwright', '{"stats":{"expected":1.5,"skipped":0}}')).toThrow(
    'No completed tests',
  );
});

test('reports reject truncated output', () => {
  expect(() =>
    checkReport('bun', '<?xml version="1.0"?><testsuites tests="1" skipped="0">'),
  ).toThrow('Missing or incomplete Bun JUnit summary');
});
