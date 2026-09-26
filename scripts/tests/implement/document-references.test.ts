import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'bun:test';
import { assertReportReferences } from '../../implement/input.ts';
import { researchHandoff, verifyReports } from '../../implement/research-handoff.ts';

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
  expect(researchHandoff(base, base, [`docs/research/result.md=${blob}`])).toEqual([
    { path: 'docs/research/result.md', blob },
  ]);
  expect(() => researchHandoff(base, base, [`research/result.md=${blob}`])).toThrow(
    'Required report must be a repo-relative Markdown path',
  );
});

test('report reads preserve filesystem failures other than a missing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-read-'));
  const path = 'docs/research/result.md';
  const blob = 'a'.repeat(40);
  try {
    await writeFile(join(root, 'docs'), 'not a directory');
    await assert.rejects(
      () =>
        verifyReports(
          root,
          'b'.repeat(40),
          [{ path, blob }],
          async () => `100644 blob ${blob}\t${path}`,
        ),
      { code: 'ENOTDIR' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
