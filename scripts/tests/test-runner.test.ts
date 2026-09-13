import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { checkReport } from '../test.ts';
import { runnerTests } from './support/runner.ts';

runnerTests('bun', resolve(import.meta.dir, '../../node_modules'));

// Keep the runner's format valid so each case reaches the intended summary rule.
for (const { name, bun, playwright } of [
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
