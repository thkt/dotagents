/** @file Outcome: Think accepts a small semantic request and emits only an Issue-ready Plan or research questions. */

import path from 'node:path';

import {
  BUILD_PLAN_AUTHORING_SCHEMA,
  parseBuildPlanAuthoring,
  type BuildPlanAuthoring,
} from '../plan/contracts.ts';
import { FlowError } from '../shared/errors.ts';
import { gitRoot } from '../shared/repository.ts';
import { isObject, rejectUnknownKeys, requiredString, stringArray } from '../shared/schema.ts';
import { researchArtifactDirectory } from '../runtime/storage.ts';
import { NON_BLANK_STRING_SCHEMA } from '../shared/structured-output.ts';

export type ThinkPlan = BuildPlanAuthoring;

export const THINK_REPORT_PROTOCOL = 'codex-think-report' as const;
export const THINK_RESULT_PROTOCOL = 'codex-think-result' as const;
export const THINK_DESCRIPTION_PROTOCOL = 'codex-think-description' as const;

export type ThinkStatus = 'ready' | 'research_required';

export function thinkNextStep(status: ThinkStatus): 'issue' | 'research' {
  return status === 'ready' ? 'issue' : 'research';
}

export interface ThinkInput {
  repo: string;
  request: string;
  research_reports: string[];
}

export type ThinkRequest = ThinkInput;

export interface ThinkDecision {
  status: ThinkStatus;
  plan: ThinkPlan | null;
  research_questions: string[];
}

export type ThinkDraft = ThinkDecision;

export interface ThinkReport extends ThinkDecision {
  protocol: typeof THINK_REPORT_PROTOCOL;
  generated_at: string;
  request: string;
  research_reports: string[];
}

export const THINK_PLAN_SCHEMA = BUILD_PLAN_AUTHORING_SCHEMA;

const THINK_DECISION_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready', 'research_required'] },
    plan: { anyOf: [THINK_PLAN_SCHEMA, { type: 'null' }] },
    research_questions: { type: 'array', items: NON_BLANK_STRING_SCHEMA },
  },
  required: ['status', 'plan', 'research_questions'],
  additionalProperties: false,
} as const;

export const THINK_DRAFT_SCHEMA = THINK_DECISION_SCHEMA;
export const THINK_REVIEW_SCHEMA = THINK_DECISION_SCHEMA;

/** Validates only the semantic inputs needed to perform Think. */
export function validateThinkInput(raw: unknown): ThinkRequest {
  if (!isObject(raw)) throw new FlowError('think input must be an object');
  const repo = gitRoot(
    requiredString(raw.repo, 'think input.repo'),
    'think input.repo must be a Git worktree',
  );
  const reports = stringArray(raw.research_reports ?? [], 'think input.research_reports').map(
    (file) =>
      path.resolve(path.isAbsolute(file) ? file : path.join(researchArtifactDirectory(repo), file)),
  );
  return {
    repo,
    request: requiredString(raw.request, 'think input.request'),
    research_reports: [...new Set(reports)],
  };
}

/** Parses either model phase into the one semantic Think result. */
export function parseThinkDecision(raw: unknown): ThinkDecision {
  if (!isObject(raw)) throw new FlowError('think returned an invalid object', 'execution_error');
  rejectUnknownKeys(
    raw,
    ['status', 'plan', 'research_questions'],
    'think decision',
    'execution_error',
  );
  if (raw.status !== 'ready' && raw.status !== 'research_required') {
    throw new FlowError(
      'think decision.status must be ready or research_required',
      'execution_error',
    );
  }
  const plan = raw.plan === null ? null : parseBuildPlanAuthoring(raw.plan);
  const researchQuestions = stringArray(
    raw.research_questions,
    'think decision.research_questions',
    'execution_error',
  );
  if (raw.status === 'ready') {
    if (plan === null) throw new FlowError('ready decision must contain a plan', 'decision_error');
    if (researchQuestions.length) {
      throw new FlowError(
        'ready decision cannot contain unresolved research questions',
        'decision_error',
      );
    }
  } else {
    if (plan !== null) {
      throw new FlowError('research_required decision must not contain a plan', 'decision_error');
    }
    if (!researchQuestions.length) {
      throw new FlowError(
        'research_required decision must contain a research question',
        'decision_error',
      );
    }
  }
  return { status: raw.status, plan, research_questions: researchQuestions };
}

/** Parses the persisted handoff consumed by Issue. */
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
      'status',
      'plan',
      'research_questions',
      'research_reports',
    ],
    'think report',
  );
  const generatedAt = requiredString(raw.generated_at, 'think report.generated_at');
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTime) || new Date(generatedTime).toISOString() !== generatedAt) {
    throw new FlowError('think report.generated_at must be an ISO timestamp');
  }
  return {
    protocol: THINK_REPORT_PROTOCOL,
    generated_at: generatedAt,
    request: requiredString(raw.request, 'think report.request'),
    ...parseThinkDecision({
      status: raw.status,
      plan: raw.plan,
      research_questions: raw.research_questions,
    }),
    research_reports: stringArray(raw.research_reports, 'think report.research_reports'),
  };
}
