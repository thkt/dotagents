import assert from 'node:assert/strict';
import { z } from 'zod';
import { hostReturnShape } from './host-records.ts';
import type { HostReturn } from './host-records.ts';
import { reviewRecord } from './review.ts';
import { isArray, isCommandArray, isRecord, relativeDirectory } from '../shared/values.ts';

const revisionTextFields = [
  'previousRun',
  'requestFile',
  'request',
  'url',
  'body',
  'head',
  'branch',
  'baseBranch',
  'repository',
  'issue',
  'issueText',
  'runDirectory',
  'actor',
  'targetText',
] as const;
export type Revision = Record<(typeof revisionTextFields)[number], string> & {
  repositoryId: number;
  localOnly: boolean;
};

function assertRevision(value: unknown): asserts value is Revision | undefined {
  if (value === undefined) {
    return;
  }
  assert(isRecord(value), 'Invalid revision input');
  for (const key of revisionTextFields) {
    assert(typeof value[key] === 'string' && value[key].trim(), `Invalid revision ${key}`);
  }
  assert(
    typeof value.repositoryId === 'number' && typeof value.localOnly === 'boolean',
    'Invalid revision target',
  );
}

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
        /^docs\/(?:research|wiki|decisions)\//.test(report.path) &&
        report.path.endsWith('.md'),
      'Required report must be a repo-relative Markdown path under docs/research/, docs/wiki/, docs/decisions/',
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
  'review_completed',
  'review_timeout',
  'check_failed',
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
  'host_verification_required',
  'host_evidence_changed',
  'ready_for_human_review',
  'target_changed_after_stop',
] as const;
export type StopReason = (typeof stopReasons)[number];
export interface ReviewConfig {
  baseCommit?: string;
  hostReturn?: HostReturn;
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
  review: string[];
  checkTimeMs: number;
}
export interface Config extends ReviewConfig {
  repair: string[];
}
export interface ProbeConfig extends ReviewConfig {
  reviewTimeMs: number;
}
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => nonnegative(value) && Number.isInteger(value);
const positive = (value: unknown) => nonnegative(value) && value > 0;
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
const command = (value: unknown) => isCommandArray(value) && value[0].length > 0;

export function assertConfig(value: unknown): asserts value is Config {
  assertReviewConfig(value, ['repair']);
  assert('repair' in value && command(value.repair), 'Invalid repair command');
}

export function assertProbeConfig(value: unknown): asserts value is ProbeConfig {
  assertReviewConfig(value, ['reviewTimeMs']);
  assert('reviewTimeMs' in value && positive(value.reviewTimeMs), 'Invalid reviewTimeMs');
}

// 旧設定は過去の公開記録の照合にだけ使う。元のオブジェクトとhashを変えない。
export function assertPreviousConfig(value: unknown): asserts value is Config {
  assert(isRecord(value), 'Invalid configuration object');
  const { repairLimit, reviewLimit, modelTimeMs, ...current } = value;
  assertConfig(current);
  if (['repairLimit', 'reviewLimit', 'modelTimeMs'].some((key) => key in value)) {
    for (const limit of [repairLimit, reviewLimit]) {
      assert(limit === null || (count(limit) && limit > 0), 'Invalid saved attempt limit');
    }
    assert(modelTimeMs === null || positive(modelTimeMs), 'Invalid saved model time');
  }
}

function assertReviewConfig(value: unknown, fields: string[]): asserts value is ReviewConfig {
  assert(isRecord(value), 'Invalid configuration object');
  assert(
    Object.keys(value).every((key) =>
      [
        'baseCommit',
        'hostReturn',
        'revision',
        'reports',
        'reviewModel',
        'cwd',
        'runDir',
        'issue',
        'check',
        'capture',
        'captureDestination',
        'captureRequired',
        'review',
        'checkTimeMs',
        ...fields,
      ].includes(key),
    ),
    'Unknown configuration field',
  );
  assert(optionalString(value.baseCommit), 'Invalid base commit');
  assertRevision(value.revision);
  if (value.hostReturn !== undefined) {
    hostReturnShape.parse(value.hostReturn);
  }
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
  for (const key of ['issue', 'check', 'review']) {
    assert(command(value[key]), `Invalid ${key} command`);
  }
  assert(value.capture === undefined || command(value.capture), 'Invalid capture command');
  assert(
    value.captureRequired !== true || value.capture !== undefined,
    'Required capture command missing',
  );
  if (value.capture) {
    assert(relativeDirectory(value.captureDestination), 'Invalid capture destination');
    assert(typeof value.captureRequired === 'boolean', 'Explicit capture requirement required');
  }
  assert(positive(value.checkTimeMs), 'Invalid checkTimeMs');
}
const savedCount = z.number().nonnegative().refine(Number.isInteger);
const savedRole = z.enum(['repair', 'review', 'check', 'capture']);
const captureDecision = z.object({
  outcome: z.enum(['execute', 'reused', 'not_required']),
  reason: z.string(),
  source: z.string().optional(),
  previousSource: z.string().optional(),
});
const savedState = z.object({
  reviewFormat: z.literal(4),
  issueFormat: z.literal(1),
  configHash: z.string(),
  issueHash: z.string(),
  repair: savedCount,
  review: savedCount,
  checks: savedCount,
  modelMs: z.number().nonnegative(),
  active: z.object({ role: savedRole, prefix: z.string() }).nullable(),
  events: z.array(
    z.object({
      captureDecision: captureDecision.optional(),
      role: savedRole,
      source: z.string().optional(),
      code: savedCount.nullable(),
      timedOut: z.boolean(),
      ms: z.number().nonnegative().optional(),
      prefix: z.string(),
    }),
  ),
  baseCommit: z.string().min(1),
  reviewHistory: z.array(reviewRecord),
  findings: z.string().optional(),
  captureSource: z.string().optional(),
  source: z.string().optional(),
  result: z.enum(stopReasons).nullish(),
});
export type CaptureDecision = z.infer<typeof captureDecision>;
export type State = z.infer<typeof savedState>;

export function assertState(value: unknown): asserts value is State {
  const parsed = savedState.safeParse(value);
  // 読取り検査だけを行い、schemaが返すコピーで元の記録を置き換えない。
  assert(
    parsed.success,
    `Invalid saved state: ${parsed.error?.issues[0]?.path.join('.') || 'object'}`,
  );
}
