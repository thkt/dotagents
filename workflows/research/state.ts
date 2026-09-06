/** @file Outcome: Research restarts retain one checked candidate, snapshot, budget and publication identity. */

import crypto from 'node:crypto';
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
  parseResearchAudit,
  parseResearchReport,
  type ResearchInput,
  type ResearchDraft,
  type ResearchAudit,
  type ResearchReport,
} from './contracts.ts';
import type { KnowledgeEntry } from './knowledge.ts';

export interface ResearchState {
  protocol: 'codex-research-state-v2';
  invocation: string;
  run_id: string;
  input: ResearchInput;
  source_digest: string;
  knowledge: KnowledgeEntry[];
  phase: 'investigate' | 'validate' | 'audit' | 'decide' | 'publish' | 'completed' | 'blocked';
  candidate: ResearchDraft | null;
  audit: ResearchAudit | null;
  corrections: number;
  attempts: number;
  dispatch: string | null;
  reason: string | null;
  correction: string | null;
  generated_at: string | null;
  publication: { json: string; markdown: string } | null;
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
        'audit',
        'corrections',
        'attempts',
        'dispatch',
        'reason',
        'correction',
        'generated_at',
        'publication',
      ],
      'research state',
    );
    if (
      state.protocol !== 'codex-research-state-v2' ||
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
      !['investigate', 'validate', 'audit', 'decide', 'publish', 'completed', 'blocked'].includes(
        String(state.phase),
      ) ||
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
    if (state.candidate !== null) parseResearchDraft(state.candidate);
    if (state.audit !== null) parseResearchAudit(state.audit);

    if (
      ['validate', 'audit', 'decide', 'publish', 'completed'].includes(String(state.phase)) &&
      !state.candidate
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
