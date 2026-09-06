/** @file Outcome: Issue review and publication resume from one bound, versioned record. */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, workflowRunDirectory } from '../runtime/storage.ts';
import { thinkDigest } from '../think/state.ts';
import { parseThinkReport, type ThinkReport, type ThinkPlan } from '../think/contracts.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { validateIssueInput, type IssueInput, type IssueDraft } from './contracts.ts';
import {
  parseIssueCandidate,
  parseIssueReview,
  type IssueCandidate,
  type IssueReview,
} from './agent.ts';
import type { GitHubIssue } from './github.ts';
import { renderPublicIssueBody } from './public-contract.ts';

export interface IssueState {
  protocol: 'codex-issue-state-v1';
  run_id: string;
  invocation: string;
  input: IssueInput;
  input_digest: string;
  report: ThinkReport & { status: 'ready'; plan: ThinkPlan };
  contract_digest: string;
  source_digest: string;
  target: IssueDraft['existing_issue'];
  candidate: IssueCandidate;
  review: { value: IssueReview; binding: string } | null;
  phase:
    | 'validate'
    | 'review'
    | 'decide'
    | 'correct'
    | 'publish'
    | 'publishing'
    | 'completed'
    | 'blocked';
  corrections: number;
  attempts: number;
  dispatch: string | null;
  reason: string | null;
  correction: string | null;
  next_step: 'issue' | 'think';
  created_issue: number | null;
  published: GitHubIssue | null;
}
export function issueStatePath(runId: string): string {
  return path.join(workflowRunDirectory(runId), 'issue-state.json');
}
export function issueWorkspace(state: Pick<IssueState, 'run_id' | 'invocation'>): string {
  return path.join(workflowRunDirectory(state.run_id), 'issue', state.invocation, 'snapshot');
}
export function issueContractDigest(): string {
  return thinkDigest(
    [
      './agent.ts',
      './contracts.ts',
      './public-contract.ts',
      './pipeline.ts',
      './lifecycle.ts',
      '../plan/contracts.ts',
      '../plan/validation.ts',
    ].map((p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')),
  );
}
export function issueBinding(s: IssueState): string {
  return thinkDigest({
    invocation: s.invocation,
    input: s.input,
    report: s.report,
    candidate: s.candidate,
    target: s.target,
    source: s.source_digest,
    contract: s.contract_digest,
  });
}
export function saveIssueState(s: IssueState): void {
  atomicWrite(issueStatePath(s.run_id), { state: s, digest: thinkDigest(s) });
}
export function loadIssueState(runId: string): IssueState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(issueStatePath(runId), 'utf8'));
    if (!isObject(raw) || !isObject(raw.state) || raw.digest !== thinkDigest(raw.state))
      throw new Error('invalid state digest');
    const s = raw.state;
    const fields = [
      'protocol',
      'run_id',
      'invocation',
      'input',
      'input_digest',
      'report',
      'contract_digest',
      'source_digest',
      'target',
      'candidate',
      'review',
      'phase',
      'corrections',
      'attempts',
      'dispatch',
      'reason',
      'correction',
      'next_step',
      'created_issue',
      'published',
    ];
    rejectUnknownKeys(s, fields, 'Issue state');
    if (
      fields.some((k) => !Object.hasOwn(s, k)) ||
      s.protocol !== 'codex-issue-state-v1' ||
      s.run_id !== runId ||
      typeof s.invocation !== 'string' ||
      !/^[a-f0-9-]{36}$/u.test(s.invocation)
    )
      throw new Error('incompatible Issue state');
    for (const key of ['input_digest', 'contract_digest', 'source_digest'])
      if (typeof s[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(s[key]))
        throw new Error('invalid binding');
    if (thinkDigest(validateIssueInput(s.input)) !== thinkDigest(s.input))
      throw new Error('governing repository or input changed');
    const report = parseThinkReport(s.report);
    if (report.status !== 'ready' || !report.plan) throw new Error('non-ready governing report');
    parseIssueCandidate(s.candidate);
    if (
      ![
        'validate',
        'review',
        'decide',
        'correct',
        'publish',
        'publishing',
        'completed',
        'blocked',
      ].includes(String(s.phase)) ||
      !Number.isInteger(s.corrections) ||
      Number(s.corrections) < 0 ||
      Number(s.corrections) > 3 ||
      !Number.isInteger(s.attempts) ||
      Number(s.attempts) < 0 ||
      Number(s.attempts) > 2 ||
      !(s.reason === null || typeof s.reason === 'string') ||
      !(s.correction === null || typeof s.correction === 'string') ||
      !(s.dispatch === null || typeof s.dispatch === 'string') ||
      !['issue', 'think'].includes(String(s.next_step))
    )
      throw new Error('invalid lifecycle');
    if (
      s.target !== null &&
      (!isObject(s.target) ||
        typeof s.target.title !== 'string' ||
        typeof s.target.body_sha256 !== 'string')
    )
      throw new Error('invalid update target');
    if (
      s.created_issue !== null &&
      (!Number.isSafeInteger(s.created_issue) || Number(s.created_issue) < 1)
    )
      throw new Error('invalid created Issue identity');
    const typed = s as unknown as IssueState;
    if (typed.input.mode === 'update' && !typed.target) throw new Error('missing update target');
    if (s.review !== null) {
      if (!isObject(s.review) || s.review.binding !== issueBinding(typed))
        throw new Error('stale Issue review');
      parseIssueReview(s.review.value);
    }
    if (['decide', 'publish', 'publishing', 'completed'].includes(typed.phase) && !typed.review)
      throw new Error('missing accepted review');
    if (
      ['publish', 'publishing', 'completed'].includes(typed.phase) &&
      typed.review!.value.findings.some((f) => f.severity === 'blocking')
    )
      throw new Error('publication has blocking findings');
    if (
      s.published !== null &&
      (!isObject(s.published) ||
        !Number.isSafeInteger(s.published.number) ||
        Number(s.published.number) < 1 ||
        typeof s.published.title !== 'string' ||
        typeof s.published.body !== 'string' ||
        typeof s.published.url !== 'string')
    )
      throw new Error('invalid published result');
    if (typed.phase === 'completed') {
      const p = typed.published;
      const target = typed.input.mode === 'update' ? typed.input.target_issue : typed.created_issue;
      if (
        !p ||
        p.number !== target ||
        p.title !== typed.candidate.title ||
        p.body !==
          renderPublicIssueBody(
            typed.candidate.prose,
            typed.report.plan,
            typed.candidate.plan_markdown ?? undefined,
          ) ||
        p.url !== `https://github.com/${typed.input.repository}/issues/${target}`
      )
        throw new Error('publication evidence does not match accepted candidate');
    }
    return typed;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new FlowError(
      `Issue state cannot be resumed: ${errorMessage(error)}. Retain it and reconcile any pending publication before starting a new task.`,
      'state_error',
    );
  }
}
