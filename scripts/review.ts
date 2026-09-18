import assert from 'node:assert/strict';
import { isArray, isRecord } from './values.ts';

export const reviewModel = { model: 'gpt-6-astra', reasoningEffort: 'high' };
const reviewStatuses = ['accepted', 'needs_changes'] as const;
const findingKinds = ['defect', 'concern'] as const;
const reviewAreas = ['code', 'requirements', 'tests', 'documentation'] as const;
const dispositions = ['open', 'fixed', 'not_applicable'] as const;
const documentRoles = ['current', 'historical', 'proposal'] as const;
const text = { type: 'string', minLength: 1 };
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const choice = (values: readonly string[]) => ({ type: 'string', enum: values });
const list = (items: unknown) => ({ type: 'array', items });
export const reviewSchema = object({
  findings: text,
  targetId: text,
  assessments: object({ code: text, requirements: text, tests: text, documentation: text }),
  updates: list(object({ id: text, disposition: choice(dispositions), reason: text })),
  newItems: list(
    object({
      id: text,
      kind: choice(findingKinds),
      area: choice(reviewAreas),
      required: { type: 'boolean' },
      location: object({
        path: { type: ['string', 'null'] },
        line: { type: ['integer', 'null'], minimum: 1 },
      }),
      condition: text,
      impact: text,
      evidence: text,
      action: text,
      reason: text,
    }),
  ),
  documents: list(object({ path: text, role: choice(documentRoles), reason: text })),
  handoff: list(text),
});

export interface ReviewItem {
  id: string;
  introducedIn: string;
  kind: (typeof findingKinds)[number];
  area: (typeof reviewAreas)[number];
  required: boolean;
  location: { path: string | null; line: number | null };
  condition: string;
  impact: string;
  evidence: string;
  action: string;
  disposition: (typeof dispositions)[number];
  reason: string;
}
export interface Review {
  status: (typeof reviewStatuses)[number];
  findings: string;
  targetId: string;
  assessments: { code: string; requirements: string; tests: string; documentation: string };
  items: ReviewItem[];
  documents: { path: string; role: (typeof documentRoles)[number]; reason: string }[];
  handoff: string[];
}
const oneOf = (value: unknown, choices: readonly string[]) =>
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
type NewReviewItem = Omit<ReviewItem, 'introducedIn' | 'disposition'>;
function newItem(value: unknown): value is NewReviewItem {
  if (
    !fields(value, [
      'id',
      'kind',
      'area',
      'required',
      'location',
      'condition',
      'impact',
      'evidence',
      'action',
      'reason',
    ])
  ) {
    return false;
  }
  return (
    ['id', 'condition', 'impact', 'evidence', 'action', 'reason'].every((key) =>
      nonempty(value[key]),
    ) &&
    oneOf(value.kind, findingKinds) &&
    oneOf(value.area, reviewAreas) &&
    typeof value.required === 'boolean' &&
    location(value.location)
  );
}
function item(value: unknown): value is ReviewItem {
  if (!isRecord(value)) {
    return false;
  }
  const { introducedIn, disposition, ...details } = value;
  return nonempty(introducedIn) && oneOf(disposition, dispositions) && newItem(details);
}
function document(value: unknown): value is Review['documents'][number] {
  return (
    fields(value, ['path', 'role', 'reason']) &&
    nonempty(value.path) &&
    nonempty(value.reason) &&
    oneOf(value.role, documentRoles)
  );
}
type ReviewResponse = Omit<Review, 'status' | 'items'> & {
  updates: Pick<ReviewItem, 'id' | 'disposition' | 'reason'>[];
  newItems: NewReviewItem[];
};
function reviewDetails(value: Record<string, unknown>) {
  return (
    nonempty(value.findings) &&
    nonempty(value.targetId) &&
    fields(value.assessments, ['code', 'requirements', 'tests', 'documentation']) &&
    Object.values(value.assessments).every(nonempty) &&
    isArray(value.documents) &&
    value.documents.every(document) &&
    isArray(value.handoff) &&
    value.handoff.every(nonempty)
  );
}
export function isReview(value: unknown): value is Review {
  return (
    fields(value, [
      'status',
      'findings',
      'targetId',
      'assessments',
      'items',
      'documents',
      'handoff',
    ]) &&
    oneOf(value.status, reviewStatuses) &&
    reviewDetails(value) &&
    isArray(value.items) &&
    value.items.every(item)
  );
}
function isReviewResponse(value: unknown): value is ReviewResponse {
  return (
    fields(value, [
      'findings',
      'targetId',
      'assessments',
      'updates',
      'newItems',
      'documents',
      'handoff',
    ]) &&
    reviewDetails(value) &&
    isArray(value.newItems) &&
    value.newItems.every(newItem) &&
    isArray(value.updates) &&
    value.updates.every(
      (update) =>
        fields(update, ['id', 'disposition', 'reason']) &&
        nonempty(update.id) &&
        oneOf(update.disposition, dispositions) &&
        nonempty(update.reason),
    )
  );
}
export function parseReview(
  stdout: string,
  targetId: string,
  attempt: number,
  previous?: Review,
): Review {
  const value: unknown = JSON.parse(stdout);
  assert(isReviewResponse(value), 'Missing or invalid review fields');
  assert(value.targetId === targetId, 'Review target mismatch');
  const priorItems = previous?.items ?? [];
  const ids = new Set(priorItems.map((item) => item.id));
  const updates = new Map(value.updates.map((update) => [update.id, update]));
  assert(updates.size === value.updates.length, 'Duplicate finding update ID');
  assert(
    value.updates.every((update) => ids.has(update.id)),
    'Unknown finding update ID',
  );
  const items = priorItems.map((prior) => {
    const update = updates.get(prior.id);
    assert(update, 'Prior finding omitted');
    return { ...prior, disposition: update.disposition, reason: update.reason };
  });
  for (const finding of value.newItems) {
    assert(!ids.has(finding.id), 'Duplicate finding ID');
    ids.add(finding.id);
    const prefix = `R${attempt}-`;
    assert(
      finding.id.startsWith(prefix) && nonempty(finding.id.slice(prefix.length)),
      'Invalid new finding identity',
    );
    items.push({ ...finding, introducedIn: targetId, disposition: 'open' });
  }
  assert(
    new Set(value.documents.map((doc) => doc.path)).size === value.documents.length,
    'Duplicate document reference',
  );
  const { updates: _updates, newItems: _newItems, ...details } = value;
  return {
    ...details,
    items,
    status: items.some((item) => item.required && item.disposition === 'open')
      ? 'needs_changes'
      : 'accepted',
  };
}

export const reviewInstructions = [
  'Independently review the current deliverables. Read the diff AND affected callers, shared types, state transitions, error handling and relevant tests. Do not audit unrelated code or demand out-of-scope features or stylistic preferences.',
  'Assess four separate dimensions: code correctness (input boundaries, state updates, async behavior and failure side effects); agreed Issue requirements and scope; realistic test detection; required documentation and evidence consistency with the implementation version.',
  'Report code defects even when the Issue does not explicitly enumerate the behavior. Distinguish demonstrated defects from unverified concerns. Neither no findings nor passing check guarantees absence of defects.',
  'Read the target test policy. Ask what realistic bug deleting each relevant test would miss, weigh assurance against runtime, flakiness and maintenance, and detect copied expectations or negative tests passing for the wrong reason. Justified deletion or consolidation is not a defect merely because counts decrease.',
  'Apply the target documentation policy, including documentation-only changes. Compare changed documents with the Issue, original sources, code and check results, including facts, quantities, conditions, scope, authority, unverified claims and references. Assess whether readers can make the required decisions; return concrete content defects to repair. Distinguish current policy, historical evidence and unadopted proposals. Do not require new code or tests without a relevant requirement.',
  'Compare implementation premises with the selected knowledge nodes and Issue/report references and their handoff versions in the host context. In requirements/documentation assessments, explain relevant applicability, agreement and changed evidence; use document reasons for source selection. Trace contradictory observations through node relations to the affected premise and Issue decision; independently investigate evidence, then propose a diff or return missing facts to investigation and requirement/authority changes to humans. Model edits are not authorization. A decision-blocking gap or contradiction is a required open finding with the affected decision and return path in action, not an accepted handoff task. Human decisions cannot be resolved by the reviewer.',
  'Do not edit files or run the full check. The host check result is in the target record. Use current artifacts and necessary targeted verification to adjudicate findings; do not trust repair self-reports.',
  'Return the review JSON schema. Echo targetId from the host context. Give substantive reasons in all four assessments, including applicability and unverified limits. findings is the overall summary. Return updates and newItems, not status or items; the host reconstructs the complete record and computes status from required open findings.',
  'The existing PR generator selects assessments, item condition/impact/reason (and action for open items), document reasons and handoff for public readers. In code assessment explain the concrete change and why it is needed; in requirements map it to the agreed behavior; in tests state actual verification and limits, distinguishing simulated tests from live execution; in documentation explain applicable sources, versions, agreement and changed premises. Use concise factual prose, not generic all-passed claims. Keep raw logs and host-local record references in evidence/findings and the internal records, not these public-facing fields. For prior findings, reason should explain the current resolution without copying raw evidence.',
  'Each newItems entry needs a stable ID R<attempt>-<name>, kind defect or concern, area code/requirements/tests/documentation, required, location, condition, impact, evidence, action, and reason. Omit introducedIn and disposition; the host assigns the validated targetId and open. Use null path/line when no real code location exists, including missing documentation. Never invent locations or reproduction runs.',
  'Return exactly one updates entry for EVERY previous item ID, including already resolved items; use only id, disposition (open, fixed, not_applicable) and reason based on the current artifacts and verification. The host preserves the original details. Do not repeat them or place prior IDs in newItems. On the first review updates is empty. Explain concrete evidence for fixes or non-applicability, not merely an implementer claim. Reopen when needed. Keep unresolved required items open.',
  'List principal repository documents actually consulted with their exact repository-relative path, role current/historical/proposal and reference reason. The host binds their versions; this is not proof of sufficient reading or a whole-document index.',
  'The host alone adds routine publication/upload/CI tasks, responsible-AI public evidence comparison and rendered-media/layout checks, and human review/approval/merge to the PR body according to execution conditions. Do not repeat them in handoff or other public-facing fields. Their pending status before publication is not an implementation defect; accepted does not complete or waive them. Limit handoff to Issue-specific unverified conditions, required follow-up and named owners; return [] when none remain. Keep distinct conditions and owners even when wording is similar.',
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
    ...current.documents.map((doc) => `Source: ${doc.path} (${doc.role}): ${doc.reason}`),
    ...current.items.map(
      (item) =>
        `${item.id} (${item.area}/${item.kind}, ${item.disposition}, required=${item.required}, target=${item.introducedIn}): ${item.location.path ?? 'No file location'}${item.location.line === null ? '' : `:${item.location.line}`}: ${item.condition}; impact: ${item.impact}; evidence: ${item.evidence}; action: ${item.action}; judgment: ${item.reason}`,
    ),
    ...current.handoff.map((action) => `Handoff: ${action}`),
    `Review records (host-local): ${recordPaths.join(', ')}`,
    'Structured validation and passing checks do not guarantee absence of defects.',
  ].join('\n\n');
}
