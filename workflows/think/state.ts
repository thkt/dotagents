/** @file Outcome: Think retains its candidate, governing evidence, budgets and publication across restart. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWrite,
  thinkStatePath,
  workflowRunDirectory,
  thinkArtifactDirectory,
} from '../runtime/storage.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';
import {
  parseThinkDecision,
  parseThinkReview,
  parseThinkReport,
  type ThinkInput,
  type ThinkDraft,
  type ThinkReview,
  type ThinkReport,
} from './contracts.ts';
import type { ThinkResearchContext } from './agent.ts';
import { parseResearchReport } from '../research/contracts.ts';

export interface ThinkState {
  protocol: 'codex-think-state-v1';
  invocation: string;
  run_id: string;
  input: ThinkInput;
  input_digest: string;
  source_digest: string;
  contract_digest: string;
  research: ThinkResearchContext[];
  knowledge: ThinkResearchContext[];
  phase: 'design' | 'validate' | 'review' | 'decide' | 'publish' | 'completed' | 'blocked';
  candidate: ThinkDraft | null;
  review: ThinkReview | null;
  corrections: number;
  attempts: number;
  dispatch: string | null;
  reason: string | null;
  correction: string | null;
  generated_at: string | null;
  publication: { json: string; markdown: string } | null;
}

export function thinkDigest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        isObject(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest('hex');
}

/** A changed authoring or validation contract cannot reuse an earlier acceptance. */
export function thinkContractDigest(): string {
  return thinkDigest(
    ['../plan/contracts.ts', '../plan/validation.ts', './contracts.ts', './agent.ts'].map((file) =>
      fs.readFileSync(new URL(file, import.meta.url), 'utf8'),
    ),
  );
}

export function thinkSnapshotPath(runId: string, state: Pick<ThinkState, 'invocation'>): string {
  return path.join(workflowRunDirectory(runId), 'think', state.invocation, 'snapshot');
}

export function thinkPublicationPaths(state: ThinkState): { json: string; markdown: string } {
  if (state.publication) return state.publication;
  const base = path.join(thinkArtifactDirectory(state.input.repo), `think-${state.invocation}`);
  return { json: `${base}.json`, markdown: `${base}.md` };
}

export function saveThinkState(runId: string, state: ThinkState): void {
  atomicWrite(thinkStatePath(runId), { state, digest: thinkDigest(state) });
}

export function loadThinkState(runId: string): ThinkState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(thinkStatePath(runId), 'utf8'));
    if (!isObject(raw) || !isObject(raw.state) || raw.digest !== thinkDigest(raw.state))
      throw new Error('state integrity mismatch');
    rejectUnknownKeys(raw, ['state', 'digest'], 'think state');
    const s = raw.state;
    rejectUnknownKeys(
      s,
      [
        'protocol',
        'invocation',
        'run_id',
        'input',
        'input_digest',
        'source_digest',
        'contract_digest',
        'research',
        'knowledge',
        'phase',
        'candidate',
        'review',
        'corrections',
        'attempts',
        'dispatch',
        'reason',
        'correction',
        'generated_at',
        'publication',
      ],
      'think state',
    );
    if (
      s.protocol !== 'codex-think-state-v1' ||
      s.run_id !== runId ||
      typeof s.invocation !== 'string' ||
      !/^[0-9a-f-]{36}$/u.test(s.invocation) ||
      typeof s.source_digest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(s.source_digest) ||
      typeof s.contract_digest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(s.contract_digest) ||
      typeof s.input_digest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(s.input_digest) ||
      !isObject(s.input) ||
      typeof s.input.repo !== 'string' ||
      !path.isAbsolute(s.input.repo) ||
      typeof s.input.request !== 'string' ||
      !s.input.request.trim() ||
      !Array.isArray(s.input.research_reports) ||
      s.input.research_reports.some((p) => typeof p !== 'string' || !path.isAbsolute(p)) ||
      !Array.isArray(s.research) ||
      !Array.isArray(s.knowledge) ||
      !['design', 'validate', 'review', 'decide', 'publish', 'completed', 'blocked'].includes(
        String(s.phase),
      ) ||
      !Number.isInteger(s.corrections) ||
      Number(s.corrections) < 0 ||
      Number(s.corrections) > 3 ||
      !Number.isInteger(s.attempts) ||
      Number(s.attempts) < 0 ||
      Number(s.attempts) > 2 ||
      ![s.dispatch, s.reason, s.correction].every((v) => v === null || typeof v === 'string') ||
      !(
        s.generated_at === null ||
        (typeof s.generated_at === 'string' &&
          Number.isFinite(Date.parse(s.generated_at)) &&
          new Date(s.generated_at).toISOString() === s.generated_at)
      )
    )
      throw new Error('unsupported or malformed state');
    for (const context of [...s.research, ...s.knowledge]) {
      if (
        !isObject(context) ||
        typeof context.path !== 'string' ||
        path.basename(context.path) !== context.path ||
        !context.path.endsWith('.json')
      )
        throw new Error('invalid captured Research context');
      rejectUnknownKeys(
        context,
        ['path', 'generated_at', 'question', 'answer', 'findings', 'unknowns', 'limitations'],
        'think Research context',
      );
      const { path: _path, ...report } = context;
      parseResearchReport({
        protocol: 'codex-research-report',
        scope_paths: [],
        rejected: [],
        ...report,
      });
    }
    if (
      s.publication !== null &&
      (!isObject(s.publication) ||
        typeof s.publication.json !== 'string' ||
        !path.isAbsolute(s.publication.json) ||
        path.basename(s.publication.json) !== `think-${s.invocation}.json` ||
        s.publication.markdown !== s.publication.json.replace(/\.json$/u, '.md'))
    )
      throw new Error('invalid publication identity');
    if (s.candidate !== null) parseThinkDecision(s.candidate);
    if (s.review !== null) parseThinkReview(s.review);
    if (
      ['validate', 'review', 'decide', 'publish', 'completed'].includes(String(s.phase)) &&
      !s.candidate
    )
      throw new Error('candidate missing');
    if (['decide', 'publish', 'completed'].includes(String(s.phase)) && !s.review)
      throw new Error('independent review missing');
    const state = s as unknown as ThinkState;
    if (['publish', 'completed'].includes(state.phase)) {
      if (
        !state.generated_at ||
        !state.publication ||
        state.review!.findings.some((f) => f.severity === 'blocking')
      )
        throw new Error('publication has no accepted candidate');
      parseThinkReport(thinkReport(state));
    }
    return state;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new FlowError(
      `Think state cannot resume: ${errorMessage(error)}. Retain the record and use its original runtime to recover, or start Think in a new task.`,
      'state_error',
    );
  }
}

export function thinkReport(state: ThinkState): ThinkReport {
  return {
    protocol: 'codex-think-report',
    generated_at: state.generated_at!,
    request: state.input.request,
    ...state.candidate!,
    research_reports: [...state.research, ...state.knowledge].map((item) => item.path),
  };
}
