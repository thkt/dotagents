/** @file Outcome: Think inputs and agent decisions cross runtime boundaries only as closed, typed contracts. */

import * as fs from 'node:fs';
import path from 'node:path';

import { FlowError } from '../shared/errors.ts';
import { CONFIGURED_LANGUAGES, type ConfiguredLanguage } from '../shared/language.ts';
import { gitRoot } from '../shared/repository.ts';
import {
  enumValue as parseEnumValue,
  isObject,
  nullableString,
  objectArray,
  rejectUnknownKeys,
  requiredString,
  stringArray,
  type JsonObject,
} from '../shared/schema.ts';
import {
  BUILD_PLAN_AUTHORING_SCHEMA,
  STRING_ARRAY_SCHEMA,
  parseBuildPlanAuthoring,
  type BuildPlanAuthoring,
} from '../flow/build/authoring.ts';
import { parseStageTimings, type StageTimings } from '../shared/codex.ts';

export type ThinkPlan = BuildPlanAuthoring;

export const THINK_INPUT_PROTOCOL = 'codex-think-input' as const;
export const THINK_REPORT_PROTOCOL = 'codex-think-report' as const;
export const THINK_RESULT_PROTOCOL = 'codex-think-result' as const;
export const THINK_DESCRIPTION_PROTOCOL = 'codex-think-description' as const;

type ThinkTaskType = 'bug' | 'feature' | 'docs' | 'chore';
type ThinkReadiness = 'ready' | 'research_required';

export interface ThinkInput {
  protocol: typeof THINK_INPUT_PROTOCOL;
  repo: string;
  request: string;
  task_type: ThinkTaskType;
  research_reports: string[];
  language: ConfiguredLanguage;
}

interface ThinkApproach {
  id: string;
  summary: string;
  benefits: string[];
  costs: string[];
  risks: string[];
}

export interface ThinkDraft {
  problem: string;
  constraints: string[];
  approaches: ThinkApproach[];
  recommendation: { approach_id: string; rationale: string };
  plan: ThinkPlan | null;
  uncertainties: string[];
}

interface ThinkEvidence {
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
  language: ConfiguredLanguage;
  repository: { head: string | null; dirty: boolean };
  evidence: ThinkReportEvidence[];
  research_reports: string[];
  next_step: 'issue' | 'research';
  timings: StageTimings;
}

export const THINK_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    problem: { type: 'string' },
    constraints: STRING_ARRAY_SCHEMA,
    approaches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          summary: { type: 'string' },
          benefits: STRING_ARRAY_SCHEMA,
          costs: STRING_ARRAY_SCHEMA,
          risks: STRING_ARRAY_SCHEMA,
        },
        required: ['id', 'summary', 'benefits', 'costs', 'risks'],
        additionalProperties: false,
      },
    },
    recommendation: {
      type: 'object',
      properties: { approach_id: { type: 'string' }, rationale: { type: 'string' } },
      required: ['approach_id', 'rationale'],
      additionalProperties: false,
    },
    plan: { anyOf: [BUILD_PLAN_AUTHORING_SCHEMA, { type: 'null' }] },
    uncertainties: STRING_ARRAY_SCHEMA,
  },
  required: ['problem', 'constraints', 'approaches', 'recommendation', 'plan', 'uncertainties'],
  additionalProperties: false,
} as const;

export const THINK_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    readiness: { type: 'string', enum: ['ready', 'research_required'] },
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
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['repository', 'research'] },
          source: { type: 'string' },
          locator: { type: 'string' },
          supports: { type: 'string' },
        },
        required: ['kind', 'source', 'locator', 'supports'],
        additionalProperties: false,
      },
    },
    plan: { anyOf: [BUILD_PLAN_AUTHORING_SCHEMA, { type: 'null' }] },
    research_questions: STRING_ARRAY_SCHEMA,
    review_notes: STRING_ARRAY_SCHEMA,
  },
  required: [
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
  ],
  additionalProperties: false,
} as const;

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  return parseEnumValue(value, values, label, 'execution_error');
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
    language: enumValue(raw.language, CONFIGURED_LANGUAGES, 'think input.language'),
  };
}

/** Parses the designer output and proves that its recommendation names a compared approach. */
export function parseThinkDraft(raw: unknown): ThinkDraft {
  if (!isObject(raw))
    throw new FlowError('think designer returned an invalid object', 'execution_error');
  rejectUnknownKeys(
    raw,
    ['problem', 'constraints', 'approaches', 'recommendation', 'plan', 'uncertainties'],
    'think draft',
    'execution_error',
  );
  const approaches = objectArray(raw.approaches, 'think draft.approaches').map((item, index) =>
    parseApproach(item, `think draft.approaches[${index}]`),
  );
  if (approaches.length < 2)
    throw new FlowError('think draft requires at least two approaches', 'execution_error');
  if (!isObject(raw.recommendation)) {
    throw new FlowError('think draft.recommendation must be an object', 'execution_error');
  }
  rejectUnknownKeys(
    raw.recommendation,
    ['approach_id', 'rationale'],
    'think draft.recommendation',
    'execution_error',
  );
  const recommendation = {
    approach_id: requiredString(
      raw.recommendation.approach_id,
      'think draft.recommendation.approach_id',
      'execution_error',
    ),
    rationale: requiredString(
      raw.recommendation.rationale,
      'think draft.recommendation.rationale',
      'execution_error',
    ),
  };
  if (!approaches.some((approach) => approach.id === recommendation.approach_id)) {
    throw new FlowError('think draft recommendation does not name an approach', 'execution_error');
  }
  return {
    problem: requiredString(raw.problem, 'think draft.problem', 'execution_error'),
    constraints: stringArray(raw.constraints, 'think draft.constraints', 'execution_error'),
    approaches,
    recommendation,
    plan: raw.plan === null ? null : parseBuildPlanAuthoring(raw.plan),
    uncertainties: stringArray(raw.uncertainties, 'think draft.uncertainties', 'execution_error'),
  };
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
    root_cause: nullableString(raw.root_cause, 'think decision.root_cause', 'execution_error'),
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
      'research_reports',
      'next_step',
      'timings',
    ],
    'think report',
  );
  const generatedAt = requiredString(raw.generated_at, 'think report.generated_at');
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
  });
  const nextStep = enumValue(
    raw.next_step,
    ['issue', 'research'] as const,
    'think report.next_step',
  );
  const timings = parseStageTimings(raw.timings, 'think report.timings');
  if (
    (decision.readiness === 'ready' && (decision.plan === null || nextStep !== 'issue')) ||
    (decision.readiness === 'research_required' &&
      (decision.plan !== null || nextStep !== 'research'))
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
    language: enumValue(raw.language, CONFIGURED_LANGUAGES, 'think report.language'),
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
