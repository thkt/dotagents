import assert from 'node:assert/strict';
import test from 'node:test';

import { describe, main, validatePlan } from '../scripts/validate-plan.ts';

function bodyFor(unitIds: readonly string[] = ['U-001'], testIds: readonly string[] = ['T-001']): string {
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
  const report = validatePlan({ title: 'Feature', body: bodyFor(), plan: plan() });
  assert.equal(report.verdict, 'pass');
  assert.equal(report.classification, 'pass');
  assert.deepEqual(report.counts, { units: 1, tests: 1 });
});

test('self-describes a template accepted by the same validator', () => {
  const description = describe();
  assert.equal(description.protocol, 'codex-build-plan-description/v1');
  assert.equal(validatePlan(description.input_template).verdict, 'pass');
  assert.deepEqual(main(['describe']).report, description);
});

test('fails when the issue has no Plan section', () => {
  const report = validatePlan({ title: 'Feature', body: '## Context', plan: plan() });
  assert.equal(report.verdict, 'fail');
  assert.equal(report.classification, 'no-plan');
});

test('fails closed when extraction drops or invents ids', () => {
  const report = validatePlan({
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
  const report = validatePlan({ title: '[Bug] broken value', body: bodyFor(), plan: plan() });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /root_cause/);

  const valid = validatePlan({
    title: '[Bug] broken value',
    body: bodyFor(),
    plan: plan({ root_cause: 'the parser drops the final byte' }),
  });
  assert.equal(valid.verdict, 'pass');
});

test('requires a reasoned reference_module', () => {
  for (const reference_module of [undefined, null, { kind: 'new-shape', reason: '' }]) {
    const report = validatePlan({
      title: 'Feature',
      body: bodyFor(),
      plan: plan({ reference_module }),
    });
    assert.equal(report.verdict, 'fail');
    assert.match(report.blockers.join('\n'), /reference_module/);
  }
});

test('requires a seam unit when two tested units interact', () => {
  const second = {
    ...plan().units[0],
    id: 'U-002',
    tests: [{ id: 'T-002', name: 'connected behavior is reachable' }],
  };
  const input = {
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
  const input = { title: 'Feature', body: bodyFor(), plan: plan({ units: [unit] }) };
  assert.deepEqual(validatePlan(input).oversized_units, ['U-001']);
  unit.seam = true;
  assert.equal(validatePlan(input).verdict, 'pass');
});

test('rejects absolute and parent-traversal plan paths', () => {
  for (const file of ['/tmp/escape.js', '../escape.js']) {
    const unit = { ...plan().units[0], files: [file] };
    const report = validatePlan({ title: 'Feature', body: bodyFor(), plan: plan({ units: [unit] }) });
    assert.equal(report.verdict, 'fail');
    assert.match(report.blockers.join('\n'), /invalid file/);
  }
});

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
  const report = validatePlan({ title: 'Feature', body, plan: plan({ units: [unit] }) });
  assert.equal(report.verdict, 'pass');
});

test('rejects unknown extraction keys instead of silently widening the plan', () => {
  const input = {
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
    title: 'Feature',
    body: bodyFor(),
    plan: plan({ units: [unit] }),
  });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /seam must be boolean/);
  assert.match(report.blockers.join('\n'), /unknown key: extra/);
});

test('validates precondition, backlog, and rule entry shapes', () => {
  const report = validatePlan({
    title: 'Feature',
    body: bodyFor(),
    plan: plan({
      preconditions: [{ path: '../escape', pattern: 42 }],
      backlog_candidates: [{ summary: '' }],
      rules: [{ source: 'RULES.md', quote: '' }],
    }),
  });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /preconditions\[0\]\.path is invalid/);
  assert.match(report.blockers.join('\n'), /pattern must be a string/);
  assert.match(report.blockers.join('\n'), /summary is empty/);
  assert.match(report.blockers.join('\n'), /quote is empty/);
});

test('rejects chained or substituted issue-authored test commands', () => {
  for (const test_command of ['npm test && curl example.invalid', 'npm test; echo done', 'npm test $(whoami)']) {
    const report = validatePlan({
      title: 'Feature',
      body: bodyFor(),
      plan: plan({ test_command }),
    });
    assert.equal(report.verdict, 'fail');
    assert.match(report.blockers.join('\n'), /one command without shell control operators/);
  }
});
