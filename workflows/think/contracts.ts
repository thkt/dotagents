/** @file Outcome: Think inputs and agent decisions cross runtime boundaries only as closed, typed contracts. */

import * as fs from 'node:fs';
import path from 'node:path';

import { FlowError } from '../shared/errors.ts';
import { parseStageTimings, type StageTimings } from '../shared/codex.ts';
import { gitRoot } from '../shared/repository.ts';
import { isObject, rejectUnknownKeys, stringArray, type JsonObject } from '../shared/schema.ts';
import {
  BUILD_PLAN_AUTHORING_SCHEMA,
  STRING_ARRAY_SCHEMA,
  parseBuildPlanAuthoring,
  type BuildPlanAuthoring,
} from '../flow/build/authoring.ts';

export type ThinkPlan = BuildPlanAuthoring;

export const THINK_INPUT_PROTOCOL = 'codex-think-input/v1' as const;
export const THINK_REPORT_PROTOCOL = 'codex-think-report/v3' as const;
export const THINK_RESULT_PROTOCOL = 'codex-think-result/v1' as const;
export const THINK_DESCRIPTION_PROTOCOL = 'codex-think-description/v1' as const;

export type ThinkTaskType = 'bug' | 'feature' | 'docs' | 'chore';
export type ThinkLanguage = 'english' | 'japanese';
export type ThinkReadiness = 'ready' | 'research_required' | 'blocked';

export interface ThinkInput {
  protocol: typeof THINK_INPUT_PROTOCOL;
  repo: string;
  request: string;
  task_type: ThinkTaskType;
  research_reports: string[];
  language: ThinkLanguage;
}

export interface ThinkApproach {
  id: string;
  summary: string;
  benefits: string[];
  costs: string[];
  risks: string[];
}

export interface ThinkDraft {
  outcome: string;
  root_cause: string | null;
  decision: string;
  rationale: string;
  alternatives: Array<{ summary: string; rejected_because: string }>;
  evidence: ThinkEvidence[];
  plan: ThinkPlan | null;
  research_questions: string[];
}

export interface ThinkReviewFinding {
  severity: 'blocking' | 'nonblocking';
  statement: string;
  evidence: ThinkEvidence[];
  implication: string;
  required_action: string;
  disposition?: 'block_issue' | 'advisory';
}

export interface ThinkEvidence {
  kind: 'repository' | 'research';
  source: string;
  locator: string;
  supports: string;
}

export interface ThinkDecision {
  readiness: ThinkReadiness;
  outcome: string;
  root_cause: string | null;
  decision: string;
  rationale: string;
  alternatives: Array<{ summary: string; rejected_because: string }>;
  evidence: ThinkEvidence[];
  plan: ThinkPlan | null;
  research_questions: string[];
  review_findings: ThinkReviewFinding[];
  /** @deprecated retained only for report-reader compatibility; new reviewers cannot emit it. */
  review_notes: string[];
}

export interface ThinkReportEvidence extends ThinkEvidence {
  id: string;
  source_sha256: string;
}

export interface ThinkReport extends Omit<ThinkDecision, 'evidence'> {
  protocol: typeof THINK_REPORT_PROTOCOL;
  generated_at: string;
  request: string;
  task_type: ThinkTaskType;
  language: ThinkLanguage;
  repository: { head: string | null; dirty: boolean };
  evidence: ThinkReportEvidence[];
  research_reports: string[];
  next_step: 'issue' | 'research';
  timings: StageTimings;
}

export const THINK_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string' },
    root_cause: { type: ['string', 'null'] },
    decision: { type: 'string' },
    rationale: { type: 'string' },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: { summary: { type: 'string' }, rejected_because: { type: 'string' } },
        required: ['summary', 'rejected_because'],
        additionalProperties: false,
      },
    },
    evidence: { type: 'array' },
    plan: { anyOf: [BUILD_PLAN_AUTHORING_SCHEMA, { type: 'null' }] },
    research_questions: STRING_ARRAY_SCHEMA,
  },
  required: [
    'outcome',
    'root_cause',
    'decision',
    'rationale',
    'alternatives',
    'evidence',
    'plan',
    'research_questions',
  ],
  additionalProperties: false,
} as const;

export const THINK_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocking', 'nonblocking'] },
          statement: { type: 'string' },
          evidence: { type: 'array' },
          implication: { type: 'string' },
          required_action: { type: 'string' },
        },
        required: ['severity', 'statement', 'evidence', 'implication', 'required_action'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

function requiredString(value: unknown, label: string, code = 'usage_error'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FlowError(`${label} must be a non-empty string`, code);
  }
  return value.trim();
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label, 'execution_error');
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new FlowError(`${label} must be ${values.join(', ')}`, 'execution_error');
  }
  return value as T;
}

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    throw new FlowError(`${label} must be an array of objects`, 'execution_error');
  }
  return value;
}

function parseApproach(raw: JsonObject, label: string): ThinkApproach {
  rejectUnknownKeys(raw, ['id', 'summary', 'benefits', 'costs', 'risks'], label, 'execution_error');
  return {
    id: requiredString(raw.id, `${label}.id`, 'execution_error'),
    summary: requiredString(raw.summary, `${label}.summary`, 'execution_error'),
    benefits: stringArray(raw.benefits, `${label}.benefits`, 'execution_error'),
    costs: stringArray(raw.costs, `${label}.costs`, 'execution_error'),
    risks: stringArray(raw.risks, `${label}.risks`, 'execution_error'),
  };
}
void parseApproach;

/** Validates the caller-authored decision boundary before any agent starts. */
export function validateThinkInput(raw: unknown): ThinkInput {
  if (!isObject(raw) || raw.protocol !== THINK_INPUT_PROTOCOL) {
    throw new FlowError(`think input.protocol must be ${THINK_INPUT_PROTOCOL}`);
  }
  rejectUnknownKeys(
    raw,
    ['protocol', 'repo', 'request', 'task_type', 'research_reports', 'language'],
    'think input',
  );
  if (typeof raw.repo !== 'string' || !path.isAbsolute(raw.repo)) {
    throw new FlowError('think input.repo must be absolute');
  }
  const repo = gitRoot(raw.repo, 'think input.repo must be a Git worktree');
  if (fs.realpathSync(raw.repo) !== repo)
    throw new FlowError('think input.repo must equal the Git root');
  const reports = stringArray(raw.research_reports, 'think input.research_reports');
  if (reports.some((file) => !path.isAbsolute(file))) {
    throw new FlowError('think input.research_reports must contain absolute paths');
  }
  return {
    protocol: THINK_INPUT_PROTOCOL,
    repo,
    request: requiredString(raw.request, 'think input.request'),
    task_type: enumValue(
      raw.task_type,
      ['bug', 'feature', 'docs', 'chore'] as const,
      'think input.task_type',
    ),
    research_reports: [...new Set(reports)],
    language: enumValue(raw.language, ['english', 'japanese'] as const, 'think input.language'),
  };
}

/** Parses the designer output and proves that its recommendation names a compared approach. */
export function parseThinkDraft(raw: unknown): ThinkDraft {
  if (!isObject(raw))
    throw new FlowError('think designer returned an invalid object', 'execution_error');
  rejectUnknownKeys(
    raw,
    [
      'outcome',
      'root_cause',
      'decision',
      'rationale',
      'alternatives',
      'evidence',
      'plan',
      'research_questions',
    ],
    'think draft',
    'execution_error',
  );
  return {
    outcome: requiredString(raw.outcome, 'think draft.outcome', 'execution_error'),
    root_cause: nullableString(raw.root_cause, 'think draft.root_cause'),
    decision: requiredString(raw.decision, 'think draft.decision', 'execution_error'),
    rationale: requiredString(raw.rationale, 'think draft.rationale', 'execution_error'),
    alternatives: objectArray(raw.alternatives, 'think draft.alternatives').map((x) => ({
      summary: requiredString(x.summary, 'summary', 'execution_error'),
      rejected_because: requiredString(x.rejected_because, 'rejected_because', 'execution_error'),
    })),
    evidence: parseEvidence(raw.evidence, 'think draft.evidence'),
    plan: raw.plan === null ? null : parseBuildPlanAuthoring(raw.plan),
    research_questions: stringArray(
      raw.research_questions,
      'think draft.research_questions',
      'execution_error',
    ),
  };
}

function parseEvidence(value: unknown, label: string): ThinkEvidence[] {
  return objectArray(value, label).map((item, index) => {
    const p = `${label}[${index}]`;
    rejectUnknownKeys(item, ['kind', 'source', 'locator', 'supports'], p, 'execution_error');
    return {
      kind: enumValue(item.kind, ['repository', 'research'] as const, `${p}.kind`),
      source: requiredString(item.source, `${p}.source`, 'execution_error'),
      locator: requiredString(item.locator, `${p}.locator`, 'execution_error'),
      supports: requiredString(item.supports, `${p}.supports`, 'execution_error'),
    };
  });
}

export function parseThinkReview(raw: unknown): ThinkReviewFinding[] {
  if (!isObject(raw))
    throw new FlowError('think reviewer returned an invalid object', 'execution_error');
  rejectUnknownKeys(raw, ['findings'], 'think review', 'execution_error');
  return objectArray(raw.findings, 'think review.findings').map((item, index) => {
    const p = `think review.findings[${index}]`;
    rejectUnknownKeys(
      item,
      ['severity', 'statement', 'evidence', 'implication', 'required_action', 'disposition'],
      p,
      'execution_error',
    );
    return {
      severity: enumValue(item.severity, ['blocking', 'nonblocking'] as const, `${p}.severity`),
      statement: requiredString(item.statement, `${p}.statement`, 'execution_error'),
      evidence: parseEvidence(item.evidence, `${p}.evidence`),
      implication: requiredString(item.implication, `${p}.implication`, 'execution_error'),
      required_action: requiredString(
        item.required_action,
        `${p}.required_action`,
        'execution_error',
      ),
      ...(item.disposition
        ? {
            disposition: enumValue(
              item.disposition,
              ['block_issue', 'advisory'] as const,
              `${p}.disposition`,
            ),
          }
        : {}),
    };
  });
}

/** Parses the independent review into the only decision shape allowed to become an artifact. */
export function parseThinkDecision(raw: unknown): ThinkDecision {
  if (!isObject(raw))
    throw new FlowError('think reviewer returned an invalid object', 'execution_error');
  rejectUnknownKeys(
    raw,
    [
      'readiness',
      'outcome',
      'root_cause',
      'decision',
      'rationale',
      'alternatives',
      'evidence',
      'plan',
      'research_questions',
      'review_notes',
      'review_findings',
    ],
    'think decision',
    'execution_error',
  );
  const alternatives = objectArray(raw.alternatives, 'think decision.alternatives').map(
    (item, index) => {
      const label = `think decision.alternatives[${index}]`;
      rejectUnknownKeys(item, ['summary', 'rejected_because'], label, 'execution_error');
      return {
        summary: requiredString(item.summary, `${label}.summary`, 'execution_error'),
        rejected_because: requiredString(
          item.rejected_because,
          `${label}.rejected_because`,
          'execution_error',
        ),
      };
    },
  );
  const evidence = objectArray(raw.evidence, 'think decision.evidence').map((item, index) => {
    const label = `think decision.evidence[${index}]`;
    rejectUnknownKeys(item, ['kind', 'source', 'locator', 'supports'], label, 'execution_error');
    return {
      kind: enumValue(item.kind, ['repository', 'research'] as const, `${label}.kind`),
      source: requiredString(item.source, `${label}.source`, 'execution_error'),
      locator: requiredString(item.locator, `${label}.locator`, 'execution_error'),
      supports: requiredString(item.supports, `${label}.supports`, 'execution_error'),
    };
  });
  return {
    readiness: enumValue(
      raw.readiness,
      ['ready', 'research_required'] as const,
      'think decision.readiness',
    ),
    outcome: requiredString(raw.outcome, 'think decision.outcome', 'execution_error'),
    root_cause: nullableString(raw.root_cause, 'think decision.root_cause'),
    decision: requiredString(raw.decision, 'think decision.decision', 'execution_error'),
    rationale: requiredString(raw.rationale, 'think decision.rationale', 'execution_error'),
    alternatives,
    evidence,
    plan: raw.plan === null ? null : parseBuildPlanAuthoring(raw.plan),
    research_questions: stringArray(
      raw.research_questions,
      'think decision.research_questions',
      'execution_error',
    ),
    review_notes: stringArray(raw.review_notes, 'think decision.review_notes', 'execution_error'),
    review_findings: raw.review_findings ? parseThinkReview({ findings: raw.review_findings }) : [],
  };
}

/** Revalidates a persisted report before another workflow consumes its Plan. */
export function parseThinkReport(raw: unknown): ThinkReport {
  if (!isObject(raw) || raw.protocol !== THINK_REPORT_PROTOCOL) {
    throw new FlowError(`think report.protocol must be ${THINK_REPORT_PROTOCOL}`);
  }
  rejectUnknownKeys(
    raw,
    [
      'protocol',
      'generated_at',
      'request',
      'task_type',
      'language',
      'repository',
      'readiness',
      'outcome',
      'root_cause',
      'decision',
      'rationale',
      'alternatives',
      'evidence',
      'plan',
      'research_questions',
      'review_notes',
      'review_findings',
      'research_reports',
      'next_step',
      'timings',
    ],
    'think report',
  );
  const generatedAt = requiredString(raw.generated_at, 'think report.generated_at');
  const timingsValue = raw.timings;
  const timings = parseStageTimings(timingsValue, 'think report.timings');
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTime) || new Date(generatedTime).toISOString() !== generatedAt) {
    throw new FlowError('think report.generated_at must be an ISO timestamp');
  }
  if (!isObject(raw.repository)) {
    throw new FlowError('think report.repository must be an object');
  }
  rejectUnknownKeys(raw.repository, ['head', 'dirty'], 'think report.repository');
  if (typeof raw.repository.dirty !== 'boolean') {
    throw new FlowError('think report.repository.dirty must be boolean');
  }
  const reportEvidence = objectArray(raw.evidence, 'think report.evidence').map((item, index) => {
    const label = `think report.evidence[${index}]`;
    rejectUnknownKeys(
      item,
      ['id', 'kind', 'source', 'locator', 'supports', 'source_sha256'],
      label,
    );
    const id = requiredString(item.id, `${label}.id`);
    if (id !== `E-${String(index + 1).padStart(3, '0')}`) {
      throw new FlowError(`${label}.id is not sequential`);
    }
    const sourceSha256 = requiredString(item.source_sha256, `${label}.source_sha256`);
    if (!/^[a-f0-9]{64}$/u.test(sourceSha256)) {
      throw new FlowError(`${label}.source_sha256 must be a SHA-256 digest`);
    }
    return {
      id,
      kind: enumValue(item.kind, ['repository', 'research'] as const, `${label}.kind`),
      source: requiredString(item.source, `${label}.source`),
      locator: requiredString(item.locator, `${label}.locator`),
      supports: requiredString(item.supports, `${label}.supports`),
      source_sha256: sourceSha256,
    };
  });
  const decision = parseThinkDecision({
    readiness: raw.readiness,
    outcome: raw.outcome,
    root_cause: raw.root_cause,
    decision: raw.decision,
    rationale: raw.rationale,
    alternatives: raw.alternatives,
    evidence: reportEvidence.map(({ id: _id, source_sha256: _digest, ...evidence }) => evidence),
    plan: raw.plan,
    research_questions: raw.research_questions,
    review_notes: raw.review_notes,
    review_findings: raw.review_findings ?? [],
  });
  const nextStep = enumValue(
    raw.next_step,
    ['issue', 'research'] as const,
    'think report.next_step',
  );
  if (
    (decision.readiness === 'ready' && (decision.plan === null || nextStep !== 'issue')) ||
    (decision.readiness === 'research_required' && nextStep !== 'research')
  ) {
    throw new FlowError('think report readiness, plan, and next_step are inconsistent');
  }
  return {
    protocol: THINK_REPORT_PROTOCOL,
    generated_at: generatedAt,
    request: requiredString(raw.request, 'think report.request'),
    task_type: enumValue(
      raw.task_type,
      ['bug', 'feature', 'docs', 'chore'] as const,
      'think report.task_type',
    ),
    language: enumValue(raw.language, ['english', 'japanese'] as const, 'think report.language'),
    repository: {
      head:
        raw.repository.head === null
          ? null
          : requiredString(raw.repository.head, 'think report.repository.head'),
      dirty: raw.repository.dirty,
    },
    ...decision,
    evidence: reportEvidence,
    research_reports: stringArray(raw.research_reports, 'think report.research_reports'),
    next_step: nextStep,
    timings,
  };
}
