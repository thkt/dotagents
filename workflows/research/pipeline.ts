/** @file Outcome: Only source-valid, independently audited research becomes a durable repository artifact. */

import * as fs from 'node:fs';
import path from 'node:path';

import { FlowError } from '../shared/errors.ts';
import { readRepositoryEvidence } from '../shared/evidence.ts';
import { repositoryInvariant, sameWorkflowRepositoryInvariant } from '../shared/repository.ts';
import {
  RESEARCH_REPORT_PROTOCOL,
  parseResearchReport,
  researchNextStep,
  type ResearchAudit,
  type ResearchDraft,
  type ResearchEvidence,
  type ResearchInput,
  type ResearchReport,
  type ResearchReportEvidence,
} from './contracts.ts';
import { CodexResearchAgent, type PriorResearchSummary, type ResearchAgent } from './agent.ts';
import { researchArtifactDirectory } from '../shared/storage.ts';
import { persistResearchReport } from './artifact.ts';
import { compileContext } from '../knowledge/context.ts';
import { emptyStageTimings } from '../shared/codex.ts';
import { withRepositorySnapshot } from '../flow/isolation.ts';

export interface ResearchRunResult {
  report: ResearchReport;
  report_json: string;
  report_markdown: string;
  context_status: 'loaded' | 'degraded';
}

const PRIOR_REPORT_LIMIT = 20;

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

function validateAuditSources(
  input: ResearchInput,
  audit: ResearchAudit,
  prior: PriorResearchSummary[],
): void {
  for (const [index, finding] of audit.findings.entries()) {
    validateEvidence(input, finding.evidence, `research audit.findings[${index}].evidence`);
  }
  const available = new Set(prior.map((item) => item.path));
  const invalid = audit.prior_reports.filter((item) => !available.has(item));
  if (invalid.length) {
    throw new FlowError(
      `research audit cited unavailable prior reports: ${invalid.join(', ')}`,
      'evidence_error',
    );
  }
  if (!audit.findings.length && !audit.unknowns.length) {
    throw new FlowError(
      'research audit must contain a finding or an explicit unknown',
      'evidence_error',
    );
  }
}

function readPriorResearch(repo: string): PriorResearchSummary[] {
  const directory = researchArtifactDirectory(repo);
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new FlowError('the research artifact path must be a directory', 'state_error');
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, PRIOR_REPORT_LIMIT)
    .flatMap(({ file }) => {
      try {
        const value = parseResearchReport(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
        return [
          {
            path: path.basename(file),
            question: value.question,
          },
        ];
      } catch {
        return [];
      }
    });
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
  const before = repositoryInvariant(input.repo);
  const { audit, contextLoad, findings } = await withRepositorySnapshot(
    input.repo,
    async (snapshotRepo) => {
      const validationInput = { ...input, repo: snapshotRepo };
      const prior = readPriorResearch(input.repo);
      let contextLoad: ReturnType<typeof compileContext>;
      try {
        contextLoad = compileContext(input.repo, 'research');
      } catch {
        contextLoad = { status: 'degraded', entries: [] };
      }
      const context = contextLoad.entries
        .filter((e) => e.kind === 'knowledge')
        .map(({ id, statement, source_artifact, source_id, status }) => ({
          id,
          kind: 'knowledge' as const,
          status: status as 'active' | 'review_required',
          statement,
          source_artifact,
          source_id,
        }));
      const draft = await agent.investigate(input, prior, context, snapshotRepo);
      validateDraftSources(validationInput, draft);
      const audit = await agent.audit(input, draft, prior, context, snapshotRepo);
      validateAuditSources(validationInput, audit, prior);
      const findings = audit.findings.map((finding, index) => ({
        ...finding,
        id: `F-${String(index + 1).padStart(3, '0')}`,
        evidence: finding.evidence.map((item) => sealEvidence(validationInput, item)),
      }));
      return { audit, contextLoad, findings };
    },
  );
  if (!sameWorkflowRepositoryInvariant(before, repositoryInvariant(input.repo))) {
    throw new FlowError('repository changed while research was running', 'state_error');
  }
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
    answer: audit.answer,
    findings,
    rejected: audit.rejected,
    unknowns: audit.unknowns,
    limitations: audit.limitations,
    prior_reports: audit.prior_reports,
    next_step: researchNextStep(input.mode),
    timings: emptyStageTimings(),
  };
  const paths = persistResearchReport(input.repo, report);
  return {
    report,
    report_json: paths.json,
    report_markdown: paths.markdown,
    context_status: contextLoad.status,
  };
}
