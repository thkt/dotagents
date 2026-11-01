import assert from 'node:assert/strict';
import { isRecord } from '../shared/values.ts';

export function checkReport(runner: 'bun' | 'playwright', text: string, allowSkipped = false) {
  let total: unknown, skipped: unknown;
  if (runner === 'bun') {
    // Read only the root summary emitted by pinned Bun, not testcase text or logs.
    const summary = /^<\?xml[^>]*>\s*<testsuites\s+([^>]*)>/.exec(text)?.[1];
    assert(
      summary && text.trimEnd().endsWith('</testsuites>'),
      'Missing or incomplete Bun JUnit summary',
    );
    const testsAttribute = /\btests="(\d+)"/.exec(summary)?.[1];
    const skippedAttribute = /\bskipped="(\d+)"/.exec(summary)?.[1];
    total = testsAttribute === undefined ? undefined : Number(testsAttribute);
    skipped = skippedAttribute === undefined ? undefined : Number(skippedAttribute);
  } else {
    const report: unknown = JSON.parse(text);
    assert(isRecord(report) && isRecord(report.stats), 'Missing Playwright stats');
    total = report.stats.expected;
    skipped = report.stats.skipped;
  }
  assert(typeof total === 'number' && Number.isInteger(total) && total > 0, 'No completed tests');
  assert(
    typeof skipped === 'number' && Number.isInteger(skipped) && skipped >= 0 && skipped <= total,
    `Unexecuted tests or invalid skipped count: ${String(skipped)}`,
  );
  assert(allowSkipped || skipped === 0, `Unexecuted tests or invalid skipped count: ${skipped}`);
  return total - skipped;
}
