/** @file Outcome: PR body rendering remains complete, bounded, and safe for adversarial content. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { codeFence, describe, main, render, validatePayload } from '../../flow/build/pr-body.ts';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issue: 42,
    tests_pass: true,
    gates_pass: true,
    scope_deviations: [],
    untouched_plan_files: [],
    missing_tests: [],
    ...overrides,
  };
}

test('renders a compact clean status with the GitHub closing keyword', () => {
  const body = render(payload());
  assert.match(body, /Closes #42/);
  assert.match(body, /verify tests=pass gates=pass/);
  assert.doesNotMatch(body, /<details>/);
});

test('self-describes a payload accepted by the same renderer', () => {
  const description = describe();
  assert.equal(description.protocol, 'codex-build-pr-body-description/v1');
  assert.match(description.command, /--input.*--output/u);
  assert.doesNotThrow(() => validatePayload(description.input_template));
  assert.match(render(description.input_template), /Closes #123/);
  assert.deepEqual(main(['describe']).report, description);
});

test('keeps every non-zero mechanical finding count visible while folded', () => {
  const body = render(
    payload({
      tests_pass: false,
      scope_deviations: ['outside.js'],
      untouched_plan_files: [{ unit_id: 'U-001', file: 'src/value.js' }],
      missing_tests: [{ test_id: 'T-001', name: 'empty input returns an error' }],
      verification_output: 'not ok',
    }),
  );
  assert.match(body, /verify tests=FAIL gates=pass/);
  assert.match(body, /scope-deviations 1/);
  assert.match(body, /untouched-plan-files 1/);
  assert.match(body, /missing-tests 1/);
  assert.match(body, /outside\.js/);
  assert.match(body, /T-001/);
});

test('fails closed when a safety-critical key is absent or not boolean', () => {
  assert.throws(() => validatePayload({ issue: 1, tests_pass: true }), /gates_pass/);
  assert.throws(() => validatePayload(payload({ tests_pass: 'yes' })), /must be boolean/);
  assert.throws(() => validatePayload(payload({ issue: 0 })), /positive integer/);
});

test('uses a longer fence than backtick runs in command output', () => {
  const fenced = codeFence('before ``` inside after');
  assert.ok(fenced.startsWith('````\n'));
  assert.ok(fenced.endsWith('\n````'));
});

test('renders Japanese fixed labels without trusting agent-authored labels', () => {
  const body = render(payload({ language: 'japanese', manual_checks: ['画面を確認する'] }));
  assert.match(body, /build の自動検証結果/);
  assert.match(body, /実機確認/);
});

test('keeps backticks and newlines in filenames inside one safe code span', () => {
  const body = render(payload({ scope_deviations: ['dir/odd`name\nline.js'] }));
  assert.match(body, /``dir\/odd`name line\.js``/);
});

test('writes the rendered body only to an explicit absolute output path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-pr-body-'));
  const input = path.join(root, 'input.json');
  const output = path.join(root, 'body.md');
  try {
    fs.writeFileSync(input, JSON.stringify(payload()));
    const result = main(['--input', input, '--output', output]);
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), result.output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
