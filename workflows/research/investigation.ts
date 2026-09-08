/** @file Outcome: Required investigators overlap, persist independently, and join before whole-question validation. */
import { FlowError, errorMessage } from '../shared/errors.ts';
import { parseResearchInvestigationResult, type ResearchDraft } from './contracts.ts';
import crypto from 'node:crypto';
import { parsePendingQuestion } from '../runtime/clarification.ts';
import type { ResearchAgent } from './agent.ts';
import {
  loadResearchState,
  saveResearchState,
  researchDigest,
  researchSnapshotPath,
  type ResearchState,
} from './state.ts';

function integrate(state: ResearchState): ResearchDraft {
  const parts = state.investigations!;
  if (parts.length === 1) return parts[0]!.result!;
  const results = parts.map((part) => part.result!);
  return {
    answer: parts.map((part) => `${part.question}\n${part.result!.answer}`).join('\n\n'),
    findings: results.flatMap((result) => result.findings),
    rejected: results.flatMap((result) => result.rejected),
    unknowns: results.flatMap((result) => result.unknowns),
    limitations: results.flatMap((result) => result.limitations),
  };
}
/** The caller holds ownership until all children settle, including after cancellation. */
export async function investigateBatch(
  state: ResearchState,
  agent: ResearchAgent,
  requireContext: () => void,
): Promise<void> {
  const controller = new AbortController();
  let expected = researchDigest(state);
  const check = () => {
    if (researchDigest(loadResearchState(state.run_id)) !== expected)
      throw new FlowError(
        'Research dispatch is stale or its candidate/input changed',
        'state_error',
      );
  };
  const save = () => {
    saveResearchState(state.run_id, state);
    expected = researchDigest(state);
  };
  const results = await Promise.allSettled(
    state.investigations!.map(async (part) => {
      try {
        while (!part.result && !part.proposal && part.attempts - part.settled < 2) {
          if (controller.signal.aborted) return;
          check();
          requireContext();
          part.attempts++;
          state.dispatch_history.push(crypto.randomUUID());
          save();
          let result: unknown;
          let failure: unknown;
          try {
            result = await agent.investigate(
              structuredClone(state.input),
              structuredClone(state.knowledge),
              researchSnapshotPath(state.run_id, state),
              state.candidate && state.correction
                ? { candidate: structuredClone(state.candidate), reason: state.correction }
                : undefined,
              { question: part.question, signal: controller.signal },
            );
          } catch (error) {
            failure = error;
          }
          if (controller.signal.aborted) return;
          check();
          requireContext();
          try {
            if (failure !== undefined) throw failure;
            const parsed = parseResearchInvestigationResult(result);
            if ('status' in parsed) {
              const affected =
                parsed.affected_questions ?? state.investigations!.map((p) => p.question);
              if (
                !affected.includes(part.question) ||
                new Set(affected).size !== affected.length ||
                affected.some((q) => !state.investigations!.some((p) => p.question === q))
              )
                throw new FlowError('invalid answer-affected assignments');
              part.affected = affected;
              part.proposal = parsePendingQuestion(parsed.question);
              part.settled++;
              part.reason = null;
              save();
              return;
            }
            part.result = parsed;
            part.settled++;
            part.reason = null;
          } catch (error) {
            part.reason = errorMessage(error);
          }
          save();
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  check();
  const missing = state.investigations!.filter((part) => !part.result);
  const proposals = state.investigations!.filter((part) => part.proposal);
  if (proposals.length) {
    // Multiple authors must reconcile through the bounded author correction path.
    if (proposals.length !== 1 || missing.some((part) => !part.proposal)) {
      state.reason =
        'Return exactly one necessary user-owned decision for the original question; reconcile all sibling proposals and failures.';
      state.correction = state.reason;
      state.candidate = {
        answer: JSON.stringify(state.investigations),
        findings: [],
        rejected: [],
        unknowns: [],
        limitations: [],
      };
      if (state.corrections === 3) state.phase = 'blocked';
      else {
        state.corrections++;
        for (const part of state.investigations!) {
          part.proposal = null;
          part.result = null;
          // Reconciliation starts a corrected candidate's retry allowance, retaining total attempts.
          part.settled = part.attempts;
        }
      }
    } else {
      state.pending_question = proposals[0]!.proposal;
      const siblings = state
        .investigations!.filter((part) => part.result)
        .map((part) => part.result!);
      state.candidate = {
        answer: JSON.stringify({
          question: state.pending_question,
          investigations: state.investigations,
        }),
        findings: siblings.flatMap((part) => part.findings),
        rejected: siblings.flatMap((part) => part.rejected),
        unknowns: siblings.flatMap((part) => part.unknowns),
        limitations: siblings.flatMap((part) => part.limitations),
      };
      state.phase = 'audit';
      state.audit = null;
      state.attempts = 0;
    }
    save();
    return;
  }
  if (missing.length) {
    state.phase = 'blocked';
    state.reason = missing
      .map(
        (part) =>
          `${part.question}: ${part.reason ?? 'Both permitted model dispatches were interrupted before acceptance'}`,
      )
      .join('\n');
  } else {
    state.candidate = integrate(state);
    state.investigations = null;
    state.phase = 'validate';
    state.audit = null;
    state.attempts = 0;
    state.reason = null;
  }
  save();
}
