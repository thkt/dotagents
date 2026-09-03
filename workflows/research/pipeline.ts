/** @file Outcome: Only source-valid, independently audited research becomes a durable repository artifact. */

import { errorMessage, FlowError } from '../shared/errors.ts';
import { readRepositoryEvidence } from '../shared/evidence.ts';
import {
  RESEARCH_REPORT_PROTOCOL,
  type ResearchAudit,
  type ResearchEvidence,
  type ResearchInput,
  type ResearchReport,
} from './contracts.ts';
import { CodexResearchAgent, type ResearchAgent } from './agent.ts';
import { persistResearchReport } from './artifact.ts';
import { searchKnowledge } from '../knowledge/search.ts';
import { updateKnowledge } from '../knowledge/update.ts';
import { withRepositorySnapshot } from '../flow/isolation.ts';

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

/** Executes a stable-snapshot investigation and writes JSON first-class evidence plus its Markdown view. */
export async function runResearch(
  input: ResearchInput,
  agent: ResearchAgent = new CodexResearchAgent(),
): Promise<ResearchRunResult> {
  const { audit, findings } = await withRepositorySnapshot(input.repo, async (snapshotRepo) => {
    const validationInput = { ...input, repo: snapshotRepo };
    const knowledge = searchKnowledge(input.repo, input.question);
    const draft = await agent.investigate(input, knowledge, snapshotRepo);
    const audit = await agent.audit(input, draft, knowledge, snapshotRepo);
    validateAuditSources(validationInput, audit);
    const findings = audit.findings.map((finding, index) => ({
      ...finding,
      id: `F-${String(index + 1).padStart(3, '0')}`,
    }));
    return { audit, findings };
  });
  const generatedAt = new Date();
  const report: ResearchReport = {
    protocol: RESEARCH_REPORT_PROTOCOL,
    generated_at: generatedAt.toISOString(),
    question: input.question,
    scope_paths: input.scope_paths,
    answer: audit.answer,
    findings,
    rejected: audit.rejected,
    unknowns: audit.unknowns,
    limitations: audit.limitations,
  };
  const paths = persistResearchReport(input.repo, report);
  try {
    updateKnowledge(input.repo);
  } catch (error) {
    // Knowledge is rebuildable; its write failure must not invalidate persisted Research.
    process.stderr.write(`Knowledge update skipped: ${errorMessage(error)}\n`);
  }
  return {
    report,
    report_json: paths.json,
    report_markdown: paths.markdown,
  };
}
