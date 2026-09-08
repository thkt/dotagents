/** @file Outcome: Research restarts retain one checked candidate, snapshot, budget and publication identity. */

import crypto from 'node:crypto';
import {
  parseClarificationOwner,
  sameValue,
  type ClarificationOwner,
} from '../runtime/clarification.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWrite,
  researchStatePath,
  workflowRunDirectory,
  researchArtifactDirectory,
} from '../runtime/storage.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';
import {
  parseResearchDraft,
  parseSubquestions,
  parseResearchAudit,
  parseResearchReport,
  type ResearchInput,
  type ResearchDraft,
  type ResearchAudit,
  type ResearchReport,
} from './contracts.ts';
import { parsePendingQuestion, parseClarificationAnswer } from '../runtime/clarification.ts';
import type { KnowledgeEntry } from './knowledge.ts';
import type { ClarificationAnswer, PendingQuestion } from '../runtime/clarification.ts';

export interface Investigation {
  question: string;
  attempts: number;
  settled: number;
  proposal: PendingQuestion | null;
  affected: string[];
  result: ResearchDraft | null;
  reason: string | null;
}
export function investigationBatch(input: ResearchInput): Investigation[] {
  return (input.subquestions ?? [input.question]).map((question) => ({
    question,
    attempts: 0,
    settled: 0,
    proposal: null,
    affected: [],
    result: null,
    reason: null,
  }));
}
export interface ResearchState {
  protocol: 'codex-research-state-v5';
  invocation: string;
  run_id: string;
  input: ResearchInput;
  source_digest: string;
  knowledge: KnowledgeEntry[];
  phase:
    | 'investigate'
    | 'validate'
    | 'audit'
    | 'decide'
    | 'publish'
    | 'completed'
    | 'blocked'
    | 'waiting';
  investigations: Investigation[] | null;
  candidate: ResearchDraft | null;
  audit: ResearchAudit | null;
  corrections: number;
  attempts: number;
  dispatch: string | null;
  reason: string | null;
  correction: string | null;
  generated_at: string | null;
  publication: { json: string; markdown: string } | null;
  pending_question: PendingQuestion | null;
  clarification_history: ClarificationAnswer[];
  raw_input: unknown;
  stage_binding: string | null;
  pending_owner: ClarificationOwner | null;
  dispatch_history: string[];
  accepted_questions: unknown[];
}

export function researchDigest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) =>
    isObject(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function researchSnapshotPath(
  runId: string,
  state: Pick<ResearchState, 'invocation'>,
): string {
  return path.join(workflowRunDirectory(runId), 'research', state.invocation, 'snapshot');
}

export function researchPublicationPaths(state: ResearchState): { json: string; markdown: string } {
  if (state.publication) return state.publication;
  const base = path.join(
    researchArtifactDirectory(state.input.repo),
    `research-${state.invocation}`,
  );
  return { json: `${base}.json`, markdown: `${base}.md` };
}

export function saveResearchState(runId: string, state: ResearchState): void {
  atomicWrite(researchStatePath(runId), { state, digest: researchDigest(state) });
}

/** Reject incompatible/corrupt records rather than resetting them or replaying unverified work. */
export function loadResearchState(runId: string): ResearchState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(researchStatePath(runId), 'utf8'));
    if (!isObject(raw) || !isObject(raw.state) || raw.digest !== researchDigest(raw.state))
      throw new Error('state integrity mismatch');
    rejectUnknownKeys(raw, ['state', 'digest'], 'research state');
    const state = raw.state;
    rejectUnknownKeys(
      state,
      [
        'protocol',
        'invocation',
        'run_id',
        'input',
        'source_digest',
        'knowledge',
        'phase',
        'candidate',
        'investigations',
        'audit',
        'corrections',
        'attempts',
        'dispatch',
        'reason',
        'correction',
        'generated_at',
        'publication',
        'pending_question',
        'clarification_history',
        'raw_input',
        'stage_binding',
        'pending_owner',
        'dispatch_history',
        'accepted_questions',
      ],
      'research state',
    );
    if (
      state.protocol !== 'codex-research-state-v5' ||
      state.run_id !== runId ||
      typeof state.invocation !== 'string' ||
      !/^[0-9a-f-]{36}$/u.test(state.invocation) ||
      typeof state.source_digest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(state.source_digest) ||
      !isObject(state.input) ||
      typeof state.input.repo !== 'string' ||
      !path.isAbsolute(state.input.repo) ||
      typeof state.input.question !== 'string' ||
      !state.input.question.trim() ||
      !Array.isArray(state.input.scope_paths) ||
      state.input.scope_paths.some((p) => typeof p !== 'string') ||
      typeof state.input.allow_external_sources !== 'boolean' ||
      !Array.isArray(state.knowledge) ||
      ![
        'investigate',
        'validate',
        'audit',
        'decide',
        'publish',
        'completed',
        'blocked',
        'waiting',
      ].includes(String(state.phase)) ||
      !Number.isInteger(state.corrections) ||
      Number(state.corrections) < 0 ||
      Number(state.corrections) > 3 ||
      !Number.isInteger(state.attempts) ||
      Number(state.attempts) < 0 ||
      Number(state.attempts) > 2 ||
      !(state.correction === null || typeof state.correction === 'string') ||
      !(state.dispatch === null || typeof state.dispatch === 'string') ||
      !(state.reason === null || typeof state.reason === 'string') ||
      !(
        state.generated_at === null ||
        (typeof state.generated_at === 'string' &&
          Number.isFinite(Date.parse(state.generated_at)) &&
          new Date(state.generated_at).toISOString() === state.generated_at)
      )
    )
      throw new Error('unsupported or malformed state');
    if (
      state.publication !== null &&
      (!isObject(state.publication) ||
        typeof state.publication.json !== 'string' ||
        !path.isAbsolute(state.publication.json) ||
        path.basename(state.publication.json) !== `research-${state.invocation}.json` ||
        state.publication.markdown !== state.publication.json.replace(/\.json$/u, '.md'))
    )
      throw new Error('invalid publication identity');
    if (state.input.subquestions !== undefined) parseSubquestions(state.input.subquestions);
    if (state.pending_question !== null) parsePendingQuestion(state.pending_question);

    if (
      !isObject(state.raw_input) ||
      !Array.isArray(state.accepted_questions) ||
      !Array.isArray(state.dispatch_history) ||
      state.pending_owner === undefined
    )
      throw new Error('incompatible active state');
    if (
      !(
        state.stage_binding === null ||
        (typeof state.stage_binding === 'string' && /^[a-f0-9]{64}$/u.test(state.stage_binding))
      )
    )
      throw new Error('incompatible stage ownership');
    if (state.pending_owner !== null) parseClarificationOwner(state.pending_owner);
    if (!Array.isArray(state.clarification_history))
      throw new Error('invalid clarification history');
    state.clarification_history.forEach((answer) => parseClarificationAnswer(answer));
    if (state.investigations !== null) {
      const questions = state.input.subquestions ?? [state.input.question];
      if (
        !Array.isArray(questions) ||
        !Array.isArray(state.investigations) ||
        state.investigations.length !== questions.length
      )
        throw new Error('invalid investigation batch');
      state.investigations.forEach((entry, index) => {
        if (!isObject(entry)) throw new Error('invalid investigation');
        rejectUnknownKeys(
          entry,
          ['question', 'attempts', 'settled', 'proposal', 'affected', 'result', 'reason'],
          'investigation',
        );
        if (
          entry.question !== questions[index] ||
          !Number.isInteger(entry.attempts) ||
          Number(entry.attempts) < 0 ||
          !Number.isInteger(entry.settled) ||
          Number(entry.settled) < 0 ||
          Number(entry.attempts) - Number(entry.settled) > 2 ||
          !(entry.reason === null || typeof entry.reason === 'string')
        )
          throw new Error('invalid investigation attempt');
        if (!Array.isArray(entry.affected) || entry.affected.some((q) => !questions.includes(q)))
          throw new Error('invalid answer dependencies');
        if (entry.proposal !== null) parsePendingQuestion(entry.proposal);
        if (entry.result !== null) parseResearchDraft(entry.result);
      });
    }
    if (state.phase === 'investigate' && !state.investigations)
      throw new Error('missing investigation batch');
    if (
      !['investigate', 'audit', 'decide', 'blocked', 'waiting'].includes(String(state.phase)) &&
      state.investigations !== null
    )
      throw new Error('unexpected investigation batch');
    if (state.candidate !== null) parseResearchDraft(state.candidate);
    if (state.phase === 'waiting') {
      const proposals = (state.investigations as Investigation[] | null)?.filter(
        (part) => part.proposal,
      );
      if (
        !state.pending_question ||
        !state.pending_owner ||
        !state.candidate ||
        !state.audit ||
        proposals?.length !== 1 ||
        researchDigest(proposals[0]!.proposal) !== researchDigest(state.pending_question) ||
        (state.audit as unknown as ResearchAudit).findings.some((f) => f.severity === 'blocking') ||
        state.publication !== null ||
        state.generated_at !== null
      )
        throw new Error('waiting question has no exact independent acceptance');
      const owner = state.pending_owner as unknown as ClarificationOwner;
      if (
        !sameValue(
          owner,
          researchWaitingOwner(
            state as unknown as ResearchState,
            state.stage_binding === null ? String(state.invocation) : owner.root,
            state.stage_binding === null ? runId : owner.task,
          ),
        )
      )
        throw new Error('waiting owner or acceptance changed');
    } else if (state.pending_owner !== null) throw new Error('pending owner is not waiting');

    if (state.audit !== null) parseResearchAudit(state.audit, Boolean(state.pending_question));

    if (
      ['validate', 'audit', 'decide', 'publish', 'completed'].includes(String(state.phase)) &&
      !state.candidate &&
      !state.pending_question
    )
      throw new Error('candidate is missing');
    if (['decide', 'publish', 'completed'].includes(String(state.phase)) && !state.audit)
      throw new Error('independent audit is missing');
    if (['publish', 'completed'].includes(String(state.phase))) {
      const typed = state as unknown as ResearchState;
      if (
        !typed.generated_at ||
        !typed.publication ||
        typed.audit!.findings.some((f) => f.severity === 'blocking')
      )
        throw new Error('publication has no matching accepted candidate');
      parseResearchReport(reportForCandidate(typed));
    }
    return state as unknown as ResearchState;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new FlowError(
      `Research state cannot resume: ${errorMessage(error)}. Retain the record and use its original runtime to recover, or start Research in a new task.`,
      'state_error',
    );
  }
}

export function reportForCandidate(
  state: ResearchState,
  generatedAt: string = state.generated_at!,
): ResearchReport {
  return {
    protocol: 'codex-research-report',
    generated_at: generatedAt,
    question: state.input.question,
    scope_paths: state.input.scope_paths,
    ...state.candidate!,
    findings: state.candidate!.findings.map((finding, index) => ({
      ...finding,
      id: `F-${String(index + 1).padStart(3, '0')}`,
    })),
  };
}

export function researchWaitingOwner(
  state: ResearchState,
  root: string,
  task: string,
): ClarificationOwner {
  return {
    task,
    repo: state.input.repo,
    workflow: 'research',
    root,
    leaf: state.run_id,
    snapshot: state.source_digest,
    candidate: researchDigest({ ...state, pending_owner: null }),
    review: researchDigest(state.audit),
    dispatch: state.dispatch_history.at(-1) ?? state.invocation,
    permissions: researchDigest(state.raw_input),
    selected_context: researchDigest(state.knowledge),
    handoff: state.stage_binding ?? researchDigest({ root, task, invocation: state.invocation }),
  };
}
