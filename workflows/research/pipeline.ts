/** @file Outcome: Research validates, independently audits, corrects and resumes one immutable snapshot. */

import crypto from 'node:crypto';
import { markStageStarted, requireStageAccess, type StageAccess } from '../runtime/stage-return.ts';
import path from 'node:path';
import { errorCode, errorMessage, FlowError } from '../shared/errors.ts';
import { readRepositoryEvidence } from '../shared/evidence.ts';
import {
  validateResearchInput,
  parseResearchAudit,
  parseResearchReport,
  type ResearchEvidence,
  type ResearchInput,
  type ResearchReport,
} from './contracts.ts';
import { CodexResearchAgent, type ResearchAgent } from './agent.ts';
import { investigateBatch } from './investigation.ts';
import { persistResearchReport } from './artifact.ts';
import { searchKnowledge, updateKnowledge } from './knowledge.ts';
import { createRepositorySnapshot } from '../execution/repository-isolation.ts';
import { sealRepository } from '../execution/source-seal.ts';
import { acquireWorkflowOwnership } from '../runtime/ownership.ts';
import { clearIntent, loadIntent, requireResearchIntent } from '../runtime/invocation.ts';
import { readAbsoluteJson } from '../runtime/cli.ts';
import { workflowInputPath } from '../runtime/storage.ts';
import {
  loadResearchState,
  saveResearchState,
  researchDigest,
  researchSnapshotPath,
  researchPublicationPaths,
  reportForCandidate,
  type ResearchState,
  investigationBatch,
  researchWaitingOwner,
} from './state.ts';
import {
  parseClarificationAnswer,
  inputAnswerDelta,
  sameValue,
  type WaitingResult,
  type ClarificationAnswer,
} from '../runtime/clarification.ts';

export interface ResearchRunResult {
  clarification_answers: ClarificationAnswer[];
  report: ResearchReport;
  report_json: string;
  report_markdown: string;
}

export type ResearchWaitingResult = WaitingResult;

function inScope(source: string, scopePaths: readonly string[]): boolean {
  if (!scopePaths.length) return true;
  return scopePaths.some((scope) => source === scope || source.startsWith(`${scope}/`));
}

function validateRepositoryEvidence(
  input: ResearchInput,
  evidence: ResearchEvidence,
  label: string,
): void {
  const snapshot = readRepositoryEvidence(input.repo, evidence.source, evidence.locator, label);
  if (!inScope(snapshot.source, input.scope_paths)) {
    throw new FlowError(`${label}.source is outside the research scope`, 'evidence_error');
  }
}

function validateWebEvidence(
  input: ResearchInput,
  evidence: ResearchEvidence,
  label: string,
): void {
  if (!input.allow_external_sources) {
    throw new FlowError(
      `${label} uses web evidence while external sources are disabled`,
      'evidence_error',
    );
  }
  try {
    const url = new URL(evidence.source);
    if (url.protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    throw new FlowError(`${label}.source must be an HTTPS URL`, 'evidence_error');
  }
}

function validateEvidence(input: ResearchInput, evidence: ResearchEvidence[], label: string): void {
  for (const [index, item] of evidence.entries()) {
    if (item.kind === 'repository') validateRepositoryEvidence(input, item, `${label}[${index}]`);
    else validateWebEvidence(input, item, `${label}[${index}]`);
  }
}

function validateCandidate(input: ResearchInput, state: ResearchState): void {
  const candidate = state.candidate!;
  if (state.pending_question) {
    for (const part of state.investigations!)
      if (part.result)
        validateCandidate(input, { ...state, candidate: part.result, pending_question: null });
    return;
  }

  for (const [index, finding] of candidate.findings.entries())
    validateEvidence(input, finding.evidence, `research candidate.findings[${index}].evidence`);
  if (!candidate.findings.length && !candidate.unknowns.length)
    throw new FlowError(
      'research candidate must contain a finding or an explicit unknown',
      'evidence_error',
    );
  try {
    parseResearchReport(reportForCandidate(state, new Date().toISOString()));
  } catch (error) {
    throw new FlowError(
      `Research candidate cannot form a valid report: ${errorMessage(error)}`,
      'evidence_error',
    );
  }
}

function requireSnapshot(runId: string, state: ResearchState): string {
  const snapshot = researchSnapshotPath(runId, state);
  if (sealRepository(snapshot).source_digest !== state.source_digest)
    throw new FlowError(
      'Research snapshot changed; retain the run and start a new task to investigate current sources',
      'state_error',
    );
  return snapshot;
}

function correct(runId: string, state: ResearchState, reason: string): void {
  state.reason = reason;
  state.correction = reason;
  state.dispatch = null;
  state.pending_owner = null;
  if (state.corrections === 3) state.phase = 'blocked';
  else {
    state.corrections += 1;
    state.phase = 'investigate';
    if (state.investigations) {
      for (const part of state.investigations) {
        part.result = null;
        part.proposal = null;
        // A corrected candidate has its own retry allowance; total dispatch history is retained.
        part.settled = part.attempts;
      }
    } else state.investigations = investigationBatch(state.input);
    state.attempts = 0;
    // Retain the exhausted candidate's question with its audit; question findings may
    // legitimately have no factual evidence and still need their context on reload.
    state.pending_question = null;
    state.audit = null;
  }
  saveResearchState(runId, state);
}

/** Starts or resumes only the exact task-bound input while holding exclusive ownership. */
export async function runResearch(
  runId: string,
  inputFile: string,
  agent?: ResearchAgent,
  access?: StageAccess,
): Promise<ResearchRunResult | ResearchWaitingResult> {
  requireStageAccess(runId, access);
  using _ownership = acquireWorkflowOwnership(runId);
  let state = loadResearchState(runId);
  if (state && state.stage_binding !== (access?.binding ?? null))
    throw new FlowError('Research parent dispatch ownership changed', 'state_error');
  const intent = loadIntent(runId);
  const scopeRepo =
    state && !intent
      ? state.phase === 'completed'
        ? null
        : researchSnapshotPath(runId, state)
      : access?.snapshot;
  const input = validateResearchInput(readAbsoluteJson(inputFile, 'research'), scopeRepo);
  if ((!state || intent) && !access) requireResearchIntent(runId, input.repo, inputFile);
  if (path.resolve(inputFile) !== workflowInputPath(runId, 'research'))
    throw new FlowError(
      'use the research input path supplied by the workflow hook',
      'authorization_error',
    );
  // A new explicit invocation can replace only a terminal run, never active work.
  if (state && ['completed', 'blocked'].includes(state.phase) && intent) state = null;
  const rawInput = readAbsoluteJson(inputFile, 'research');
  if (state) {
    if (
      !sameValue(state.input, validateResearchInput(state.raw_input, scopeRepo)) ||
      !sameValue(state.input.clarification_answers ?? [], state.clarification_history)
    )
      throw new FlowError('Research stored input or answer history changed', 'state_error');
    const pending =
      state.phase === 'waiting' && state.pending_question && state.pending_owner
        ? {
            status: 'waiting' as const,
            question: state.pending_question,
            owner: state.pending_owner,
          }
        : undefined;
    inputAnswerDelta(state.raw_input, rawInput, pending);
  } else if (input.clarification_answers?.length && !access)
    throw new FlowError('answers require an existing waiting owner', 'state_error');
  if (!state) {
    const invocation = crypto.randomUUID();
    const snapshot = researchSnapshotPath(runId, { invocation });
    createRepositorySnapshot(access?.snapshot ?? input.repo, snapshot);
    state = {
      protocol: 'codex-research-state-v5',
      investigations: investigationBatch(input),
      invocation,
      run_id: runId,
      input,
      source_digest: sealRepository(snapshot).source_digest,
      knowledge: searchKnowledge(input.repo, input.question),
      phase: 'investigate',
      candidate: null,
      audit: null,
      corrections: 0,
      attempts: 0,
      dispatch: null,
      reason: null,
      correction: null,
      generated_at: null,
      publication: null,
      pending_question: null,
      clarification_history: (input.clarification_answers ?? []).map(parseClarificationAnswer),
      raw_input: rawInput,
      stage_binding: access?.binding ?? null,
      pending_owner: null,
      dispatch_history: [],
      accepted_questions: [],
    };
    saveResearchState(runId, state);
  }
  // The durable state now carries authorization and exact input; restarting needs no new intent.
  markStageStarted(access);
  clearIntent(runId);
  const investigator = () => (agent ??= new CodexResearchAgent());
  const requireContext = () => {
    const snapshot = requireSnapshot(runId, state!);
    if (
      researchDigest(validateResearchInput(readAbsoluteJson(inputFile, 'research'), snapshot)) !==
      researchDigest(input)
    )
      throw new FlowError('Research input changed during execution', 'state_error');
    return snapshot;
  };
  while (true) {
    if (state.phase === 'blocked')
      throw new FlowError(
        `Research blocked after ${state.corrections} corrections: ${state.reason}. Retain this record; a new explicit Research invocation starts a new budget.`,
        'research_blocked',
      );
    if (state.phase === 'completed') {
      const paths = researchPublicationPaths(state);
      // Repair a lost Markdown view, but never replace another JSON report.
      const report = reportForCandidate(state);
      persistResearchReport(input.repo, report, paths);
      return {
        report,
        report_json: paths.json,
        report_markdown: paths.markdown,
        clarification_answers: structuredClone(state.clarification_history),
      };
    }
    if (state.phase === 'waiting') {
      requireContext();
      if (
        !state.pending_question ||
        !state.pending_owner ||
        !sameValue(
          state.pending_owner,
          researchWaitingOwner(state, access?.root ?? state.invocation, access?.task ?? runId),
        )
      )
        throw new FlowError('Research waiting owner or acceptance changed', 'state_error');
      const waiting: WaitingResult = {
        status: 'waiting',
        question: state.pending_question,
        owner: state.pending_owner,
      };
      const answer = inputAnswerDelta(state.raw_input, rawInput, waiting);
      if (!answer) return waiting;
      state.accepted_questions.push({ waiting, candidate: state.candidate, review: state.audit });
      state.clarification_history.push(answer);
      state.raw_input = rawInput;
      state.input = input;
      const affected = new Set(
        state.investigations!.filter((part) => part.proposal).flatMap((part) => part.affected),
      );
      for (const part of state.investigations!)
        if (affected.has(part.question)) {
          part.result = null;
          part.proposal = null;
          part.affected = [];
        }
      state.pending_question = null;
      state.pending_owner = null;
      state.candidate = null;
      state.audit = null;
      state.phase = 'investigate';
      state.attempts = 0;
      state.dispatch = null;
      saveResearchState(runId, state);
      continue;
    }
    if (state.phase === 'investigate') {
      await investigateBatch(state, investigator(), requireContext);
      continue;
    }
    const snapshot = requireContext();
    const validationInput = { ...input, repo: snapshot };
    if (state.phase === 'audit' && state.pending_question) {
      try {
        validateCandidate(validationInput, state);
      } catch (error) {
        if (errorCode(error) !== 'evidence_error') throw error;
        correct(runId, state, errorMessage(error));
        continue;
      }
    }
    if (state.phase === 'validate') {
      try {
        validateCandidate(validationInput, state);
      } catch (error) {
        if (errorCode(error) !== 'evidence_error') throw error;
        correct(runId, state, errorMessage(error));
        continue;
      }
      state.phase = 'audit';
      state.attempts = 0;
      state.reason = null;
      saveResearchState(runId, state);
      continue;
    }
    if (
      state.phase === 'audit' &&
      state.pending_question &&
      state.clarification_history.some(
        (answer) => answer.question_id === state.pending_question!.id,
      )
    ) {
      correct(
        runId,
        state,
        'This question identity was already answered; reason from the complete history.',
      );
      continue;
    }
    if (state.phase === 'decide') {
      const blocking = state.audit!.findings.filter((finding) => finding.severity === 'blocking');
      if (blocking.length) {
        correct(runId, state, JSON.stringify(blocking));
        continue;
      }
      if (state.pending_question) {
        state.phase = 'waiting';
        state.pending_owner = researchWaitingOwner(
          state,
          access?.root ?? state.invocation,
          access?.task ?? runId,
        );
        saveResearchState(runId, state);
        continue;
      }
      state.generated_at = new Date().toISOString();
      state.publication = researchPublicationPaths(state);
      state.phase = 'publish';
      saveResearchState(runId, state);
      continue;
    }
    if (state.phase === 'publish') {
      validateCandidate(validationInput, state);
      persistResearchReport(input.repo, reportForCandidate(state), researchPublicationPaths(state));
      state.phase = 'completed';
      saveResearchState(runId, state);
      try {
        updateKnowledge(input.repo);
      } catch (error) {
        process.stderr.write(`Knowledge update skipped: ${errorMessage(error)}\n`);
      }
      continue;
    }
    // Each stage and candidate gets one retry, including an interrupted in-flight dispatch.
    if (state.attempts === 2) {
      state.phase = 'blocked';
      state.reason =
        state.reason ?? 'Both permitted model dispatches were interrupted before acceptance';
      saveResearchState(runId, state);
      continue;
    }
    state.attempts += 1;
    state.dispatch = crypto.randomUUID();
    state.dispatch_history.push(state.dispatch);
    saveResearchState(runId, state);
    const pendingDigest = researchDigest(state);
    let result: unknown;
    let failure: unknown;
    try {
      result = await investigator().audit(
        structuredClone(input),
        structuredClone(state.candidate!),
        structuredClone(state.knowledge),
        snapshot,
        state.pending_question
          ? {
              question: structuredClone(state.pending_question),
              investigations: structuredClone(state.investigations!),
            }
          : undefined,
      );
    } catch (error) {
      failure = error;
    }
    // Validate the pending identity even on rejection: never overwrite a newer dispatch.
    if (researchDigest(loadResearchState(runId)) !== pendingDigest)
      throw new FlowError(
        'Research dispatch is stale or its candidate/input changed',
        'state_error',
      );
    requireContext();
    try {
      if (failure !== undefined) throw failure;
      const audit = parseResearchAudit(result, Boolean(state.pending_question));
      for (const [index, finding] of audit.findings.entries())
        validateEvidence(
          validationInput,
          finding.evidence,
          `research audit.findings[${index}].evidence`,
        );
      state.audit = audit;
      state.phase = 'decide';
      state.dispatch = null;
    } catch (error) {
      // Invalid responses and transport errors are indeterminate, not investigator defects.
      state.reason = errorMessage(error);
    }
    saveResearchState(runId, state);
  }
}
