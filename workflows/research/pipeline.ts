/** @file Outcome: Research validates, independently audits, corrects and resumes one immutable snapshot. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorCode, errorMessage, FlowError } from '../shared/errors.ts';
import { readRepositoryEvidence } from '../shared/evidence.ts';
import {
  parseResearchDraft,
  parseResearchAudit,
  parseResearchReport,
  type ResearchEvidence,
  type ResearchInput,
  type ResearchReport,
} from './contracts.ts';
import { CodexResearchAgent, type ResearchAgent } from './agent.ts';
import { persistResearchReport } from './artifact.ts';
import { searchKnowledge, updateKnowledge } from './knowledge.ts';
import { withRepositorySnapshot } from '../execution/repository-isolation.ts';
import { sealRepository } from '../execution/source-seal.ts';
import { acquireWorkflowOwnership } from '../runtime/ownership.ts';
import { clearIntent, loadIntent, requireResearchIntent } from '../runtime/invocation.ts';
import { workflowInputPath } from '../runtime/storage.ts';
import {
  loadResearchState,
  saveResearchState,
  researchDigest,
  researchSnapshotPath,
  researchPublicationPaths,
  reportForCandidate,
  type ResearchState,
} from './state.ts';

export interface ResearchRunResult {
  report: ResearchReport;
  report_json: string;
  report_markdown: string;
}

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
  if (state.corrections === 3) state.phase = 'blocked';
  else {
    state.corrections += 1;
    state.phase = 'investigate';
    state.attempts = 0;
    state.audit = null;
  }
  saveResearchState(runId, state);
}

/** Optional context is the CLI's exact task binding; library calls create separate runs. */
export async function runResearch(
  input: ResearchInput,
  agent?: ResearchAgent,
  context?: { runId: string; inputFile: string },
): Promise<ResearchRunResult> {
  input = structuredClone(input);
  const runId = context?.runId ?? crypto.randomUUID();
  using _ownership = acquireWorkflowOwnership(runId);
  let state = loadResearchState(runId);
  if (context) {
    if (!state || loadIntent(runId)) requireResearchIntent(runId, input.repo, context.inputFile);
    if (path.resolve(context.inputFile) !== workflowInputPath(runId, 'research'))
      throw new FlowError(
        'use the research input path supplied by the workflow hook',
        'authorization_error',
      );
    // A new explicit invocation can replace only a terminal run, never active work.
    if (state && ['completed', 'blocked'].includes(state.phase) && loadIntent(runId)) state = null;
  }
  if (state && researchDigest(state.input) !== researchDigest(input))
    throw new FlowError(
      'Research resume requires the exact original input; use a new task for a different question',
      'state_error',
    );
  if (!state) {
    const invocation = crypto.randomUUID();
    const snapshot = researchSnapshotPath(runId, { invocation });
    await withRepositorySnapshot(input.repo, async (source) => {
      fs.mkdirSync(path.dirname(snapshot), { recursive: true, mode: 0o700 });
      fs.cpSync(source, snapshot, { recursive: true, verbatimSymlinks: true });
    });
    state = {
      protocol: 'codex-research-state-v2',
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
    };
    saveResearchState(runId, state);
  }
  // The durable state now carries authorization and exact input; restarting needs no new intent.
  if (context) clearIntent(runId);
  const investigator = () => (agent ??= new CodexResearchAgent());
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
      return { report, report_json: paths.json, report_markdown: paths.markdown };
    }
    const snapshot = requireSnapshot(runId, state);
    const validationInput = { ...input, repo: snapshot };
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
    if (state.phase === 'decide') {
      const blocking = state.audit!.findings.filter((finding) => finding.severity === 'blocking');
      if (blocking.length) {
        correct(runId, state, JSON.stringify(blocking));
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
    saveResearchState(runId, state);
    const pendingDigest = researchDigest(state);
    let result: unknown;
    let failure: unknown;
    try {
      result =
        state.phase === 'investigate'
          ? await investigator().investigate(
              structuredClone(input),
              structuredClone(state.knowledge),
              snapshot,
              state.candidate && state.correction
                ? { candidate: structuredClone(state.candidate), reason: state.correction }
                : undefined,
            )
          : await investigator().audit(
              structuredClone(input),
              structuredClone(state.candidate!),
              structuredClone(state.knowledge),
              snapshot,
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
    requireSnapshot(runId, state);
    try {
      if (failure !== undefined) throw failure;
      if (state.phase === 'investigate') {
        state.candidate = parseResearchDraft(result);
        state.phase = 'validate';
        state.audit = null;
      } else {
        const audit = parseResearchAudit(result);
        for (const [index, finding] of audit.findings.entries())
          validateEvidence(
            validationInput,
            finding.evidence,
            `research audit.findings[${index}].evidence`,
          );
        state.audit = audit;
        state.phase = 'decide';
      }
      state.dispatch = null;
    } catch (error) {
      // Invalid responses and transport errors are indeterminate, not investigator defects.
      state.reason = errorMessage(error);
    }
    saveResearchState(runId, state);
  }
}
