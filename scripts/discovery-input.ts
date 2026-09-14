import assert from 'node:assert/strict';
import { isRecord, isArray } from './input.ts';

export interface Assessment {
  revision: number;
  decision: string;
  checks: Record<string, { status: 'sufficient' | 'missing' | 'not_applicable'; reason: string }>;
  next: string;
}
export interface Session {
  repo: string;
  contextDir: string;
  referencePaths: string[];
  request: string;
  criteria: Record<string, string>;
  revision: number;
  assessment: Assessment | null;
  entries: { kind: string; text: string }[];
}
export function nonempty(value: unknown): asserts value is string {
  assert(typeof value === 'string' && value.trim(), 'Expected non-empty text');
}
export function criteria(value: unknown): asserts value is Record<string, string> {
  assert(isRecord(value) && Object.keys(value).length > 0, 'Criteria must not be empty');
  for (const [id, question] of Object.entries(value)) {
    assert(/^[a-z][a-z0-9_-]*$/.test(id), 'Invalid criterion ID');
    nonempty(question);
  }
}
export function assessment(
  value: unknown,
  rules: Record<string, string>,
): asserts value is Assessment {
  assert(isRecord(value) && Number.isSafeInteger(value.revision), 'Invalid assessment revision');
  nonempty(value.decision);
  nonempty(value.next);
  assert(isRecord(value.checks), 'Missing checks');
  assert(
    Object.keys(value.checks).length === Object.keys(rules).length,
    'Evaluate exactly the session criteria',
  );
  for (const id of Object.keys(rules)) {
    const check: unknown = value.checks[id];
    assert(isRecord(check), `Missing criterion: ${id}`);
    assert(
      typeof check.status === 'string' &&
        ['sufficient', 'missing', 'not_applicable'].includes(check.status),
      'Invalid status',
    );
    nonempty(check.reason);
  }
  assert(!('question' in value), 'Ask questions in chat, not in assessments');
}
export function session(value: unknown): asserts value is Session {
  assert(isRecord(value), 'Invalid session');
  nonempty(value.repo);
  nonempty(value.contextDir);
  nonempty(value.request);
  assert(isArray(value.referencePaths), 'Invalid reference paths');
  value.referencePaths.forEach(nonempty);
  criteria(value.criteria);
  assert(
    typeof value.revision === 'number' &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0,
    'Invalid revision',
  );
  assert(isArray(value.entries), 'Invalid entries');
  for (const entry of value.entries) {
    assert(isRecord(entry), 'Invalid entry');
    nonempty(entry.kind);
    nonempty(entry.text);
  }
  if (value.assessment !== null) {
    assessment(value.assessment, value.criteria);
    assert(value.assessment.revision === value.revision - 1, 'Stale saved assessment');
  }
  assert(
    !('question' in value),
    'Unsupported question-tracking session; preserve it and reassess selected context in a new session',
  );
}
export function ready(state: Session) {
  return (
    state.assessment !== null &&
    Object.values(state.assessment.checks).every((check) => check.status !== 'missing')
  );
}
