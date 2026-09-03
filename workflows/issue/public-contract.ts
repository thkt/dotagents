/** @file Outcome: One GitHub Issue contains one human-readable, machine-parseable Plan. */

import {
  compileBuildPlan,
  parseBuildPlanAuthoring,
  type CompiledBuildPlan,
} from '../plan/contracts.ts';
import { FlowError, errorMessage } from '../shared/errors.ts';

const PUBLICATION_OPEN = '<!-- codex-issue-publication\n';
const COMMENT_CLOSE = '\n-->';
const PLAN_OPEN = '## Plan\n\n```json\n';
const PLAN_CLOSE = '\n```';
const PUBLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new FlowError(`${label} is required`);
  return value;
}

export function digest(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new FlowError(`${label} must be a SHA-256 digest`);
  return result;
}

export function repositoryName(value: unknown, label: string): string {
  const repository = requiredString(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new FlowError(`${label} must be owner/name`);
  }
  return repository;
}

export function positiveIssue(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new FlowError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function optionalPublication(body: string): { id: string; start: number; end: number } | null {
  const starts = [...body.matchAll(/<!-- codex-issue-publication\n/gu)].map(
    (match) => match.index!,
  );
  if (starts.length === 0) return null;
  if (starts.length !== 1) throw new FlowError('GitHub Issue has duplicate publication metadata');
  const start = starts[0]!;
  const contentStart = start + PUBLICATION_OPEN.length;
  const close = body.indexOf(COMMENT_CLOSE, contentStart);
  if (close < 0) throw new FlowError('GitHub Issue publication metadata is incomplete');
  const content = body.slice(contentStart, close);
  if (!content.startsWith('publication_id:')) {
    throw new FlowError('GitHub Issue publication metadata is invalid');
  }
  const id = content.slice('publication_id:'.length);
  if (!PUBLICATION_ID.test(id)) {
    throw new FlowError('GitHub Issue publication metadata has an invalid publication id');
  }
  return { id, start, end: close + COMMENT_CLOSE.length };
}

function publication(body: string): { id: string; start: number; end: number } {
  const result = optionalPublication(body);
  if (!result) throw new FlowError('GitHub Issue has no publication metadata');
  return result;
}

/** Renders the Plan once, as readable JSON beneath the public Plan heading. */
export function renderPublicIssueBody(
  prose: string,
  plan: CompiledBuildPlan,
  publicationId: string,
): string {
  if (!PUBLICATION_ID.test(publicationId)) {
    throw new FlowError('issue publication_id must be a UUIDv4', 'decision_error');
  }
  const prefix = prose.trim();
  const metadata = `${PUBLICATION_OPEN}publication_id:${publicationId}${COMMENT_CLOSE}`;
  const json = JSON.stringify(plan.authoring, null, 2);
  return `${prefix ? `${prefix}\n\n` : ''}${metadata}\n\n${PLAN_OPEN}${json}${PLAN_CLOSE}\n`;
}

/** Removes the Codex-owned Plan and metadata while preserving human prose. */
export function stripPublishedPlan(body: string): string {
  const metadata = publication(body);
  const planStart = body.indexOf(PLAN_OPEN, metadata.end);
  if (planStart < 0 || body.slice(planStart).trimEnd().slice(-PLAN_CLOSE.length) !== PLAN_CLOSE) {
    throw new FlowError('target issue has no terminal Codex-owned Plan', 'decision_error');
  }
  if (body.slice(metadata.end, planStart).trim()) {
    throw new FlowError(
      'target issue publication metadata is detached from its Plan',
      'decision_error',
    );
  }
  return body.slice(0, metadata.start).trimEnd();
}

/** Reads the only Plan representation from the selected public Issue. */
export function parsePublicIssueBody(body: string): {
  visibleBody: string;
  publication_id: string | null;
  plan: CompiledBuildPlan;
} {
  const metadata = optionalPublication(body);
  const searchFrom = metadata?.end ?? 0;
  const planStart = body.indexOf(PLAN_OPEN, searchFrom);
  if (planStart < 0 || body.indexOf(PLAN_OPEN, planStart + PLAN_OPEN.length) >= 0) {
    throw new FlowError('GitHub Issue has no unique Plan');
  }
  const suffix = body.slice(planStart + PLAN_OPEN.length).trimEnd();
  if (!suffix.endsWith(PLAN_CLOSE)) throw new FlowError('GitHub Issue Plan must be terminal');
  if (metadata && body.slice(metadata.end, planStart).trim()) {
    throw new FlowError('GitHub Issue publication metadata is detached from its Plan');
  }
  let authoring;
  try {
    authoring = parseBuildPlanAuthoring(JSON.parse(suffix.slice(0, -PLAN_CLOSE.length)) as unknown);
  } catch (error) {
    throw new FlowError(`GitHub Issue Plan is invalid: ${errorMessage(error)}`);
  }
  return {
    visibleBody: body.slice(0, metadata?.start ?? planStart).trimEnd(),
    publication_id: metadata?.id ?? null,
    plan: compileBuildPlan(authoring),
  };
}
