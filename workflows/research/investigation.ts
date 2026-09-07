/** @file Outcome: Required investigators overlap, persist independently, and join before whole-question validation. */
import { FlowError, errorMessage } from '../shared/errors.ts';
import { parseResearchDraft, type ResearchDraft } from './contracts.ts';
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
    requireContext();
  };
  const save = () => {
    saveResearchState(state.run_id, state);
    expected = researchDigest(state);
  };
  const results = await Promise.allSettled(
    state.investigations!.map(async (part) => {
      try {
        while (!part.result && part.attempts < 2) {
          if (controller.signal.aborted) return;
          check();
          part.attempts++;
          part.dispatch = crypto.randomUUID();
          save();
          const dispatch = part.dispatch;
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
          if (part.dispatch !== dispatch)
            throw new FlowError('stale investigation result', 'state_error');
          try {
            if (failure !== undefined) throw failure;
            part.result = parseResearchDraft(result);
            part.dispatch = null;
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
