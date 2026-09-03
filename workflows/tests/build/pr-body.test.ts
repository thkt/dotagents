/** @file Outcome: PR body rendering remains complete, bounded, and safe for adversarial content. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { prepareShipInput } from '../../build/git-actions.ts';
import { describe, main, render, validatePayload } from '../../build/pr-body.ts';
import type { FlowState } from '../../execution/contracts.ts';
import { prInputPath } from '../../shared/storage.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-pr-body-tests-');

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issue: 42,
    outcome: 'Users can save and retrieve a value.',
    unit_goals: ['Persist the value.'],
    tests_pass: true,
    gates_pass: true,
    scope_deviations: [],
    ...overrides,
  };
}

test('renders the Plan outcome and unit goals before verification', () => {
  const body = render(payload());
  assert.match(body, /^## Summary/u);
  assert.match(body, /Users can save and retrieve a value\./u);
  assert.match(body, /- Persist the value\./u);
  assert.match(body, /## Verification/u);
  assert.match(body, /Closes #42/);
  assert.match(body, /verify tests=pass gates=pass/);
  assert.doesNotMatch(body, /<details>/);
});

test('prepares Summary content from the loaded Issue Plan', () => {
  const runId = `pr-body-${crypto.randomUUID()}`;
  prepareShipInput({
    run_id: runId,
    build_plan: {
      repository: 'owner/repo',
      issue: 42,
      title: 'Save values',
      outcome: 'Users can save and retrieve a value.',
      test_command: 'bun test',
      units: [
        {
          id: 'U-001',
          goal: 'Persist the value.',
          contract: 'The saved value can be retrieved.',
          files: ['src/value.ts'],
          tests: [{ id: 'T-001', name: 'returns the saved value' }],
        },
      ],
    },
    gate_reports: [],
    screenshots: [],
  } as unknown as FlowState);
  const prepared = JSON.parse(fs.readFileSync(prInputPath(runId), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(prepared.outcome, 'Users can save and retrieve a value.');
  assert.deepEqual(prepared.unit_goals, ['Persist the value.']);
});

test('self-describes a payload accepted by the same renderer', () => {
  const description = describe();
  assert.equal(description.protocol, 'codex-build-pr-body-description');
  assert.match(description.command, /--input.*--output/u);
  assert.doesNotThrow(() => validatePayload(description.input_template));
  assert.match(render(description.input_template), /Closes #123/);
  assert.deepEqual(main(['describe']).report, description);
});

test('shows observed scope and review findings', () => {
  const body = render(
    payload({
      tests_pass: false,
      scope_deviations: ['outside.js'],
      advisories: ['review: simplify the implementation'],
    }),
  );
  assert.match(body, /verify tests=FAIL gates=pass/);
  assert.match(body, /scope-deviations 1/);
  assert.match(body, /outside\.js/);
  assert.match(body, /simplify the implementation/u);
});

test('fails closed when a safety-critical key is absent or not boolean', () => {
  assert.throws(() => validatePayload({ issue: 1, tests_pass: true }), /gates_pass/);
  assert.throws(() => validatePayload(payload({ tests_pass: 'yes' })), /must be boolean/);
  assert.throws(() => validatePayload(payload({ issue: 0 })), /positive integer/);
  assert.throws(() => validatePayload(payload({ outcome: '' })), /outcome/u);
  assert.throws(() => validatePayload(payload({ unit_goals: [] })), /unit_goals/u);
});

test('renders declared screenshots as local references for gh to rewrite', () => {
  const body = render(
    payload({ screenshots: [{ name: 'login.png', alt: 'ログイン後のホーム画面' }] }),
  );
  assert.match(body, /## Screenshots/u);
  assert.match(body, /!\[ログイン後のホーム画面\]\(\.\/login\.png\)/u);
});

test('rejects more screenshots than gh can attach in one command', () => {
  const screenshots = Array.from({ length: 51 }, (_, index) => ({
    name: `screen-${index}.png`,
    alt: `Screen ${index}`,
  }));
  assert.throws(() => render(payload({ screenshots })), /at most 50 items/u);
});

test('keeps backticks and newlines in filenames inside one safe code span', () => {
  const body = render(payload({ scope_deviations: ['dir/odd`name\nline.js'] }));
  assert.match(body, /``dir\/odd`name line\.js``/);
});

test('writes the rendered body only to an explicit absolute output path', () => {
  const root = temporaryDirectory('codex-pr-body-');
  const input = path.join(root, 'input.json');
  const output = path.join(root, 'body.md');
  fs.writeFileSync(input, JSON.stringify(payload()));
  const result = main(['--input', input, '--output', output]);
  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(output, 'utf8'), result.output);
});
