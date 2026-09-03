/** @file Outcome: A shell gate reports one bounded pass or correction result. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'bun:test';

import type { GateReport } from '../../execution/contracts.ts';
import { DEFAULT_TIMEOUT_MS, parseArgs } from '../../execution/shell-verification.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

const verifier = path.resolve(import.meta.dirname, '../../execution/shell-verification.ts');

function run(cwd: string, command: string, extra: string[] = [], env?: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [
      verifier,
      '--gate-id',
      'test',
      '--failure-route',
      'direct:implementation',
      '--cwd',
      cwd,
      '--expect',
      'pass',
      '--command',
      command,
      ...extra,
    ],
    { encoding: 'utf8', env },
  );
}

test('accepts only a success expectation with a bounded timeout', () => {
  const cwd = temporaryDirectory('codex-shell-gate-');
  const options = parseArgs([
    '--gate-id',
    'test',
    '--failure-route',
    'direct:implementation',
    '--cwd',
    cwd,
    '--expect',
    'pass',
    '--command',
    'true',
  ]);
  assert.equal(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.throws(
    () =>
      parseArgs([
        '--gate-id',
        'test',
        '--failure-route',
        'red:U-001',
        '--cwd',
        cwd,
        '--expect',
        'fail',
        '--command',
        'false',
      ]),
    /failure-route|expect/u,
  );
});

test('reports a passing test with bounded output evidence', () => {
  const cwd = temporaryDirectory('codex-shell-gate-');
  const result = run(cwd, 'printf ok');
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout) as GateReport;
  assert.equal(report.verdict, 'pass');
  assert.equal(report.classification, 'pass');
  assert.equal(report.evidence.kind, 'shell');
  if (report.evidence.kind === 'shell') assert.equal(report.evidence.stdout_tail, 'ok');
});

test('routes a failed test to the implementation actor without output matching', () => {
  const cwd = temporaryDirectory('codex-shell-gate-');
  const result = run(cwd, "printf 'any diagnostic' >&2; exit 7");
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout) as GateReport;
  assert.equal(report.verdict, 'fail');
  assert.equal(report.classification, 'test_failed');
  assert.equal(report.failure_route, 'direct:implementation');
});

test('blocks timeouts and suppresses the correction route', () => {
  const cwd = temporaryDirectory('codex-shell-gate-');
  const result = run(cwd, 'sleep 2', ['--timeout-ms', '20']);
  const report = JSON.parse(result.stdout) as GateReport;
  assert.equal(report.verdict, 'blocked');
  assert.equal(report.classification, 'timeout');
  assert.equal(report.failure_route, 'blocked');
});

test('removes GitHub credentials from the test process', () => {
  const cwd = temporaryDirectory('codex-shell-gate-');
  const result = run(
    cwd,
    'test -z "$GH_TOKEN" && test -z "$GITHUB_TOKEN" && test "$GH_PROMPT_DISABLED" = true',
    [],
    { ...process.env, GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret' },
  );
  assert.equal(result.status, 0);
});

test('keeps only complete lines inside the configured output tail', () => {
  const cwd = temporaryDirectory('codex-shell-gate-');
  const result = run(cwd, "printf 'discarded-line\\nkept-line\\n'", ['--tail-bytes', '10']);
  const report = JSON.parse(result.stdout) as GateReport;
  assert.equal(report.evidence.kind, 'shell');
  if (report.evidence.kind === 'shell') assert.equal(report.evidence.stdout_tail, 'kept-line\n');
});
