/** @file Outcome: One GitHub Issue contains one human-readable, machine-parseable Plan. */

import {
  compileBuildPlan,
  parseBuildPlanAuthoring,
  type CompiledBuildPlan,
} from '../plan/contracts.ts';
import { FlowError, errorMessage } from '../shared/errors.ts';

const PLAN_OPEN = '## Plan\n\n<details>\n<summary>Build Plan</summary>\n\n```json\n';
const PLAN_CLOSE = '\n```\n\n</details>';

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

/** Renders the Plan once, as readable JSON beneath the public Plan heading. */
export function renderPublicIssueBody(prose: string, plan: CompiledBuildPlan): string {
  const prefix = prose.trim();
  const json = JSON.stringify(plan.authoring, null, 2);
  return `${prefix ? `${prefix}\n\n` : ''}${PLAN_OPEN}${json}${PLAN_CLOSE}\n`;
}

/** Reads the only Plan representation from the selected public Issue. */
export function parsePublicIssueBody(body: string): {
  prose: string;
  plan: CompiledBuildPlan;
} {
  const planStart = body.indexOf(PLAN_OPEN);
  if (planStart < 0 || body.indexOf(PLAN_OPEN, planStart + PLAN_OPEN.length) >= 0) {
    throw new FlowError('GitHub Issue has no unique Plan');
  }
  const suffix = body.slice(planStart + PLAN_OPEN.length).trimEnd();
  if (!suffix.endsWith(PLAN_CLOSE)) throw new FlowError('GitHub Issue Plan must be terminal');
  let authoring;
  try {
    authoring = parseBuildPlanAuthoring(JSON.parse(suffix.slice(0, -PLAN_CLOSE.length)) as unknown);
  } catch (error) {
    throw new FlowError(`GitHub Issue Plan is invalid: ${errorMessage(error)}`);
  }
  return {
    prose: body.slice(0, planStart).trimEnd(),
    plan: compileBuildPlan(authoring),
  };
}
