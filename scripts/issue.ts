import assert from 'node:assert/strict';
import { isRecord } from './values.ts';

// Only the whitespace outside a JSON Issue is output framing. Do not reserialize
// JSON or trim plain requirements: their spaces and newlines are content.
export function issueText(stdout: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  return isRecord(value) && typeof value.title === 'string' && typeof value.body === 'string'
    ? stdout.trim()
    : stdout;
}

// Keep the former top-level Markdown boundary: examples inside quotes, lists,
// HTML or outer fences were never selections. Malformed selections still stop.
export function assertNoLegacyKnowledge(issue: string) {
  let body = issue;
  try {
    const value: unknown = JSON.parse(issue);
    if (isRecord(value) && typeof value.body === 'string') {
      body = value.body;
    }
  } catch {
    // Correction also accepts plain Issue text.
  }
  const selection = Bun.markdown.render(body, {
    paragraph: () => '',
    heading: () => '',
    html: () => '',
    blockquote: () => '',
    list: () => '',
    table: () => '',
    code: (_content, meta) => (meta?.language === 'dotagents-knowledge' ? 'legacy' : ''),
  });
  assert(
    !selection.trim(),
    'Legacy dotagents-knowledge selection is no longer supported. Preserve the original Issue, run and Git blobs; reconcile selected evidence and agreement in a new Issue, then use reviewed Markdown --report references and a new run. See scripts/README.md#旧共有知識からの移行. Do not resume or convert the old run.',
  );
}
