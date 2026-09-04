/** @file Outcome: One GitHub Issue contains one human-readable, machine-parseable Plan. */

import {
  parseBuildPlanAuthoring,
  renderPlanMarkdown,
  type BuildPlanAuthoring,
} from '../plan/contracts.ts';
import { FlowError, errorMessage } from '../shared/errors.ts';

const PLAN_OPEN = '<details>\n<summary>Build Plan JSON</summary>\n\n```json\n';
const PLAN_CLOSE = '\n```\n\n</details>';
const PLAN_HEADING = /^##[ \t]+Plan[ \t]*$/gimu;
const JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/giu;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new FlowError(`${label} is required`);
  return value;
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

/** Keeps caller-supplied display text inside the runtime-owned Plan section. */
export function validatePlanMarkdown(value: unknown): string {
  const markdown = requiredString(value, 'issue input.plan_markdown').trim();
  if (
    /^ {0,3}#{1,2}(?:[ \t]|$)/mu.test(markdown) ||
    /^ {0,3}(?:=+|-+)[ \t]*$/mu.test(markdown) ||
    /`{3,}|~{3,}/u.test(markdown) ||
    /<\/?(?:details|summary|h1|h2)\b/iu.test(markdown)
  ) {
    throw new FlowError(
      'issue input.plan_markdown must contain only the Plan display body, without H1/H2 headings, code fences, details or summary tags',
    );
  }
  return markdown;
}

/** Renders optional localized display text beside the unchanged canonical JSON Plan. */
export function renderPublicIssueBody(
  prose: string,
  plan: BuildPlanAuthoring,
  planMarkdown?: string,
): string {
  const prefix = prose.trim();
  const json = JSON.stringify(plan, null, 2);
  const display =
    planMarkdown === undefined
      ? renderPlanMarkdown(plan).trimEnd()
      : `## Plan\n\n${validatePlanMarkdown(planMarkdown)}`;
  return `${prefix ? `${prefix}\n\n` : ''}${display}\n\n${PLAN_OPEN}${json}${PLAN_CLOSE}\n`;
}

/** Reads the canonical JSON Plan independently of its human-readable presentation. */
export function parsePublicIssueBody(body: string): {
  prose: string;
  plan: BuildPlanAuthoring;
} {
  const headings = [...body.matchAll(PLAN_HEADING)];
  if (headings.length !== 1) {
    throw new FlowError('GitHub Issue has no unique Plan');
  }
  const heading = headings[0]!;
  const tail = body.slice(heading.index! + heading[0].length);
  const nextHeading = tail.search(/^##[ \t]+/mu);
  const section = (nextHeading < 0 ? tail : tail.slice(0, nextHeading)).trim();
  const fences = [...section.matchAll(JSON_FENCE)];
  if (fences.length !== 1) throw new FlowError('GitHub Issue Plan has no unique JSON block');
  const fence = fences[0]!;
  let authoring;
  try {
    authoring = parseBuildPlanAuthoring(JSON.parse(fence[1]!) as unknown);
  } catch (error) {
    throw new FlowError(`GitHub Issue Plan is invalid: ${errorMessage(error)}`);
  }
  return {
    prose: body.slice(0, heading.index).trimEnd(),
    plan: authoring,
  };
}
