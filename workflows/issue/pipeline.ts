/** @file Outcome: A ready think Plan becomes one validated, stale-safe, and verified GitHub issue. */

import * as fs from 'node:fs';
import path from 'node:path';

import { buildPlanValue, renderPlanMarkdown } from '../flow/build/authoring.ts';
import { parsePublicIssueBody, renderPublicIssueBody } from './public-contract.ts';
import { validatePlan } from '../flow/build/plan.ts';
import { revalidatePlan } from '../flow/build/revalidate.ts';
import { readRepositoryEvidence, sha256 } from '../shared/evidence.ts';
import { FlowError } from '../shared/errors.ts';
import {
  requireLanguageText,
  resolveConfiguredLanguage,
  type ConfiguredLanguage,
} from '../shared/language.ts';
import { sentenceItems } from '../shared/text.ts';
import {
  realpathInside,
  repositoryInvariant,
  sameWorkflowRepositoryInvariant,
  workflowRepositoryInvariant,
  type RepositoryInvariant,
} from '../shared/repository.ts';
import {
  atomicWrite,
  issueArtifactDirectory,
  researchArtifactDirectory,
  thinkArtifactDirectory,
} from '../shared/storage.ts';
import { parseThinkReport, type ThinkPlan, type ThinkReport } from '../think/contracts.ts';
import { persistIssueDraft, receiptPath } from './artifact.ts';
import { PUBLISHED_ISSUE_PROTOCOL } from './receipt.ts';
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

const TYPE_PREFIX = {
  english: { bug: '[Bug]', feature: '[Feature]', docs: '[Docs]', chore: '[Chore]' },
  japanese: { bug: '[バグ]', feature: '[機能]', docs: '[ドキュメント]', chore: '[保守]' },
} as const;
const BODY_LABELS = {
  english: { outcome: 'Outcome', decision: 'Decision', rationale: 'Rationale' },
  japanese: { outcome: '目的', decision: '決定', rationale: '理由' },
} as const;

type ReadyThinkReport = ThinkReport & {
  readiness: 'ready';
  next_step: 'issue';
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
  return report.readiness === 'ready' && report.next_step === 'issue' && report.plan !== null;
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
  for (const [index, evidence] of report.evidence.entries()) {
    const label = `think report.evidence[${index}]`;
    if (evidence.kind === 'repository') {
      const snapshot = readRepositoryEvidence(repo, evidence.source, evidence.locator, label);
      if (snapshot.source_sha256 !== evidence.source_sha256) {
        throw new FlowError(`${label} is stale`, 'evidence_error');
      }
    } else {
      const directory = researchArtifactDirectory(repo);
      const content = regularArtifact(path.resolve(directory, evidence.source), directory, label);
      if (sha256(content) !== evidence.source_sha256) {
        throw new FlowError(`${label} is stale`, 'evidence_error');
      }
    }
  }
  return { content, report };
}

function repositoryFingerprint(invariant: RepositoryInvariant): string {
  return sha256(JSON.stringify(workflowRepositoryInvariant(invariant)));
}

function requireTitleLanguage(title: string, language: ConfiguredLanguage): void {
  requireLanguageText(title, language, 'issue input.title');
}

function createTitle(
  report: ReadyThinkReport,
  title: string,
  language: ConfiguredLanguage,
): string {
  requireTitleLanguage(title, language);
  return `${TYPE_PREFIX[language][report.task_type]} ${title}`;
}

function proseParagraphs(value: string): string[] {
  return sentenceItems(value).flatMap((sentence) => [sentence, '']);
}

function createBody(report: ReadyThinkReport, language: ConfiguredLanguage): string {
  const labels = BODY_LABELS[language];
  return [
    `## ${labels.outcome}`,
    '',
    ...proseParagraphs(report.outcome),
    `## ${labels.decision}`,
    '',
    ...proseParagraphs(report.decision),
    `### ${labels.rationale}`,
    '',
    ...proseParagraphs(report.rationale),
    renderPlanMarkdown(report.plan, language).trimEnd(),
    '',
  ].join('\n');
}

function appendPlan(body: string, report: ReadyThinkReport, language: ConfiguredLanguage): string {
  if (/^##\s+Plan\b/mu.test(body)) {
    throw new FlowError('target issue already has a ## Plan section', 'decision_error');
  }
  return `${body.trimEnd()}${body.trim() ? '\n\n' : ''}${renderPlanMarkdown(report.plan, language)}`;
}

function requireValidPlan(
  issue: number,
  title: string,
  body: string,
  report: ReadyThinkReport,
  repo: string,
): void {
  const plan = buildPlanValue(report.plan);
  const validation = validatePlan({ issue, title, body, plan });
  if (validation.verdict !== 'pass') {
    throw new FlowError(
      `issue Plan violates the build contract: ${[
        ...validation.blockers,
        ...validation.reason_codes,
      ].join('; ')}`,
      'decision_error',
    );
  }
  const revalidation = revalidatePlan(plan, repo);
  if (revalidation.verdict !== 'pass') {
    throw new FlowError(
      `issue Plan references stale repository state: ${revalidation.drift
        .map((item) => item.path)
        .join(', ')}`,
      'evidence_error',
    );
  }
}

/** Builds and seals the exact draft before the same-invocation publication. */
export function draftIssue(
  input: IssueInput,
  gateway: IssueGateway = new GhIssueGateway(),
  languageOverride?: ConfiguredLanguage,
): IssueDraftResult {
  const before = repositoryInvariant(input.repo);
  const source = loadThinkReport(input.repo, input.think_report);
  if (
    before.head !== source.report.repository.head ||
    Object.keys(before.changes).length > 0 !== source.report.repository.dirty
  ) {
    throw new FlowError('repository state no longer matches the think report', 'state_error');
  }
  assertGitHubRemote(input.repo, input.remote, input.repository);
  const existing =
    input.mode === 'attach-plan' ? gateway.view(input.repository, input.target_issue!) : null;
  const language = languageOverride ?? resolveConfiguredLanguage(source.report.language);
  if (source.report.language !== language) {
    throw new FlowError(
      `think report.language must match the configured Codex language: ${language}`,
      'decision_error',
    );
  }
  const title = existing ? existing.title : createTitle(source.report, input.title!, language);
  const visibleBody = existing
    ? appendPlan(existing.body, source.report, language)
    : createBody(source.report, language);
  const body = renderPublicIssueBody(visibleBody, source.report.plan, language);
  requireValidPlan(input.target_issue ?? 1, title, body, source.report, input.repo);
  if (!sameWorkflowRepositoryInvariant(before, repositoryInvariant(input.repo))) {
    throw new FlowError(
      'repository changed while the issue draft was being prepared',
      'state_error',
    );
  }
  const generatedAt = new Date().toISOString();
  const persisted = persistIssueDraft(
    {
      protocol: ISSUE_DRAFT_PROTOCOL,
      generated_at: generatedAt,
      repo: input.repo,
      repository: input.repository,
      remote: input.remote,
      mode: input.mode,
      issue_number: input.target_issue,
      title,
      priority_label: `priority:${input.priority}`,
      body_sha256: sha256(body),
      think_report: input.think_report,
      think_sha256: sha256(source.content),
      plan: source.report.plan,
      repository_fingerprint: repositoryFingerprint(before),
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

function verifySource(draft: IssueDraft): ReadyThinkReport {
  const source = loadThinkReport(draft.repo, draft.think_report);
  if (sha256(source.content) !== draft.think_sha256) {
    throw new FlowError('issue draft think report was changed');
  }
  if (JSON.stringify(source.report.plan) !== JSON.stringify(draft.plan)) {
    throw new FlowError('issue draft no longer matches its think report');
  }
  return source.report;
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
  gateway: IssueGateway = new GhIssueGateway(),
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
  const report = verifySource(draft);
  const publicContract = parsePublicIssueBody(body);
  if (JSON.stringify(publicContract.plan) !== JSON.stringify(draft.plan)) {
    throw new FlowError('issue draft Plan does not match its public build contract');
  }
  if (repositoryFingerprint(repositoryInvariant(draft.repo)) !== draft.repository_fingerprint) {
    throw new FlowError('repository changed after draft validation', 'state_error');
  }
  requireValidPlan(draft.issue_number ?? 1, draft.title, body, report, draft.repo);
  assertGitHubRemote(draft.repo, draft.remote, draft.repository);
  if (draft.existing_issue && draft.issue_number !== null) {
    const current = gateway.view(draft.repository, draft.issue_number);
    if (
      current.title !== draft.existing_issue.title ||
      sha256(current.body) !== draft.existing_issue.body_sha256
    ) {
      throw new FlowError('target issue changed after draft validation', 'state_error');
    }
  }
  gateway.ensureLabel(draft.repository, draft.priority_label);
  const issue =
    draft.issue_number === null
      ? gateway.create(draft.repository, draft.title, draft.body_file, draft.priority_label)
      : gateway.edit(draft.repository, draft.issue_number, draft.body_file, draft.priority_label);
  verifyPublished(draft, body, issue);
  atomicWrite(receipt, {
    protocol: PUBLISHED_ISSUE_PROTOCOL,
    published_at: new Date().toISOString(),
    repo: draft.repo,
    repository: draft.repository,
    remote: draft.remote,
    draft_sha256: sha256(loaded.content),
    issue_number: issue.number,
    url: issue.url,
    title: issue.title,
    body: issue.body,
    body_sha256: sha256(issue.body),
    plan: draft.plan,
  });
  return { issue, receipt_json: receipt };
}
