/** @file Outcome: Think validates and independently reviews designer-owned decisions with durable correction. */
import crypto from 'node:crypto';
import {
  initializeStageReturns,
  requireStageAccess,
  markStageStarted,
  runStageReturn,
  resumeRootWaiting,
  saveStageReturnTransition,
  type StageAccess,
  type StageAgents,
} from '../runtime/stage-return.ts';
import * as fs from 'node:fs';
import path from 'node:path';
import { validatePlan } from '../plan/validation.ts';
import { createRepositorySnapshot } from '../execution/repository-isolation.ts';
import { sealRepository } from '../execution/source-seal.ts';
import { searchKnowledge } from '../research/knowledge.ts';
import { parseResearchReport } from '../research/contracts.ts';
import { errorCode, errorMessage, FlowError } from '../shared/errors.ts';
import { realpathInside } from '../shared/repository.ts';
import { researchArtifactDirectory, workflowInputPath } from '../runtime/storage.ts';
import { acquireWorkflowOwnership } from '../runtime/ownership.ts';
import { clearIntent, loadIntent, requireThinkIntent } from '../runtime/invocation.ts';
import { readAbsoluteJson } from '../runtime/cli.ts';
import { CodexThinkAgent, type ThinkAgent, type ThinkResearchContext } from './agent.ts';
import { persistThinkReport } from './artifact.ts';
import {
  THINK_PLAN_SCHEMA,
  validateThinkInput,
  parseThinkDecision,
  parseThinkReview,
  type ThinkDecision,
  type ThinkReport,
} from './contracts.ts';
import {
  loadThinkState,
  saveThinkState,
  thinkDigest,
  thinkContractDigest,
  thinkSnapshotPath,
  thinkPublicationPaths,
  thinkReport,
  thinkWaitingOwner,
  type ThinkState,
} from './state.ts';
import {
  parseClarificationAnswer,
  inputAnswerDelta,
  sameValue,
  type WaitingResult,
} from '../runtime/clarification.ts';

export interface ThinkRunResult {
  report: ThinkReport;
  report_json: string;
  report_markdown: string;
}

export type ThinkWaitingResult = WaitingResult;

function reportContext(repo: string, file: string, index: number): ThinkResearchContext {
  const label = `think input.research_reports[${index}]`;
  const directory = researchArtifactDirectory(repo);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || !realpathInside(directory, file) || path.extname(file) !== '.json') {
    throw new FlowError(`${label} must name a readable research JSON artifact for this repository`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    throw new FlowError(`${label} must contain valid JSON`);
  }
  const report = parseResearchReport(raw);
  return {
    clarification_answers: [],
    path: path.basename(file),
    generated_at: report.generated_at,
    question: report.question,
    answer: report.answer,
    findings: report.findings,
    unknowns: report.unknowns,
    limitations: report.limitations,
  };
}

/** Accepted child answers are analysis context, never edits to the caller's authority input. */
function reasoningInput(state: ThinkState) {
  const history = new Map<string, import('../runtime/clarification.ts').ClarificationAnswer>();
  for (const answer of [
    ...state.research.flatMap((report) => report.clarification_answers),
    ...state.clarification_history,
  ]) {
    const prior = history.get(answer.question_id);
    if (prior && !sameValue(prior, answer))
      throw new FlowError('conflicting accepted clarification history', 'state_error');
    history.set(answer.question_id, answer);
  }
  return history.size
    ? { ...state.input, clarification_answers: [...history.values()] }
    : state.input;
}

function validateDecision(decision: ThinkDecision): void {
  if (decision.status === 'research_required' || decision.status === 'waiting') return;
  if (!decision.plan) throw new FlowError('ready decision must contain a plan', 'decision_error');
  const report = validatePlan(decision.plan);
  if (report.verdict !== 'pass') {
    throw new FlowError(
      `think plan violates the build contract: ${[...report.blockers, ...report.reason_codes].join('; ')}`,
      'decision_error',
    );
  }
}

function requireContext(runId: string, state: ThinkState, inputFile: string): string {
  if (thinkDigest(readAbsoluteJson(inputFile, 'think')) !== state.input_digest)
    throw new FlowError(
      'Think governing input changed; restore the exact original input or start a new task',
      'state_error',
    );
  if (thinkContractDigest() !== state.contract_digest)
    throw new FlowError(
      'Think governing contract changed; retain this run and use its original runtime or start a new task',
      'state_error',
    );
  const snapshot = thinkSnapshotPath(runId, state);
  // The Research return validates this snapshot before and after child execution.
  if (state.phase !== 'research' && sealRepository(snapshot).source_digest !== state.source_digest)
    throw new FlowError(
      'Think snapshot changed; retain this run and start a new task',
      'state_error',
    );
  return snapshot;
}

function correct(state: ThinkState, reason: string, persist: (state: ThinkState) => void): void {
  state.reason = reason;
  state.correction = reason;
  state.dispatch = null;
  if (state.corrections === 3) state.phase = 'blocked';
  else {
    state.corrections++;
    state.phase = 'design';
    state.attempts = 0;
    state.review = null;
  }
  persist(state);
}

export async function runThink(
  runId: string,
  inputFile: string,
  agent?: ThinkAgent,
  access?: StageAccess,
  children: StageAgents = {},
): Promise<ThinkRunResult | ThinkWaitingResult> {
  requireStageAccess(runId, access);
  using _ownership = acquireWorkflowOwnership(runId);
  let state = loadThinkState(runId);
  if (state && state.stage_binding !== (access?.binding ?? null))
    throw new FlowError('Think parent dispatch ownership changed', 'state_error');
  const intent = loadIntent(runId);
  // Only a terminal root may start afresh. Validate its new authorization below
  // before any writes; an active invocation must still pass its old waiting journal.
  if (!access && state && ['completed', 'blocked'].includes(state.phase) && intent) state = null;
  else if (!access) {
    const waiting = await resumeRootWaiting(runId, 'think', inputFile);
    if (waiting) return waiting;
    state = loadThinkState(runId); // Root answer adoption may have updated this record.
  }
  let persistedDigest = state ? thinkDigest(state) : null;
  const persist = (next: ThinkState): void => {
    if (persistedDigest === null) saveThinkState(runId, next);
    else
      saveStageReturnTransition(
        runId,
        'think',
        persistedDigest,
        thinkDigest(next),
        () => saveThinkState(runId, next),
        access,
      );
    persistedDigest = thinkDigest(next);
  };
  const rawInput = readAbsoluteJson(inputFile, 'think');
  const inputDigest = thinkDigest(rawInput);
  const parsedInput = validateThinkInput(rawInput);
  const input = state
    ? {
        ...state.input,
        ...(parsedInput.clarification_answers === undefined
          ? {}
          : { clarification_answers: parsedInput.clarification_answers }),
      }
    : parsedInput;
  if ((!state || intent) && !access) requireThinkIntent(runId, input.repo, inputFile);
  if (path.resolve(inputFile) !== workflowInputPath(runId, 'think'))
    throw new FlowError(
      'use the think input path supplied by the workflow hook',
      'authorization_error',
    );
  if (
    state &&
    (thinkDigest({ ...state.input, clarification_answers: undefined }) !== state.input_authority ||
      thinkDigest(state.raw_input) !== state.input_digest ||
      !sameValue(state.input.clarification_answers ?? [], state.clarification_history))
  )
    throw new FlowError('Think stored input or answer history changed', 'state_error');
  if (state)
    inputAnswerDelta(
      state.raw_input,
      rawInput,
      state.phase === 'waiting' && state.candidate?.question && state.pending_owner
        ? { status: 'waiting', question: state.candidate.question, owner: state.pending_owner }
        : undefined,
    );
  else if (input.clarification_answers?.length && !access)
    throw new FlowError('answers require an existing waiting owner', 'state_error');
  if (!state) {
    const research = [...new Set(input.research_reports)].map((file, index) =>
      reportContext(input.repo, file, index),
    );
    const knowledge = searchKnowledge(
      input.repo,
      input.request,
      research.map((report) => report.path),
    ).flatMap((entry) =>
      entry.sources.flatMap((source) => {
        try {
          return [
            reportContext(
              input.repo,
              path.join(researchArtifactDirectory(input.repo), source.report),
              0,
            ),
          ];
        } catch {
          // A derived index may outlive its original report; optional context must not block Think.
          return [];
        }
      }),
    );

    const invocation = crypto.randomUUID();
    const snapshot = thinkSnapshotPath(runId, { invocation });
    createRepositorySnapshot(access?.snapshot ?? input.repo, snapshot);
    state = {
      protocol: 'codex-think-state-v6',
      invocation,
      run_id: runId,
      input,
      input_digest: inputDigest,
      input_authority: thinkDigest({ ...input, clarification_answers: undefined }),
      source_digest: sealRepository(snapshot).source_digest,
      contract_digest: thinkContractDigest(),
      research,
      knowledge,
      phase: 'design',
      candidate: null,
      review: null,
      corrections: 0,
      attempts: 0,
      dispatch: null,
      reason: null,
      correction: null,
      generated_at: null,
      publication: null,
      clarification_history: (input.clarification_answers ?? []).map(parseClarificationAnswer),
      raw_input: rawInput,
      stage_binding: access?.binding ?? null,
      pending_owner: null,
      dispatch_history: [],
      accepted_questions: [],
    };
    if (!access) initializeStageReturns(runId, 'think', invocation, rawInput);
    persist(state);
  }
  markStageStarted(access);
  clearIntent(runId);
  const worker = () => (agent ??= new CodexThinkAgent());
  while (true) {
    if (state.phase === 'blocked')
      throw new FlowError(
        `Think blocked after ${state.corrections} corrections: ${state.reason}. Retain this record; a new explicit Think invocation starts a new budget.`,
        'think_blocked',
      );
    if (state.phase === 'completed') {
      const report = thinkReport(state);
      const paths = thinkPublicationPaths(state);
      persistThinkReport(input.repo, report, paths);
      return { report, report_json: paths.json, report_markdown: paths.markdown };
    }
    if (state.phase === 'waiting') {
      // The only permitted input change is checked before the snapshot/contract check.
      requireContext(runId, { ...state, input_digest: thinkDigest(rawInput) }, inputFile);
      if (
        state.candidate?.status !== 'waiting' ||
        !state.candidate.question ||
        !state.pending_owner ||
        !sameValue(
          state.pending_owner,
          thinkWaitingOwner(state, access?.root ?? state.invocation, access?.task ?? runId),
        )
      )
        throw new FlowError('Think waiting owner or acceptance changed', 'state_error');
      const waiting: WaitingResult = {
        status: 'waiting',
        question: state.candidate.question,
        owner: state.pending_owner,
      };
      const answer = inputAnswerDelta(state.raw_input, rawInput, waiting);
      if (!answer) return waiting;
      state.accepted_questions.push({ waiting, candidate: state.candidate, review: state.review });
      state.clarification_history.push(answer);
      state.raw_input = rawInput;
      state.input = input;
      state.input_digest = thinkDigest(rawInput);
      state.pending_owner = null;
      state.candidate = null;
      state.review = null;
      state.phase = 'design';
      state.attempts = 0;
      state.dispatch = null;
      persist(state);
      continue;
    }
    const snapshot = requireContext(runId, state, inputFile);
    if (state.phase === 'validate') {
      try {
        if (
          state.candidate?.question &&
          reasoningInput(state).clarification_answers?.some(
            (answer) =>
              parseClarificationAnswer(answer).question_id === state.candidate!.question!.id,
          )
        )
          throw new FlowError(
            'Question identity was already answered; reason from the complete history',
            'decision_error',
          );
        validateDecision(state.candidate!);
      } catch (error) {
        if (errorCode(error) !== 'decision_error') throw error;
        correct(state, errorMessage(error), persist);
        continue;
      }
      state.phase = 'review';
      state.attempts = 0;
      state.reason = null;
      persist(state);
      continue;
    }
    if (state.phase === 'decide') {
      const blocking = state.review!.findings.filter((f) => f.severity === 'blocking');
      if (blocking.length) {
        correct(state, JSON.stringify(blocking), persist);
        continue;
      }
      if (state.candidate!.status === 'research_required') {
        state.phase = 'research';
        persist(state);
        continue;
      }
      if (state.candidate!.status === 'waiting') {
        state.phase = 'waiting';
        state.pending_owner = thinkWaitingOwner(
          state,
          access?.root ?? state.invocation,
          access?.task ?? runId,
        );
        persist(state);
        continue;
      }
      state.generated_at = new Date().toISOString();
      state.publication = thinkPublicationPaths(state);
      state.phase = 'publish';
      persist(state);
      continue;
    }
    if (state.phase === 'research') {
      const parentBinding = thinkDigest(state);
      const child = await runStageReturn(
        runId,
        'think',
        { ...children, ...(agent ? { think: agent } : {}) },
        access,
      ).catch((error) => {
        if (thinkDigest(loadThinkState(runId)) === parentBinding) {
          state.reason = errorMessage(error);
          if (
            ['stage_return_blocked', 'research_blocked', 'think_blocked'].includes(
              errorCode(error) ?? '',
            )
          )
            state.phase = 'blocked';
          persist(state);
        }
        throw error;
      });
      if (thinkDigest(loadThinkState(runId)) !== parentBinding)
        throw new FlowError('stale Think parent after child execution', 'state_error');
      requireContext(runId, state, inputFile);
      if (!('report' in child)) return child as ThinkWaitingResult;
      const report = parseResearchReport(child.report);
      if (!('clarification_answers' in child))
        throw new FlowError('accepted Research answer context is missing', 'state_error');
      state.research.push({
        clarification_answers: structuredClone(child.clarification_answers),
        path: path.basename(child.report_json),
        generated_at: report.generated_at,
        question: report.question,
        answer: report.answer,
        findings: report.findings,
        unknowns: report.unknowns,
        limitations: report.limitations,
      });
      state.correction =
        'Reconsider the original request using the newly accepted Research. Preserve explicit unknowns; do not invent missing requirements.';
      state.review = null;
      state.phase = 'design';
      state.attempts = 0;
      persist(state);
      continue;
    }
    if (state.phase === 'publish') {
      validateDecision(state.candidate!);
      persistThinkReport(input.repo, thinkReport(state), thinkPublicationPaths(state));
      state.phase = 'completed';
      persist(state);
      continue;
    }
    if (state.attempts === 2) {
      state.phase = 'blocked';
      state.reason ??= 'Both permitted model dispatches were interrupted before acceptance';
      persist(state);
      continue;
    }
    state.attempts++;
    state.dispatch = crypto.randomUUID();
    state.dispatch_history.push(state.dispatch);
    persist(state);
    const pending = thinkDigest(state);
    let result: unknown;
    let failure: unknown;
    try {
      const contract = { plan_schema: structuredClone(THINK_PLAN_SCHEMA) };
      result =
        state.phase === 'design'
          ? await worker().design(
              structuredClone(reasoningInput(state)),
              structuredClone(state.research),
              structuredClone(state.knowledge),
              contract,
              snapshot,
              state.candidate && state.correction
                ? { candidate: structuredClone(state.candidate), reason: state.correction }
                : undefined,
            )
          : await worker().review(
              structuredClone(reasoningInput(state)),
              structuredClone(state.candidate!),
              structuredClone(state.research),
              structuredClone(state.knowledge),
              contract,
              snapshot,
            );
    } catch (error) {
      failure = error;
    }
    if (thinkDigest(loadThinkState(runId)) !== pending)
      throw new FlowError('Think dispatch is stale or its candidate/input changed', 'state_error');
    requireContext(runId, state, inputFile);
    try {
      if (failure !== undefined) throw failure;
      if (state.phase === 'design') {
        state.candidate = structuredClone(parseThinkDecision(result));
        state.phase = 'validate';
        state.review = null;
      } else {
        state.review = structuredClone(parseThinkReview(result));
        state.phase = 'decide';
      }
      state.dispatch = null;
    } catch (error) {
      state.reason = errorMessage(error);
    }
    persist(state);
  }
}
