import assert from 'node:assert/strict';
import { isArray, isRecord } from './input.ts';

export const reviewModel = { model: 'gpt-6-astra', reasoningEffort: 'high' };
const text = { type: 'string', minLength: 1 };
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const choice = (...values: string[]) => ({ type: 'string', enum: values });
const list = (items: unknown) => ({ type: 'array', items });
export const reviewSchema = object({
  status: choice('accepted', 'needs_changes'),
  findings: text,
  targetId: text,
  assessments: object({ code: text, requirements: text, tests: text, documentation: text }),
  items: list(
    object({
      id: text,
      introducedIn: text,
      kind: choice('defect', 'concern'),
      area: choice('code', 'requirements', 'tests', 'documentation'),
      required: { type: 'boolean' },
      location: object({
        path: { type: ['string', 'null'] },
        line: { type: ['integer', 'null'], minimum: 1 },
      }),
      condition: text,
      impact: text,
      evidence: text,
      action: text,
      disposition: choice('open', 'fixed', 'not_applicable'),
      reason: text,
    }),
  ),
  documents: list(
    object({ path: text, role: choice('current', 'historical', 'proposal'), reason: text }),
  ),
  handoff: list(text),
});

export interface ReviewItem {
  id: string;
  introducedIn: string;
  kind: 'defect' | 'concern';
  area: 'code' | 'requirements' | 'tests' | 'documentation';
  required: boolean;
  location: { path: string | null; line: number | null };
  condition: string;
  impact: string;
  evidence: string;
  action: string;
  disposition: 'open' | 'fixed' | 'not_applicable';
  reason: string;
}
export interface Review {
  status: 'accepted' | 'needs_changes';
  findings: string;
  targetId: string;
  assessments: { code: string; requirements: string; tests: string; documentation: string };
  items: ReviewItem[];
  documents: { path: string; role: 'current' | 'historical' | 'proposal'; reason: string }[];
  handoff: string[];
}
const oneOf = (value: unknown, choices: string[]) =>
  typeof value === 'string' && choices.includes(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}
function location(value: unknown) {
  return (
    fields(value, ['path', 'line']) &&
    (value.path === null || nonempty(value.path)) &&
    (value.line === null ||
      (nonempty(value.path) && Number.isSafeInteger(value.line) && Number(value.line) > 0))
  );
}
function item(value: unknown): value is ReviewItem {
  if (
    !fields(value, [
      'id',
      'introducedIn',
      'kind',
      'area',
      'required',
      'location',
      'condition',
      'impact',
      'evidence',
      'action',
      'disposition',
      'reason',
    ])
  ) {
    return false;
  }
  return (
    ['id', 'introducedIn', 'condition', 'impact', 'evidence', 'action', 'reason'].every((key) =>
      nonempty(value[key]),
    ) &&
    oneOf(value.kind, ['defect', 'concern']) &&
    oneOf(value.area, ['code', 'requirements', 'tests', 'documentation']) &&
    typeof value.required === 'boolean' &&
    location(value.location) &&
    oneOf(value.disposition, ['open', 'fixed', 'not_applicable'])
  );
}
function document(value: unknown): value is Review['documents'][number] {
  return (
    fields(value, ['path', 'role', 'reason']) &&
    nonempty(value.path) &&
    nonempty(value.reason) &&
    oneOf(value.role, ['current', 'historical', 'proposal'])
  );
}
export function isReview(value: unknown): value is Review {
  if (
    !fields(value, [
      'status',
      'findings',
      'targetId',
      'assessments',
      'items',
      'documents',
      'handoff',
    ])
  ) {
    return false;
  }
  return (
    oneOf(value.status, ['accepted', 'needs_changes']) &&
    nonempty(value.findings) &&
    nonempty(value.targetId) &&
    fields(value.assessments, ['code', 'requirements', 'tests', 'documentation']) &&
    Object.values(value.assessments).every(nonempty) &&
    isArray(value.items) &&
    value.items.every(item) &&
    isArray(value.documents) &&
    value.documents.every(document) &&
    isArray(value.handoff) &&
    value.handoff.every(nonempty)
  );
}
function original(item: ReviewItem) {
  const { disposition: _disposition, reason: _reason, ...details } = item;
  return details;
}
export function parseReview(
  stdout: string,
  targetId: string,
  attempt: number,
  previous?: Review,
): Review {
  const value: unknown = JSON.parse(stdout);
  assert(isReview(value), 'Missing or invalid review fields');
  assert(value.targetId === targetId, 'Review target mismatch');
  const ids = new Set(value.items.map((item) => item.id));
  assert(ids.size === value.items.length, 'Duplicate finding ID');
  const old = new Map(previous?.items.map((item) => [item.id, item]));
  for (const finding of value.items) {
    const prior = old.get(finding.id);
    if (prior) {
      assert.deepEqual(original(finding), original(prior), 'Prior finding details changed');
    } else {
      assert(
        finding.id.startsWith(`R${attempt}-`) &&
          finding.introducedIn === targetId &&
          finding.disposition === 'open',
        'Invalid new finding identity or disposition',
      );
    }
  }
  assert(
    [...old.keys()].every((id) => ids.has(id)),
    'Prior finding omitted',
  );
  const unresolved = value.items.some((item) => item.required && item.disposition === 'open');
  assert(
    (value.status === 'needs_changes') === unresolved,
    'Review status contradicts required findings',
  );
  assert(
    new Set(value.documents.map((doc) => doc.path)).size === value.documents.length,
    'Duplicate document reference',
  );
  return value;
}

export const reviewInstructions = [
  'Independently review the current deliverables. Read the diff AND affected callers, shared types, state transitions, error handling and relevant tests. Do not audit unrelated code or demand out-of-scope features or stylistic preferences.',
  'Assess four separate dimensions: code correctness (input boundaries, state updates, async behavior and failure side effects); agreed Issue requirements and scope; realistic test detection; required documentation and evidence consistency with the implementation version.',
  'Report code defects even when the Issue does not explicitly enumerate the behavior. Distinguish demonstrated defects from unverified concerns. Neither no findings nor passing check guarantees absence of defects.',
  'Read the target test policy. Ask what realistic bug deleting each relevant test would miss, weigh assurance against runtime, flakiness and maintenance, and detect copied expectations or negative tests passing for the wrong reason. Justified deletion or consolidation is not a defect merely because counts decrease.',
  'Apply the target documentation policy, including documentation-only changes. Distinguish current policy, historical evidence and unadopted proposals. Do not require new code or tests without a relevant requirement.',
  'Do not edit files or run the full check. The host check result is in the target record. Use current artifacts and necessary targeted verification to adjudicate findings; do not trust repair self-reports.',
  'Return the review JSON schema. Echo targetId from the host context. Give substantive reasons in all four assessments, including applicability and unverified limits. findings is the overall summary.',
  'Each item needs a stable ID R<attempt>-<name>, introducedIn equal to this targetId, kind defect or concern, area code/requirements/tests/documentation, required, location, condition, impact, evidence, action, disposition open, and reason. Use null path/line when no real code location exists, including missing documentation. Never invent locations or reproduction runs.',
  'Carry EVERY previous item forward with its original details; update only disposition (open, fixed, not_applicable) and reason based on the current artifacts and verification. Explain concrete evidence for fixes or non-applicability, not merely an implementer claim. Reopen when needed. Keep unresolved required items open; accepted cannot contain them.',
  'List principal repository documents actually consulted with their exact repository-relative path, role current/historical/proposal and reference reason. The host binds their versions; this is not proof of sufficient reading or a whole-document index.',
  'Publisher PR creation, upload and rendered-media checks, and human review/approval are handoff actions, not implementation defects. List pending actions in handoff; do not waive them or claim completion.',
].join('\n');

export function reviewSummary(history: Review[], recordPaths: string[]) {
  const current = history.at(-1);
  if (!current) {
    return '';
  }
  return [
    current.findings,
    `Review target: ${current.targetId}`,
    ...Object.entries(current.assessments).map(([key, value]) => `${key}: ${value}`),
    ...current.items.map(
      (item) =>
        `${item.id} (${item.area}/${item.kind}, ${item.disposition}, required=${item.required}, target=${item.introducedIn}): ${item.location.path ?? 'No file location'}${item.location.line === null ? '' : `:${item.location.line}`}: ${item.condition}; impact: ${item.impact}; evidence: ${item.evidence}; action: ${item.action}; judgment: ${item.reason}`,
    ),
    ...current.handoff.map((action) => `Handoff: ${action}`),
    `Review records (host-local): ${recordPaths.join(', ')}`,
    'Structured validation and passing checks do not guarantee absence of defects.',
  ].join('\n\n');
}
