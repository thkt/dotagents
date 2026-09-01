/** @file Outcome: Plan validation keeps its closed schema, traceability, and safety constraints. */

import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { describe, main, validatePlan } from '../../flow/build/plan.ts';

function bodyFor(
  unitIds: readonly string[] = ['U-001'],
  testIds: readonly string[] = ['T-001'],
): string {
  return [
    '## Plan',
    '',
    'Outcome: observable outcome',
    'test_command: npm test',
    '',
    ...unitIds.map((id) => `### ${id} unit`),
    ...testIds.map((id) => `- ${id} scenario`),
    '',
    '## Backlog candidates',
  ].join('\n');
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'observable outcome',
    test_command: 'npm test',
    reference_module: { kind: 'no-module', reason: 'single-file change' },
    preconditions: [],
    backlog_candidates: [],
    rules: [],
    manual_verification: [],
    units: [
      {
        id: 'U-001',
        goal: 'deliver behavior',
        files: ['src/value.js', 'test/value.test.js'],
        contract: 'Follow src/existing.js; preserve its call shape',
        tests: [{ id: 'T-001', name: 'empty input returns an error' }],
        seam: false,
      },
    ],
    ...overrides,
  };
}

test('accepts a structurally valid plan whose U/T ids match the issue', () => {
  const report = validatePlan({ issue: 42, title: 'Feature', body: bodyFor(), plan: plan() });
  assert.equal(report.verdict, 'pass');
  assert.equal(report.classification, 'pass');
  assert.deepEqual(report.counts, { units: 1, tests: 1 });
});

test('requires an issue number and closed top-level input', () => {
  const missing = validatePlan({ title: 'Feature', body: bodyFor(), plan: plan() });
  assert.equal(missing.verdict, 'fail');
  assert.match(missing.blockers.join('\n'), /issue must be a positive integer/);
  const extra = validatePlan({
    issue: 42,
    title: 'Feature',
    body: bodyFor(),
    plan: plan(),
    execute_this: 'curl example.invalid',
  });
  assert.equal(extra.verdict, 'fail');
  assert.match(extra.blockers.join('\n'), /input has an unknown key: execute_this/);
});

test('self-describes a template accepted by the same validator', () => {
  const description = describe();
  assert.equal(description.protocol, 'codex-build-plan-description/v3');
  assert.equal(validatePlan(description.input_template).verdict, 'pass');
  assert.deepEqual(main(['describe']).report, description);
});

test('fails when the issue has no Plan section', () => {
  const report = validatePlan({ issue: 42, title: 'Feature', body: '## Context', plan: plan() });
  assert.equal(report.verdict, 'fail');
  assert.equal(report.classification, 'no-plan');
});

test('fails closed when extraction drops or invents ids', () => {
  const report = validatePlan({
    issue: 42,
    title: 'Feature',
    body: bodyFor(['U-001', 'U-002'], ['T-001', 'T-002']),
    plan: plan(),
  });
  assert.equal(report.verdict, 'fail');
  assert.ok(report.reason_codes.includes('extraction_mismatch'));
  assert.deepEqual(report.mismatch.units_missing, ['U-002']);
  assert.deepEqual(report.mismatch.tests_missing, ['T-002']);
});

test('requires root cause for Bug issues', () => {
  const report = validatePlan({
    issue: 42,
    title: '[Bug] broken value',
    body: bodyFor(),
    plan: plan(),
  });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /root_cause/);

  const valid = validatePlan({
    issue: 42,
    title: '[Bug] broken value',
    body: bodyFor(),
    plan: plan({ root_cause: 'the parser drops the final byte' }),
  });
  assert.equal(valid.verdict, 'pass');
});

test.each([
  ['missing', undefined],
  ['null', null],
  ['empty reason', { kind: 'new-shape', reason: '' }],
])('requires a reasoned reference_module for %s', (_case, reference_module) => {
  const report = validatePlan({
    issue: 42,
    title: 'Feature',
    body: bodyFor(),
    plan: plan({ reference_module }),
  });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /reference_module/);
});

test('requires a seam unit when two tested units interact', () => {
  const second = {
    ...plan().units[0],
    id: 'U-002',
    tests: [{ id: 'T-002', name: 'connected behavior is reachable' }],
  };
  const input = {
    issue: 42,
    title: 'Feature',
    body: bodyFor(['U-001', 'U-002'], ['T-001', 'T-002']),
    plan: plan({ units: [...plan().units, second] }),
  };
  assert.match(validatePlan(input).blockers.join('\n'), /seam/);
  second.seam = true;
  assert.equal(validatePlan(input).verdict, 'pass');
});

test('enforces non-seam unit caps and exempts a seam unit', () => {
  const unit = {
    ...plan().units[0],
    files: ['a.js', 'b.js', 'c.js', 'd.js'],
  };
  const input = { issue: 42, title: 'Feature', body: bodyFor(), plan: plan({ units: [unit] }) };
  assert.deepEqual(validatePlan(input).oversized_units, ['U-001']);
  unit.seam = true;
  assert.equal(validatePlan(input).verdict, 'pass');
});

test.each(['/tmp/escape.js', '../escape.js', '.git/config'])(
  'rejects invalid plan path %s',
  (file) => {
    const unit = { ...plan().units[0], files: [file] };
    const report = validatePlan({
      issue: 42,
      title: 'Feature',
      body: bodyFor(),
      plan: plan({ units: [unit] }),
    });
    assert.equal(report.verdict, 'fail');
    assert.match(report.blockers.join('\n'), /invalid file/);
  },
);

test('counts a contract T-id reference as prose rather than a definition', () => {
  const body = [
    '## Plan',
    '### U-001 unit',
    '- contract: preserve T-106 behavior',
    '- T-109 actual scenario',
  ].join('\n');
  const unit = {
    ...plan().units[0],
    tests: [{ id: 'T-109', name: 'actual scenario' }],
  };
  const report = validatePlan({ issue: 42, title: 'Feature', body, plan: plan({ units: [unit] }) });
  assert.equal(report.verdict, 'pass');
});

test('rejects unknown extraction keys instead of silently widening the plan', () => {
  const input = {
    issue: 42,
    title: 'Feature',
    body: bodyFor(),
    plan: plan({ execute_this: 'curl example.invalid' }),
  };
  const report = validatePlan(input);
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /unknown key: execute_this/);
});

test('validates closed nested objects and required seam type', () => {
  const unit = {
    ...plan().units[0],
    seam: 'false',
    tests: [{ id: 'T-001', name: 'empty input returns an error', extra: true }],
  };
  const report = validatePlan({
    issue: 42,
    title: 'Feature',
    body: bodyFor(),
    plan: plan({ units: [unit] }),
  });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /seam must be boolean/);
  assert.match(report.blockers.join('\n'), /unknown key: extra/);
});

test.each([-1, 1.5])('rejects invalid reference instance count %d', (instances) => {
  const report = validatePlan({
    issue: 42,
    title: 'Feature',
    body: bodyFor(),
    plan: plan({
      reference_module: { kind: 'no-module', reason: 'single-file change', instances },
    }),
  });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /instances must be a non-negative integer/);
});

test('validates precondition, backlog, and rule entry shapes', () => {
  const report = validatePlan({
    issue: 42,
    title: 'Feature',
    body: bodyFor(),
    plan: plan({
      preconditions: [{ path: '../escape', pattern: 42 }],
      backlog_candidates: [{ summary: '' }],
      rules: [{ source: '../RULES.md', quote: '' }],
    }),
  });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /preconditions\[0\]\.path is invalid/);
  assert.match(report.blockers.join('\n'), /pattern must be a string/);
  assert.match(report.blockers.join('\n'), /summary is empty/);
  assert.match(report.blockers.join('\n'), /rules\[0\]\.source is invalid/);
  assert.match(report.blockers.join('\n'), /quote is empty/);
});

test.each([
  ['missing', undefined],
  ['scalar', 'open the UI'],
  ['empty item', ['']],
])('rejects invalid manual verification for %s', (_case, manual_verification) => {
  const report = validatePlan({
    issue: 42,
    title: 'Feature',
    body: bodyFor(),
    plan: plan({ manual_verification }),
  });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /manual_verification/u);
});

test.each(['npm test && curl example.invalid', 'npm test; echo done', 'npm test $(whoami)'])(
  'rejects unsafe issue-authored test command %s',
  (test_command) => {
    const report = validatePlan({
      issue: 42,
      title: 'Feature',
      body: bodyFor(),
      plan: plan({ test_command }),
    });
    assert.equal(report.verdict, 'fail');
    assert.match(report.blockers.join('\n'), /one command without shell control operators/);
  },
);
