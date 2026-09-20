import assert from 'node:assert/strict';
import { assertRevision } from './revision.ts';
import type { Revision } from './revision.ts';
import { isReview } from './review.ts';
import type { Review } from './review.ts';
import { isArray, isRecord, relativeDirectory } from './values.ts';

export type ActorRole = 'repair' | 'review';
export interface ReportReference {
  path: string;
  blob: string;
}

export function assertReportReferences(value: unknown): asserts value is ReportReference[] {
  assert(isArray(value), 'Invalid required reports');
  const paths = new Set<string>();
  for (const report of value) {
    assert(isRecord(report), 'Invalid required report');
    assert(
      relativeDirectory(report.path) &&
        report.path.startsWith('research/') &&
        report.path.endsWith('.md'),
      'Required report must be a repo-relative research/*.md path',
    );
    assert(
      typeof report.blob === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(report.blob),
      `Expected reviewed Git blob ID: ${report.path}`,
    );
    assert(!paths.has(report.path), 'Duplicate required report');
    paths.add(report.path);
  }
}
const stopReasons = [
  'execution_limit',
  'repair_failed',
  'review_failed',
  'requirements_changed',
  'source_changed',
  'check_unavailable',
  'capture_unavailable',
  'capture_timeout',
  'invalid_review',
  'review_storage_failed',
  'invalid_repair',
  'human_decision_required',
  'ready_for_human_review',
  'target_changed_after_stop',
] as const;
export type StopReason = (typeof stopReasons)[number];
export interface Config {
  baseCommit?: string;
  revision?: Revision;
  reports?: ReportReference[];
  reviewModel?: { model: string; reasoningEffort: string };
  cwd: string;
  runDir: string;
  issue: string[];
  check: string[];
  capture?: string[];
  captureDestination?: string;
  captureRequired?: boolean;
  repair: string[];
  review: string[];
  repairLimit: number;
  reviewLimit: number;
  // null explicitly disables only the model elapsed-time limit.
  modelTimeMs: number | null;
  checkTimeMs: number;
}
export interface CaptureDecision {
  outcome: 'execute' | 'reused' | 'not_required';
  reason: string;
  source?: string;
  previousSource?: string;
}
interface Event {
  captureDecision?: CaptureDecision;
  role: ActorRole | 'check' | 'capture';
  source?: string;
  code: number | null;
  timedOut: boolean;
  ms?: number;
  prefix: string;
}
export interface State {
  reviewFormat: 4;
  baseCommit: string;
  reviewHistory: Review[];
  configHash: string;
  issueHash: string;
  repair: number;
  review: number;
  checks: number;
  modelMs: number;
  active: { role: ActorRole | 'check' | 'capture'; prefix: string } | null;
  events: Event[];
  source?: string;
  captureSource?: string;
  result?: StopReason | null;
  findings?: string;
}

const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => nonnegative(value) && Number.isInteger(value);
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
const role = (value: unknown) =>
  value === 'check' || value === 'repair' || value === 'review' || value === 'capture';
const command = (value: unknown) =>
  isArray(value) &&
  typeof value[0] === 'string' &&
  value[0].length > 0 &&
  value.every((v) => typeof v === 'string');

export function assertConfig(value: unknown): asserts value is Config {
  assert(isRecord(value), 'Invalid configuration object');
  assert(
    !('writing' in value),
    'writing is no longer supported; remove writing from correction input and review the documentation policy before starting a new run. Preserve existing runs.',
  );
  assert(optionalString(value.baseCommit), 'Invalid base commit');
  assertRevision(value.revision);
  if (value.reports !== undefined) {
    assertReportReferences(value.reports);
    assert(value.reports.length === 0 || value.baseCommit, 'Required reports need baseCommit');
  }
  assert(
    value.reviewModel === undefined ||
      (isRecord(value.reviewModel) &&
        typeof value.reviewModel.model === 'string' &&
        typeof value.reviewModel.reasoningEffort === 'string'),
    'Invalid review model',
  );
  for (const key of ['cwd', 'runDir']) {
    assert(typeof value[key] === 'string' && value[key].length > 0, `Invalid ${key}`);
  }
  for (const key of ['issue', 'check', 'repair', 'review']) {
    assert(command(value[key]), `Invalid ${key} command`);
  }
  assert(value.capture === undefined || command(value.capture), 'Invalid capture command');
  assert(
    value.captureRequired !== true || command(value.capture),
    'Required capture command missing',
  );
  if (value.capture) {
    assert(relativeDirectory(value.captureDestination), 'Invalid capture destination');
    assert(typeof value.captureRequired === 'boolean', 'Explicit capture requirement required');
  }
  for (const key of ['repairLimit', 'reviewLimit']) {
    const limit: unknown = value[key];
    assert(count(limit) && limit > 0, `Invalid ${key}`);
  }
  assert(
    value.modelTimeMs === null || (nonnegative(value.modelTimeMs) && value.modelTimeMs > 0),
    'Invalid modelTimeMs',
  );
  assert(nonnegative(value.checkTimeMs) && value.checkTimeMs > 0, 'Invalid checkTimeMs');
}
function isCaptureDecision(value: unknown): value is CaptureDecision {
  return (
    isRecord(value) &&
    typeof value.outcome === 'string' &&
    ['execute', 'reused', 'not_required'].includes(value.outcome) &&
    typeof value.reason === 'string' &&
    optionalString(value.source) &&
    optionalString(value.previousSource)
  );
}
function isEvent(value: unknown): value is Event {
  if (!isRecord(value)) {
    return false;
  }
  return (
    role(value.role) &&
    (value.captureDecision === undefined || isCaptureDecision(value.captureDecision)) &&
    optionalString(value.source) &&
    (value.code === null || count(value.code)) &&
    typeof value.timedOut === 'boolean' &&
    (value.ms === undefined || nonnegative(value.ms)) &&
    typeof value.prefix === 'string'
  );
}
function validResult(value: unknown) {
  return value === undefined || value === null || stopReasons.some((reason) => reason === value);
}
export function assertState(value: unknown): asserts value is State {
  assert(isRecord(value), 'Invalid saved state');
  assert(
    value.reviewFormat !== undefined &&
      value.reviewFormat !== 1 &&
      value.reviewFormat !== 2 &&
      value.reviewFormat !== 3,
    'Historical review format cannot be converted or resumed; preserve existing run',
  );
  assert(value.reviewFormat === 4, 'Invalid review format');
  assert(
    typeof value.configHash === 'string' && typeof value.issueHash === 'string',
    'Invalid saved hashes',
  );
  assert(
    ['repair', 'review', 'checks'].every((key) => count(value[key])) && nonnegative(value.modelMs),
    'Invalid saved usage',
  );
  assert(
    value.active === null ||
      (isRecord(value.active) &&
        role(value.active.role) &&
        typeof value.active.prefix === 'string'),
    'Invalid active reservation',
  );
  assert(isArray(value.events) && value.events.every(isEvent), 'Invalid saved events');
  assert(
    typeof value.baseCommit === 'string' && value.baseCommit.length > 0,
    'Invalid saved base commit',
  );
  assert(
    isArray(value.reviewHistory) && value.reviewHistory.every(isReview),
    'Invalid saved review history',
  );
  assert(optionalString(value.findings), 'Invalid saved findings');
  assert(optionalString(value.captureSource), 'Invalid saved capture source');
  assert(optionalString(value.source) && validResult(value.result), 'Invalid saved result');
}
