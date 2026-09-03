/** @file Outcome: Research-backed prose and a ready Think Plan become one verified GitHub Issue. */

import * as fs from 'node:fs';
import { compileBuildPlan, type CompiledBuildPlan } from '../plan/contracts.ts';
import { renderPublicIssueBody } from './public-contract.ts';
import { validatePlan } from '../plan/validation.ts';
import { sha256 } from '../shared/evidence.ts';
import { FlowError } from '../shared/errors.ts';
import { realpathInside } from '../shared/repository.ts';
import { thinkArtifactDirectory } from '../shared/storage.ts';
import { parseThinkReport, type ThinkPlan, type ThinkReport } from '../think/contracts.ts';
import { persistIssuePreview } from './artifact.ts';
import type { IssueDraft, IssueInput } from './contracts.ts';
import {
  assertGitHubRemote,
  GhIssueGateway,
  type GitHubIssue,
  type IssueGateway,
} from './github.ts';

export interface IssueDraftResult {
  draft: IssueDraft;
  body_markdown: string;
  body: string;
}

export interface IssuePublishResult {
  issue: GitHubIssue;
}

type ReadyThinkReport = ThinkReport & {
  status: 'ready';
  plan: ThinkPlan;
};

function regularArtifact(file: string, directory: string, label: string): Buffer {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || !realpathInside(directory, file)) {
    throw new FlowError(`${label} must be a private JSON artifact for this repository`);
  }
  return fs.readFileSync(file);
}

function parseJson(content: Buffer, label: string): unknown {
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new FlowError(`${label} must contain valid JSON`);
  }
}

function isReady(report: ThinkReport): report is ReadyThinkReport {
  return report.status === 'ready' && report.plan !== null;
}

function loadThinkReport(repo: string, file: string): ReadyThinkReport {
  const content = regularArtifact(file, thinkArtifactDirectory(repo), 'issue input.think_report');
  const report = parseThinkReport(parseJson(content, 'issue input.think_report'));
  if (!isReady(report)) {
    throw new FlowError('issue input.think_report must be issue-ready');
  }
  return report;
}

function requireValidPlan(issue: number, title: string, plan: CompiledBuildPlan): void {
  const validation = validatePlan({ issue, title, plan: plan.value });
  if (validation.verdict !== 'pass') {
    throw new FlowError(
      `issue Plan violates the build contract: ${[
        ...validation.blockers,
        ...validation.reason_codes,
      ].join('; ')}`,
      'decision_error',
    );
  }
}

/** Builds and validates the draft used by the same invocation's single GitHub write. */
export function draftIssue(
  input: IssueInput,
  gateway: IssueGateway = new GhIssueGateway(),
): IssueDraftResult {
  const report = loadThinkReport(input.repo, input.think_report);
  assertGitHubRemote(input.repo, input.remote, input.repository);
  const issueNumber = input.mode === 'update' ? input.target_issue : null;
  const existing =
    input.mode === 'update' ? gateway.view(input.repository, input.target_issue) : null;
  const plan = compileBuildPlan(report.plan);
  const body = renderPublicIssueBody(input.prose, plan);
  requireValidPlan(issueNumber ?? 1, input.title, plan);
  if (input.mode === 'create') gateway.checkAccess(input.repository);
  const draft: IssueDraft = {
    repository: input.repository,
    issue_number: issueNumber,
    title: input.title,
    existing_issue: existing ? { title: existing.title, body_sha256: sha256(existing.body) } : null,
  };
  const bodyMarkdown = persistIssuePreview(input.repo, input.title, new Date(), body);
  return {
    draft,
    body_markdown: bodyMarkdown,
    body,
  };
}

function verifyPublished(draft: IssueDraft, body: string, issue: GitHubIssue): void {
  if (
    issue.title !== draft.title ||
    issue.body !== body ||
    (draft.issue_number !== null && issue.number !== draft.issue_number)
  ) {
    throw new FlowError('published issue does not match the validated draft', 'external_error');
  }
}

/** Publishes one validated draft and verifies the resulting GitHub state. */
export function publishIssue(
  prepared: IssueDraftResult,
  gateway: IssueGateway,
): IssuePublishResult {
  const { draft, body } = prepared;
  let issue: GitHubIssue;
  if (draft.issue_number === null) {
    issue = gateway.create(draft.repository, draft.title, prepared.body_markdown);
  } else {
    if (!draft.existing_issue) throw new FlowError('update draft has no target snapshot');
    const current = gateway.view(draft.repository, draft.issue_number);
    if (current.title === draft.title && current.body === body) {
      issue = current;
    } else {
      if (
        current.title !== draft.existing_issue.title ||
        sha256(current.body) !== draft.existing_issue.body_sha256
      ) {
        throw new FlowError('target issue changed after draft validation', 'state_error');
      }
      try {
        issue = gateway.edit(
          draft.repository,
          draft.issue_number,
          draft.title,
          prepared.body_markdown,
        );
      } catch (error) {
        const recovered = gateway.view(draft.repository, draft.issue_number);
        if (recovered.title !== draft.title || recovered.body !== body) {
          throw error;
        }
        issue = recovered;
      }
    }
  }
  verifyPublished(draft, body, issue);
  return { issue };
}
