import { test, expect } from 'bun:test';
import { assertReportReferences } from '../input.ts';
import { researchHandoff } from '../research-handoff.ts';

test('repository research, wiki and decisions share the versioned document boundary', () => {
  for (const path of [
    'docs/research/result.md',
    'docs/wiki/start.md',
    'docs/decisions/0001-start.md',
  ]) {
    expect(() => assertReportReferences([{ path, blob: 'a'.repeat(40) }])).not.toThrow();
  }
  for (const path of [
    'docs/wiki/../../outside.md',
    '/docs/wiki/start.md',
    'docs/wiki-copy/start.md',
    'docs/decisions/start.json',
    'research/result.md',
    'README.md',
  ]) {
    expect(() => assertReportReferences([{ path, blob: 'a'.repeat(40) }])).toThrow();
  }
  expect(() => assertReportReferences([{ path: 'docs/wiki/start.md', blob: 'HEAD' }])).toThrow();
});

test('handoffs accept only current docs paths', () => {
  const base = 'b'.repeat(40);
  const blob = 'a'.repeat(40);
  for (const path of [
    'docs/research/result.md',
    'docs/wiki/start.md',
    'docs/decisions/0001-start.md',
  ]) {
    expect(researchHandoff(base, base, [`${path}=${blob}`])).toEqual([{ path, blob }]);
  }
  expect(() => researchHandoff(base, base, [`research/result.md=${blob}`])).toThrow(
    'Required report must be a repo-relative Markdown path',
  );
  expect(() => assertReportReferences([{ path: 'research/result.md', blob }])).toThrow();
});
