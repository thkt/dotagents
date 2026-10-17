type Result = { kind: 'result'; status: 'success'; artifact: string } | { kind: 'result'; status: 'failure'; reason: string };
type Event = { kind: 'event'; [key: string]: unknown };
const present = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
export function saveResult(value: unknown, write: (value: Result | Event) => void) {
  if (typeof value !== 'object' || value === null) return '入力が不正です。';
  const record = value as Record<string, unknown>;
  if (record.kind === 'event') { write(value as Event); return null; }
  if (record.kind !== 'result') return '入力が不正です。';
  if (record.status !== 'success' && record.status !== 'failure') return '状態エラー';
  if (record.status === 'success' && !present(record.artifact)) return 'artifactエラー';
  if (record.status === 'failure' && !present(record.reason)) return 'reasonエラー';
  write(value as Result);
  return null;
}
