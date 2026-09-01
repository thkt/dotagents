/** @file Outcome: Only source-valid, independently audited research becomes a durable repository artifact. */

import { FlowError, withStageElapsed } from '../shared/errors.ts';
import { elapsedMs, emptyStageTimings, type StageTimings } from '../shared/codex.ts';
import { readRepositoryEvidence } from '../shared/evidence.ts';
import { repositoryInvariant } from '../shared/repository.ts';
import {
  RESEARCH_REPORT_PROTOCOL,
  researchNextStep,
  type ResearchAudit,
  type ResearchDraft,
  type ResearchEvidence,
  type ResearchInput,
  type ResearchReport,
  type ResearchReportEvidence,
} from './contracts.ts';
import { CodexResearchAgent, type ResearchAgent } from './agent.ts';
import { persistResearchReport } from './artifact.ts';
import { runInImmutableRepositorySnapshot } from '../flow/isolation.ts';

export interface ResearchRunResult {
  report: ResearchReport;
  report_json: string;
  report_markdown: string;
  timings: StageTimings;
  artifact_persist_ms: number;
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
  if (input.external_sources === 'none') {
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

function validateDraftSources(input: ResearchInput, draft: ResearchDraft): void {
  for (const [index, finding] of draft.findings.entries()) {
    validateEvidence(input, finding.evidence, `research draft.findings[${index}].evidence`);
  }
}

function validateAuditSources(input: ResearchInput, audit: ResearchAudit): void {
  for (const [index, finding] of audit.findings.entries()) {
    validateEvidence(input, finding.evidence, `research audit.findings[${index}].evidence`);
  }
  if (!audit.findings.length && !audit.unknowns.length) {
    throw new FlowError(
      'research audit must contain a finding or an explicit unknown',
      'evidence_error',
    );
  }
}

/** Seals current repository evidence so later workflows can reject stale citations. */
function sealEvidence(input: ResearchInput, evidence: ResearchEvidence): ResearchReportEvidence {
  if (evidence.kind === 'web') return { ...evidence, kind: 'web' };
  const snapshot = readRepositoryEvidence(
    input.repo,
    evidence.source,
    evidence.locator,
    'research evidence',
  );
  return {
    ...evidence,
    kind: 'repository',
    ...snapshot,
  };
}

/** Executes a stable-snapshot investigation and writes JSON first-class evidence plus its Markdown view. */
export async function runResearch(
  input: ResearchInput,
  agent: ResearchAgent = new CodexResearchAgent(),
): Promise<ResearchRunResult> {
  const timings: StageTimings = emptyStageTimings();
  const before = repositoryInvariant(input.repo);
  const snapshotStarted = performance.now();
  const staged = await runInImmutableRepositorySnapshot(input.repo, async (snapshotRepo) => {
    timings.repository_snapshot_ms = elapsedMs(snapshotStarted);
    const modelInput = { ...input, repo: snapshotRepo };
    const investigateStarted = performance.now();
    let draft: ResearchDraft;
    try {
      draft = await agent.investigate(modelInput);
    } catch (error) {
      timings.investigator_model_call_ms = elapsedMs(investigateStarted);
      throw withStageElapsed(
        error,
        'research investigator model call',
        timings.investigator_model_call_ms,
      );
    }
    timings.investigator_model_call_ms = elapsedMs(investigateStarted);
    Object.assign(timings, agent.lastTimings);
    const draftValidationStarted = performance.now();
    try {
      validateDraftSources({ ...input, repo: snapshotRepo }, draft);
    } catch (error) {
      timings.controller_evidence_validation_ms += elapsedMs(draftValidationStarted);
      throw withStageElapsed(
        error,
        'research draft evidence validation',
        timings.controller_evidence_validation_ms,
      );
    }
    timings.controller_evidence_validation_ms += elapsedMs(draftValidationStarted);
    const auditStarted = performance.now();
    let audit: ResearchAudit;
    try {
      audit = await agent.audit(modelInput, draft);
    } catch (error) {
      timings.auditor_model_call_ms = elapsedMs(auditStarted);
      throw withStageElapsed(error, 'research auditor model call', timings.auditor_model_call_ms);
    }
    timings.auditor_model_call_ms = elapsedMs(auditStarted);
    Object.assign(timings, agent.lastTimings);
    const auditValidationStarted = performance.now();
    try {
      validateAuditSources({ ...input, repo: snapshotRepo }, audit);
    } catch (error) {
      timings.controller_evidence_validation_ms += elapsedMs(auditValidationStarted);
      throw withStageElapsed(
        error,
        'research audit evidence validation',
        timings.controller_evidence_validation_ms,
      );
    }
    timings.controller_evidence_validation_ms += elapsedMs(auditValidationStarted);
    const findings = audit.findings.map((finding, index) => ({
      ...finding,
      id: `F-${String(index + 1).padStart(3, '0')}`,
      evidence: finding.evidence.map((item) =>
        sealEvidence({ ...input, repo: snapshotRepo }, item),
      ),
    }));
    return { audit, findings };
  });
  const generatedAt = new Date();
  const report: ResearchReport = {
    protocol: RESEARCH_REPORT_PROTOCOL,
    generated_at: generatedAt.toISOString(),
    question: input.question,
    mode: input.mode,
    language: input.language,
    scope_paths: input.scope_paths,
    external_sources: input.external_sources,
    repository: {
      head: before.head,
      dirty: Object.keys(before.changes).length > 0,
    },
    answer: staged.audit.answer,
    findings: staged.findings,
    rejected: staged.audit.rejected,
    unknowns: staged.audit.unknowns,
    limitations: staged.audit.limitations,
    next_step: researchNextStep(input.mode),
    timings,
  };
  const persistStarted = performance.now();
  const paths = persistResearchReport(input.repo, report);
  return {
    report,
    report_json: paths.json,
    report_markdown: paths.markdown,
    timings,
    artifact_persist_ms: elapsedMs(persistStarted),
  };
}
