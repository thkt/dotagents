/** @file Outcome: Only the exact independently accepted Issue candidate is published, once or reconciled. */
import fs from 'node:fs';
import path from 'node:path';
import { readAbsoluteJson } from '../runtime/cli.ts';
import { consumeIssueApproval, loadIntent, requireIssueIntent } from '../runtime/invocation.ts';
import { acquireWorkflowOwnership } from '../runtime/ownership.ts';
import { atomicWriteText, issueArtifactDirectory, workflowInputPath } from '../runtime/storage.ts';
import { createRepositorySnapshot } from '../execution/repository-isolation.ts';
import { sealRepository } from '../execution/source-seal.ts';
import { thinkDigest } from '../think/state.ts';
import { FlowError, errorMessage } from '../shared/errors.ts';
import { ProgressReporter, workflowProgress } from '../shared/progress.ts';
import { validateIssueInput } from './contracts.ts';
import {
  CodexIssueAgent,
  parseIssueCandidate,
  parseIssueReview,
  type IssueAgent,
} from './agent.ts';
import {
  assertGitHubRemote,
  GhIssueGateway,
  type IssueGateway,
  type GitHubIssue,
} from './github.ts';
import {
  loadThinkReport,
  draftIssue,
  requireValidPlan,
  publishIssue,
  verifyPublished,
  type IssueDraftResult,
} from './pipeline.ts';
import { renderPublicIssueBody, positiveIssue } from './public-contract.ts';
import {
  issueBinding,
  issueContractDigest,
  issueWorkspace,
  loadIssueState,
  saveIssueState,
  type IssueState,
} from './state.ts';

function context(s: IssueState, inputFile: string): void {
  if (
    thinkDigest(readAbsoluteJson(inputFile, 'issue')) !== s.input_digest ||
    thinkDigest(loadThinkReport(s.input.repo, s.input.think_report)) !== thinkDigest(s.report) ||
    issueContractDigest() !== s.contract_digest
  )
    throw new FlowError(
      'Issue governing input, report or contract changed; retain this run and reconcile any pending publication',
      'state_error',
    );
  assertGitHubRemote(s.input.repo, s.input.remote, s.input.repository);
  if (sealRepository(issueWorkspace(s)).source_digest !== s.source_digest)
    throw new FlowError('Issue snapshot changed', 'state_error');
}
function prepared(s: IssueState): IssueDraftResult {
  const { candidate: c, input } = s;
  if (c.title.includes('\n') || /^##[ \t]+Plan[ \t]*$/imu.test(c.prose))
    throw new FlowError(
      'Issue title must be one line and prose must not contain a Plan section',
      'decision_error',
    );
  requireValidPlan(s.report.plan);
  return {
    draft: {
      repository: input.repository,
      issue_number: input.mode === 'update' ? input.target_issue : null,
      title: c.title,
      existing_issue: s.target,
    },
    body: renderPublicIssueBody(c.prose, s.report.plan, c.plan_markdown ?? undefined),
    body_markdown: path.join(issueArtifactDirectory(input.repo), `issue-${s.invocation}.md`),
  };
}
function correct(s: IssueState, reason: string): void {
  s.correction = reason;
  s.reason = null;
  s.review = null;
  s.attempts = 0;
  if (s.corrections === 3) {
    s.phase = 'blocked';
    s.reason = reason;
  } else {
    s.corrections++;
    s.phase = 'correct';
  }
  saveIssueState(s);
}
function completed(s: IssueState, draft: IssueDraftResult, issue: GitHubIssue): GitHubIssue {
  const target = s.input.mode === 'update' ? s.input.target_issue : s.created_issue;
  verifyPublished({ ...draft.draft, issue_number: target }, draft.body, issue);
  if (issue.url !== `https://github.com/${s.input.repository}/issues/${issue.number}`)
    throw new FlowError(
      'published Issue URL does not match repository and identity',
      'external_error',
    );
  s.published = issue;
  s.phase = 'completed';
  s.reason = null;
  saveIssueState(s);
  return issue;
}
/** The ownership lock covers review, publication and all restart decisions. */
export async function runIssue(
  runId: string,
  inputFile: string,
  gateway?: IssueGateway,
  agent?: IssueAgent,
  progress: ProgressReporter = workflowProgress,
): Promise<{ issue: GitHubIssue; repo: string }> {
  using _ownership = acquireWorkflowOwnership(runId);
  if (path.resolve(inputFile) !== workflowInputPath(runId, 'issue'))
    throw new FlowError('use the Issue input path supplied by the workflow hook', 'state_error');
  let state = loadIssueState(runId);
  const intent = loadIntent(runId);
  if (state && ['completed', 'blocked'].includes(state.phase) && intent?.workflow === 'issue')
    state = null;
  const readGateway = gateway ?? new GhIssueGateway();
  if (!state) {
    const raw = readAbsoluteJson(inputFile, 'issue');
    const input = validateIssueInput(raw);
    requireIssueIntent(runId, input.repo, inputFile);
    const invocation = crypto.randomUUID();
    const draft = draftIssue(input, readGateway, invocation);
    const report = draft.report;
    const snapshot = issueWorkspace({ run_id: runId, invocation });
    createRepositorySnapshot(input.repo, snapshot);
    state = {
      protocol: 'codex-issue-state-v1',
      run_id: runId,
      invocation,
      input,
      input_digest: thinkDigest(raw),
      report,
      contract_digest: issueContractDigest(),
      source_digest: sealRepository(snapshot).source_digest,
      target: draft.draft.existing_issue,
      candidate: {
        title: input.title,
        prose: input.prose,
        plan_markdown: input.plan_markdown ?? null,
      },
      review: null,
      phase: 'validate',
      corrections: 0,
      attempts: 0,
      dispatch: null,
      reason: null,
      correction: null,
      next_step: 'issue',
      created_issue: null,
      published: null,
    };
    saveIssueState(state);
    consumeIssueApproval(runId, input.repo);
  } else {
    if (state.phase === 'completed') return { issue: state.published!, repo: state.input.repo };
    // Finish transfer if the process ended between saving authorization and consuming its intent.
    if (intent && state.phase !== 'blocked') {
      requireIssueIntent(runId, state.input.repo, inputFile);
      consumeIssueApproval(runId, state.input.repo);
    }
  }
  const s = state;
  context(s, inputFile);
  const worker = () => (agent ??= new CodexIssueAgent(undefined, progress));
  while (true) {
    if (s.phase === 'blocked')
      throw new FlowError(
        `Issue blocked: ${s.reason}. Next step: ${s.next_step}; retain this run.`,
        s.next_step === 'think' ? 'think_required' : 'issue_blocked',
      );
    if (s.phase === 'validate') {
      try {
        prepared(s);
      } catch (error) {
        correct(s, errorMessage(error));
        continue;
      }
      s.phase = 'review';
      s.attempts = 0;
      saveIssueState(s);
      continue;
    }
    if (s.phase === 'decide') {
      const blockers = s.review!.value.findings.filter((f) => f.severity === 'blocking');
      if (blockers.some((f) => f.destination === 'think')) {
        s.phase = 'blocked';
        s.next_step = 'think';
        s.reason = JSON.stringify(blockers);
        saveIssueState(s);
        continue;
      }
      if (blockers.length) {
        correct(s, JSON.stringify(blockers));
        continue;
      }
      const p = prepared(s);
      atomicWriteText(p.body_markdown, p.body);
      s.phase = 'publish';
      saveIssueState(s);
      continue;
    }
    if (s.phase === 'publish' || s.phase === 'publishing') {
      const p = prepared(s);
      if (s.phase === 'publishing') {
        const target = s.input.mode === 'update' ? s.input.target_issue : s.created_issue;
        if (target === null)
          throw new FlowError(
            `Issue create outcome is unknown. Retain ${s.invocation}, reconcile GitHub manually before any new publication; never retry create. ${s.reason ?? ''}`,
            'publication_unknown',
          );
        const pending = thinkDigest(s);
        const issue = readGateway.view(s.input.repository, target);
        if (thinkDigest(loadIssueState(runId)) !== pending)
          throw new FlowError('stale Issue reconciliation result', 'state_error');
        context(s, inputFile);
        return { issue: completed(s, p, issue), repo: s.input.repo };
      }
      if (fs.readFileSync(p.body_markdown, 'utf8') !== p.body)
        throw new FlowError('Issue preview changed after review', 'state_error');
      s.phase = 'publishing';
      saveIssueState(s);
      let pending = thinkDigest(s);
      const requirePending = () => {
        if (thinkDigest(loadIssueState(runId)) !== pending)
          throw new FlowError('stale Issue publication result', 'state_error');
      };
      try {
        const result = progress.runSync({ workflow: 'issue', stage: 'issue_publish' }, () =>
          publishIssue(
            p,
            gateway ?? new GhIssueGateway('issue-publication'),
            (number) => {
              requirePending();
              s.created_issue = positiveIssue(number, 'created Issue');
              saveIssueState(s);
              pending = thinkDigest(s);
            },
            () => {
              requirePending();
              context(s, inputFile);
            },
          ),
        );
        requirePending();
        if (s.input.mode === 'create') {
          if (s.created_issue !== null && s.created_issue !== result.issue.number)
            throw new FlowError('created Issue identity changed', 'state_error');
          if (s.created_issue === null) {
            s.created_issue = result.issue.number;
            saveIssueState(s);
            pending = thinkDigest(s);
          }
        }
        context(s, inputFile);
        return { issue: completed(s, p, result.issue), repo: s.input.repo };
      } catch (error) {
        if (thinkDigest(loadIssueState(runId)) !== pending) throw error;
        s.reason = errorMessage(error);
        saveIssueState(s);
        throw error;
      }
    }
    if (s.attempts === 2) {
      s.phase = 'blocked';
      s.reason ??= 'Both permitted model attempts ended without acceptance';
      saveIssueState(s);
      continue;
    }
    s.attempts++;
    s.dispatch = crypto.randomUUID();
    saveIssueState(s);
    const pending = thinkDigest(s);
    let result: unknown;
    try {
      result =
        s.phase === 'correct'
          ? await worker().correct(
              structuredClone(s.report),
              structuredClone(s.candidate),
              s.correction!,
              issueWorkspace(s),
            )
          : await worker().review(
              structuredClone(s.report),
              structuredClone(s.candidate),
              prepared(s).body,
              issueWorkspace(s),
            );
      if (thinkDigest(loadIssueState(runId)) !== pending)
        throw new FlowError('stale Issue model result', 'state_error');
      context(s, inputFile);
    } catch (error) {
      if (thinkDigest(loadIssueState(runId)) !== pending) throw error;
      s.reason = errorMessage(error);
      saveIssueState(s);
      // Context changes are not retryable model failures.
      context(s, inputFile);
      continue;
    }
    try {
      if (s.phase === 'correct') {
        s.candidate = parseIssueCandidate(result);
        s.phase = 'validate';
        s.review = null;
      } else {
        s.review = { value: parseIssueReview(result), binding: issueBinding(s) };
        s.phase = 'decide';
      }
    } catch (error) {
      s.reason = errorMessage(error);
      saveIssueState(s);
      continue;
    }
    s.attempts = 0;
    s.reason = null;
    s.dispatch = null;
    saveIssueState(s);
  }
}
