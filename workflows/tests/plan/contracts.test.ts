/** @file Outcome: A Plan carries only implementation and verification information. */

import assert from 'node:assert/strict';
import { test } from 'bun:test';

import {
  compileBuildPlan,
  parseBuildPlanAuthoring,
  renderPlanMarkdown,
} from '../../plan/contracts.ts';
import { describe, validatePlan } from '../../plan/validation.ts';

const plan = {
  outcome: '利用者が値を保存できる。',
  test_command: 'bun test',
  units: [
    {
      goal: '値を保存する。',
      files: ['src/value.ts', 'tests/value.test.ts'],
      contract: '保存後に値を再取得できる。',
      tests: ['値を保存して再取得すると同じ値になる。'],
    },
  ],
};

test('accepts an implementable Plan', () => {
  assert.deepEqual(parseBuildPlanAuthoring(plan), plan);
  const report = validatePlan({ issue: 1, title: '保存', plan });
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.counts, { units: 1, tests: 1 });
});

test('renders one English Plan contract from the same Plan value', () => {
  const markdown = renderPlanMarkdown(plan);
  assert.match(markdown, /Outcome/u);
  assert.match(markdown, /Acceptance/u);
  assert.equal(compileBuildPlan(plan).value, plan);
});

test('rejects unsafe commands, unsafe paths, and unverifiable units', () => {
  const report = validatePlan({
    issue: 1,
    title: 'bad',
    plan: {
      ...plan,
      test_command: 'bun test && gh issue close 1',
      units: [{ ...plan.units[0], files: ['../outside'], tests: [] }],
    },
  });
  assert.equal(report.verdict, 'fail');
  assert.match(report.blockers.join('\n'), /one command/u);
  assert.match(report.blockers.join('\n'), /invalid path/u);
  assert.match(report.blockers.join('\n'), /no acceptance tests/u);
});

test('describe exposes only semantic Plan fields', () => {
  const template = describe().input_template.plan;
  assert.deepEqual(Object.keys(template), ['outcome', 'test_command', 'units']);
});
