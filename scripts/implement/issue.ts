import { isRecord } from '../shared/values.ts';

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
