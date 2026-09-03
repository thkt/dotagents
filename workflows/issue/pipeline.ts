/** @file Outcome: A ready think Plan becomes one validated, stale-safe, and verified GitHub issue. */

import * as fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { compileBuildPlan, type CompiledBuildPlan } from '../plan/contracts.ts';
import {
  parsePublicIssueBody,
  renderPublicIssueBody,
  stripPublishedPlan,
} from './public-contract.ts';
import { validatePlan } from '../plan/validation.ts';
import { sha256 } from '../shared/evidence.ts';
import { FlowError } from '../shared/errors.ts';
import { realpathInside } from '../shared/repository.ts';
import { atomicWrite, issueArtifactDirectory, thinkArtifactDirectory } from '../shared/storage.ts';
import { parseThinkReport, type ThinkPlan, type ThinkReport } from '../think/contracts.ts';
import { persistIssueDraft, receiptPath } from './artifact.ts';
import {
  ISSUE_DRAFT_PROTOCOL,
  parseIssueDraft,
  type IssueDraft,
  type IssueInput,
} from './contracts.ts';
import {
  assertGitHubRemote,
  GhIssueGateway,
  type GitHubIssue,
  type IssueGateway,
} from './github.ts';

const PUBLISHED_ISSUE_PROTOCOL = 'codex-build-issue';

export interface IssueDraftResult {
  draft: IssueDraft;
  draft_json: string;
  draft_sha256: string;
  body_markdown: string;
}

export interface IssuePublishResult {
  issue: GitHubIssue;
  receipt_json: string;
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

function loadThinkReport(
  repo: string,
  file: string,
): { content: Buffer; report: ReadyThinkReport } {
  const content = regularArtifact(file, thinkArtifactDirectory(repo), 'issue input.think_report');
  const report = parseThinkReport(parseJson(content, 'issue input.think_report'));
  if (!isReady(report)) {
    throw new FlowError('issue input.think_report must be issue-ready');
  }
  return { content, report };
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

/** Builds and seals the exact draft before the same-invocation publication. */
export function draftIssue(
  input: IssueInput,
  gateway: IssueGateway = new GhIssueGateway(),
): IssueDraftResult {
  const source = loadThinkReport(input.repo, input.think_report);
  assertGitHubRemote(input.repo, input.remote, input.repository);
  const issueNumber = input.mode === 'attach-plan' ? input.target_issue : null;
  const existing =
    input.mode === 'attach-plan' ? gateway.view(input.repository, input.target_issue) : null;
  const plan = compileBuildPlan(source.report.plan);
  const title = input.mode === 'attach-plan' ? existing!.title : input.title;
  const prose = existing
    ? existing.body.includes('<!-- codex-issue-publication\n')
      ? stripPublishedPlan(existing.body)
      : existing.body
    : '';
  if (/^##\s+Plan\b/mu.test(prose)) {
    throw new FlowError('target issue already has a human-authored Plan', 'decision_error');
  }
  const publicationId = crypto.randomUUID();
  const body = renderPublicIssueBody(prose, plan, publicationId);
  requireValidPlan(issueNumber ?? 1, title, plan);
  if (input.mode === 'create') gateway.checkAccess(input.repository);
  const generatedAt = new Date().toISOString();
  const persisted = persistIssueDraft(
    {
      protocol: ISSUE_DRAFT_PROTOCOL,
      generated_at: generatedAt,
      repo: input.repo,
      repository: input.repository,
      remote: input.remote,
      issue_number: issueNumber,
      title,
      priority_label: `priority:${input.priority}`,
      publication_id: publicationId,
      body_sha256: sha256(body),
      existing_issue: existing
        ? { title: existing.title, body_sha256: sha256(existing.body) }
        : null,
    },
    body,
  );
  return {
    ...persisted,
    draft_sha256: sha256(fs.readFileSync(persisted.draft_json)),
  };
}

function loadDraft(file: string): { content: Buffer; draft: IssueDraft } {
  const content = fs.readFileSync(file);
  const draft = parseIssueDraft(parseJson(content, 'issue draft'));
  regularArtifact(file, issueArtifactDirectory(draft.repo), 'issue draft');
  return { content, draft };
}

function currentBody(draft: IssueDraft): string {
  const stat = fs.lstatSync(draft.body_file, { throwIfNoEntry: false });
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    !realpathInside(issueArtifactDirectory(draft.repo), draft.body_file)
  ) {
    throw new FlowError('issue draft body is not a private artifact');
  }
  const body = fs.readFileSync(draft.body_file, 'utf8');
  if (sha256(body) !== draft.body_sha256) throw new FlowError('issue draft body was changed');
  return body;
}

function verifyPublished(draft: IssueDraft, body: string, issue: GitHubIssue): void {
  if (
    issue.title !== draft.title ||
    issue.body !== body ||
    !issue.labels.includes(draft.priority_label) ||
    (draft.issue_number !== null && issue.number !== draft.issue_number)
  ) {
    throw new FlowError('published issue does not match the validated draft', 'external_error');
  }
}

/** Publishes one unchanged validated draft and verifies the resulting GitHub state. */
export function publishIssue(
  draftFile: string,
  expectedDraftSha256: string,
  gateway: IssueGateway,
): IssuePublishResult {
  if (!path.isAbsolute(draftFile)) throw new FlowError('--draft must be absolute');
  const receipt = receiptPath(draftFile);
  if (fs.existsSync(receipt)) throw new FlowError('issue draft was already published');
  const loaded = loadDraft(draftFile);
  if (sha256(loaded.content) !== expectedDraftSha256) {
    throw new FlowError('issue draft digest no longer matches the validated draft');
  }
  const { draft } = loaded;
  const body = currentBody(draft);
  const publicContract = parsePublicIssueBody(body);
  if (publicContract.publication_id !== draft.publication_id) {
    throw new FlowError('issue draft publication id does not match its public build contract');
  }
  requireValidPlan(draft.issue_number ?? 1, draft.title, publicContract.plan);
  assertGitHubRemote(draft.repo, draft.remote, draft.repository);
  gateway.ensureLabel(draft.repository, draft.priority_label);
  let issue: GitHubIssue;
  if (draft.issue_number === null) {
    const recovered = gateway.findByPublicationId(draft.repository, draft.publication_id);
    if (recovered) {
      issue = recovered;
    } else {
      try {
        issue = gateway.create(
          draft.repository,
          draft.title,
          draft.body_file,
          draft.priority_label,
        );
      } catch (error) {
        const recoveredAfterError = gateway.findByPublicationId(
          draft.repository,
          draft.publication_id,
        );
        if (!recoveredAfterError) throw error;
        issue = recoveredAfterError;
      }
    }
  } else {
    if (!draft.existing_issue) throw new FlowError('attach-plan draft has no target snapshot');
    const current = gateway.view(draft.repository, draft.issue_number);
    if (
      current.title === draft.title &&
      current.body === body &&
      current.labels.includes(draft.priority_label)
    ) {
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
          draft.body_file,
          draft.priority_label,
        );
      } catch (error) {
        const recovered = gateway.view(draft.repository, draft.issue_number);
        if (
          recovered.title !== draft.title ||
          recovered.body !== body ||
          !recovered.labels.includes(draft.priority_label)
        ) {
          throw error;
        }
        issue = recovered;
      }
    }
  }
  verifyPublished(draft, body, issue);
  atomicWrite(receipt, {
    protocol: PUBLISHED_ISSUE_PROTOCOL,
    published_at: new Date().toISOString(),
    repo: draft.repo,
    repository: draft.repository,
    publication_id: draft.publication_id,
    draft_sha256: sha256(loaded.content),
    issue_number: issue.number,
  });
  return { issue, receipt_json: receipt };
}
