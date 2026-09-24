import { test, expect } from 'bun:test';
import { assertReportReferences } from '../input.ts';
import { researchHandoff } from '../research-handoff.ts';

test('repository research, wiki and decisions share the versioned document boundary', () => {
  for (const path of [
    'research/result.md',
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
    'README.md',
  ]) {
    expect(() => assertReportReferences([{ path, blob: 'a'.repeat(40) }])).toThrow();
  }
  expect(() => assertReportReferences([{ path: 'docs/wiki/start.md', blob: 'HEAD' }])).toThrow();
});

test('new handoffs use docs while saved legacy references remain readable', () => {
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
    'New report handoffs must use docs/',
  );
  expect(() => assertReportReferences([{ path: 'research/result.md', blob }])).not.toThrow();
});
