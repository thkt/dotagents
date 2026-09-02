/** @file Outcome: Shell evidence keeps stable verdict, classification, routing, timeout, and output semantics. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import type { GateOptions, GateReport } from '../../flow/contracts.ts';
import {
  calibrationCandidates,
  DEFAULT_TIMEOUT_MS,
  hasExactOutputLine,
  parseArgs,
  runShellVerification,
} from '../../flow/shell-gate.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

test('normalizes Node test reporter duration anchors and matches reruns exactly', () => {
  const candidates = calibrationCandidates('✖ planned name (0.13ms)\n', '', [
    { id: 'T-001', name: 'planned name' },
  ]);
  assert.equal(candidates[0]?.text, '✖ planned name');
  assert.equal(hasExactOutputLine('✖ planned name (0.09ms)\n', '', candidates[0]!.text), true);
  assert.equal(hasExactOutputLine('✖ planned name (details)\n', '', candidates[0]!.text), false);
});

const verifier = path.resolve(import.meta.dirname, '../../flow/shell-gate.ts');

interface RunOptions {
  expect?: 'pass' | 'fail';
  command?: string;
  route?: string;
  extra?: string[];
  env?: NodeJS.ProcessEnv;
}

function run(
  cwd: string,
  { expect = 'pass', command = 'exit 0', route = 'blocked', extra = [], env }: RunOptions = {},
) {
  return spawnSync(
    process.execPath,
    [
      verifier,
      '--gate-id',
      'U-001:test',
      '--failure-route',
      route,
      '--cwd',
      cwd,
      '--expect',
      expect,
      '--command',
      command,
      ...extra,
    ],
    { encoding: 'utf8', env },
  );
}

test('uses a bounded 60 second default timeout', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const options = parseArgs([
    '--gate-id',
    'baseline:test',
    '--failure-route',
    'blocked',
    '--cwd',
    cwd,
    '--expect',
    'pass',
    '--command',
    'exit 0',
  ]);
  assert.equal(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(options.timeoutMs, 60_000);
});

test('emits a current versionless passing gate result', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, { command: 'printf ok', route: 'green:U-001' });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout) as GateReport;
  assert.equal(report.protocol, 'codex-code-gate');
  assert.equal(report.gate_id, 'U-001:test');
  assert.equal(report.verdict, 'pass');
  assert.equal(report.classification, 'pass');
  assert.equal(report.failure_route, null);
  assert.equal(report.evidence.kind, 'shell');
  if (report.evidence.kind !== 'shell') return;
  assert.equal(report.evidence.stdout_tail, 'ok');
});

test('runs shell gates without GitHub credentials or the user gh configuration', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    command:
      'test -z "$GH_TOKEN" && test -z "$GITHUB_TOKEN" && test "$GH_PROMPT_DISABLED" = true && test -d "$GH_CONFIG_DIR"',
    env: {
      ...process.env,
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
    },
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).verdict, 'pass');
});

test('accepts Red only when failure output contains every required anchor', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    expect: 'fail',
    command: "printf 'T-001 collapses spaces\\nT-002 collapses tabs' >&2; exit 7",
    route: 'red:U-001',
    extra: [
      '--require-output',
      'T-001 collapses spaces',
      '--require-output',
      'T-002 collapses tabs',
    ],
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout) as GateReport;
  assert.equal(report.verdict, 'pass');
  assert.equal(report.classification, 'expected_failure');
  assert.equal(report.evidence.kind, 'shell');
  if (report.evidence.kind !== 'shell') return;
  assert.equal(report.evidence.exit_code, 7);
  assert.equal(
    report.evidence.checks.filter((check) => check.kind === 'output_includes').length,
    2,
  );
  assert.equal(
    report.evidence.checks.every((check) => check.passed),
    true,
  );
});

test('extracts only planned failure lines and preserves their exact text', () => {
  const planned = [{ id: 'T-001', name: 'empty input returns an error' }];
  assert.deepEqual(
    calibrationCandidates(
      'ok 1 - empty input returns an error\n',
      '  error: "EPERM: operation not permitted"\n  not ok 2 - empty input returns an error\n',
      planned,
    ),
    [
      {
        id: 'stderr:L2',
        text: '  not ok 2 - empty input returns an error',
        test_id: 'T-001',
      },
    ],
  );
});

test('retains planned failure candidates outside the diagnostic tail', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const script = path.join(cwd, 'failure.js');
  writeFileSync(
    script,
    "process.stdout.write('not ok 1 - empty input returns an error\\n' + 'ok noise\\n'.repeat(200)); process.exit(1);\n",
  );
  const options: GateOptions = {
    gateId: 'U-001:red:gate',
    failureRoute: 'red:U-001',
    cwd,
    expect: 'fail',
    command: 'node failure.js',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    tailBytes: 100,
    requiredOutput: [],
    forbiddenOutput: [],
  };
  const result = runShellVerification(options, [
    { id: 'T-001', name: 'empty input returns an error' },
  ]);
  assert.equal(result.report.verdict, 'pass');
  assert.equal(result.report.evidence.kind, 'shell');
  if (result.report.evidence.kind !== 'shell') return;
  assert.doesNotMatch(result.report.evidence.stdout_tail, /empty input/u);
  assert.deepEqual(result.candidates, [
    {
      id: 'stdout:L1',
      text: 'not ok 1 - empty input returns an error',
      test_id: 'T-001',
    },
  ]);
});

test('routes a missing Red output anchor to the declared Red owner', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    expect: 'fail',
    command: "printf 'SyntaxError' >&2; exit 2",
    route: 'red:U-001',
    extra: ['--require-output', 'T-001 collapses spaces'],
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.classification, 'missing_required_output');
  assert.deepEqual(report.reason_codes, ['missing_required_output']);
  assert.equal(report.failure_route, 'red:U-001');
});

test('does not accept a planned test that passed beside an unrelated failure', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    expect: 'fail',
    command: "printf 'ok 1 - T-001 collapses spaces\\nnot ok 2 - unrelated test'; exit 1",
    route: 'red:U-001',
    extra: ['--require-output', 'not ok 1 - T-001 collapses spaces'],
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'fail');
  assert.deepEqual(report.reason_codes, ['missing_required_output']);
  assert.equal(report.failure_route, 'red:U-001');
});

test('requires each Red output anchor to equal one complete output line', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    expect: 'fail',
    command: "printf 'prefix not ok 1 - T-001 collapses spaces suffix'; exit 1",
    route: 'red:U-001',
    extra: ['--require-output', 'not ok 1 - T-001 collapses spaces'],
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'fail');
  assert.deepEqual(report.reason_codes, ['missing_required_output']);
});

test('routes an unexpected Red pass without AI reclassification', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    expect: 'fail',
    command: "printf 'T-001 collapses spaces'",
    route: 'red:U-001',
    extra: ['--require-output', 'T-001 collapses spaces'],
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'fail');
  assert.deepEqual(report.reason_codes, ['unexpected_pass']);
  assert.equal(report.failure_route, 'red:U-001');
});

test('fails a gate when forbidden output is present', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    command: "printf '1 pass, 1 skipped'",
    route: 'green:U-001',
    extra: ['--forbid-output', 'skipped'],
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'fail');
  assert.deepEqual(report.reason_codes, ['forbidden_output']);
  assert.equal(report.failure_route, 'green:U-001');
});

test('classifies timeout as blocked and suppresses the editing route', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    expect: 'fail',
    command: 'sleep 1',
    route: 'red:U-001',
    extra: ['--require-output', 'T-001', '--timeout-ms', '50'],
  });
  assert.equal(result.status, 124);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'blocked');
  assert.equal(report.classification, 'timeout');
  assert.equal(report.failure_route, 'blocked');
  assert.equal(report.configured_failure_route, 'red:U-001');
});

test('keeps only the configured output tail', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    command: "printf '012345\\n6789'",
    extra: ['--tail-bytes', '4'],
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).evidence.stdout_tail, '6789');
});

test('drops a partial first line from truncated output evidence', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    command: "printf 'discarded-fragment\\ncomplete'",
    extra: ['--tail-bytes', '15'],
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).evidence.stdout_tail, 'complete');
});

test('returns no evidence when truncated output contains no complete line', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const result = run(cwd, {
    command: "printf '0123456789'",
    extra: ['--tail-bytes', '4'],
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).evidence.stdout_tail, '');
});

test('returns a blocked JSON result for invalid invocation', () => {
  const result = spawnSync(
    process.execPath,
    [
      verifier,
      '--gate-id',
      'red:test',
      '--failure-route',
      'red:U-001',
      '--cwd',
      '.',
      '--expect',
      'fail',
      '--command',
      'exit 1',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.protocol, 'codex-code-gate');
  assert.equal(report.verdict, 'blocked');
  assert.equal(report.classification, 'usage_error');
  assert.equal(report.failure_route, 'blocked');
});

test('rejects duplicate singleton arguments', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  assert.throws(
    () =>
      parseArgs([
        '--gate-id',
        'one',
        '--gate-id',
        'two',
        '--failure-route',
        'blocked',
        '--cwd',
        cwd,
        '--expect',
        'pass',
        '--command',
        'exit 0',
      ]),
    /--gate-id may be provided only once/,
  );
});

test('accepts a cleanup actor as a deterministic failure route', () => {
  const cwd = temporaryDirectory('codex-code-gate-');
  const options = parseArgs([
    '--gate-id',
    'cleanup:format:gate',
    '--failure-route',
    'cleanup:format',
    '--cwd',
    cwd,
    '--expect',
    'pass',
    '--command',
    'exit 0',
  ]);
  assert.equal(options.failureRoute, 'cleanup:format');
});
