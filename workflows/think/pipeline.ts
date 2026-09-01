/** @file Outcome: Only repository-valid, independently reviewed decisions become issue-ready think artifacts. */

import * as fs from 'node:fs';
import path from 'node:path';

import { describe as describeBuildPlan, validatePlan } from '../flow/build/plan.ts';
import { buildPlanValue, renderPlanMarkdown } from '../flow/build/authoring.ts';
import { revalidatePlan } from '../flow/build/revalidate.ts';
import { parseResearchReport } from '../research/contracts.ts';
import { readRepositoryEvidence, sha256 } from '../shared/evidence.ts';
import { errorCode, errorMessage, FlowError } from '../shared/errors.ts';
import {
  realpathInside,
  repositoryInvariant,
  sameWorkflowRepositoryInvariant,
} from '../shared/repository.ts';
import { researchArtifactDirectory } from '../shared/storage.ts';
import { persistThinkReport } from './artifact.ts';
import { compileContext } from '../knowledge/context.ts';
import {
  CodexThinkAgent,
  type ThinkAgent,
  type ThinkResearchContext,
  type ThinkContextSummary,
} from './agent.ts';
import {
  THINK_REPORT_PROTOCOL,
  type ThinkDecision,
  type ThinkDraft,
  type ThinkInput,
  type ThinkReport,
  type ThinkReportEvidence,
} from './contracts.ts';
import { emptyStageTimings } from '../shared/codex.ts';

export interface ThinkRunResult {
  report: ThinkReport;
  report_json: string;
  report_markdown: string;
  context_status: 'loaded' | 'degraded';
}

interface SelectedResearch {
  context: ThinkResearchContext;
  source_sha256: string;
}

function reportContext(repo: string, file: string, index: number): SelectedResearch {
  const label = `think input.research_reports[${index}]`;
  const directory = researchArtifactDirectory(repo);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    !realpathInside(directory, file) ||
    path.extname(file) !== '.json'
  ) {
    throw new FlowError(`${label} must name a research JSON artifact for this repository`);
  }
  const content = fs.readFileSync(file);
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new FlowError(`${label} must contain valid JSON`);
  }
  const report = parseResearchReport(raw);
  if (report.next_step !== 'think') {
    throw new FlowError(`${label} must be a planning research report`);
  }
  for (const [findingIndex, finding] of report.findings.entries()) {
    for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
      if (evidence.kind !== 'repository') continue;
      const evidenceLabel = `${label}.findings[${findingIndex}].evidence[${evidenceIndex}]`;
      const snapshot = readRepositoryEvidence(
        repo,
        evidence.source,
        evidence.locator,
        evidenceLabel,
      );
      if (evidence.source_sha256 !== snapshot.source_sha256) {
        throw new FlowError(`${evidenceLabel} is stale`, 'evidence_error');
      }
    }
  }
  return {
    context: {
      path: path.basename(file),
      question: report.question,
      answer: report.answer,
      findings: report.findings,
      unknowns: report.unknowns,
      limitations: report.limitations,
    },
    source_sha256: sha256(content),
  };
}

function sealEvidence(
  repo: string,
  decision: ThinkDecision,
  research: readonly SelectedResearch[],
): ThinkReportEvidence[] {
  return decision.evidence.map((evidence, index) => {
    const label = `think decision.evidence[${index}]`;
    if (evidence.kind === 'research') {
      const report = research.find((item) => item.context.path === evidence.source);
      if (!report)
        throw new FlowError(
          `${label}.source must name a selected research report`,
          'evidence_error',
        );
      if (!report.context.findings.some((finding) => finding.id === evidence.locator)) {
        throw new FlowError(
          `${label}.locator must name a finding in the selected research report`,
          'evidence_error',
        );
      }
      return {
        ...evidence,
        id: `E-${String(index + 1).padStart(3, '0')}`,
        source_sha256: report.source_sha256,
      };
    }
    const snapshot = readRepositoryEvidence(repo, evidence.source, evidence.locator, label);
    return {
      ...evidence,
      id: `E-${String(index + 1).padStart(3, '0')}`,
      ...snapshot,
    };
  });
}

function issueTitle(input: ThinkInput): string {
  return input.task_type === 'bug' ? '[Bug] Think decision' : 'Think decision';
}

function validateDecision(input: ThinkInput, decision: ThinkDecision): void {
  if (decision.readiness === 'research_required') {
    if (decision.plan !== null)
      throw new FlowError('research_required decision must not contain a plan', 'decision_error');
    if (!decision.research_questions.length) {
      throw new FlowError(
        'research_required decision must contain a research question',
        'decision_error',
      );
    }
    return;
  }
  if (decision.plan === null)
    throw new FlowError('ready decision must contain a plan', 'decision_error');
  if (decision.research_questions.length) {
    throw new FlowError(
      'ready decision cannot contain unresolved research questions',
      'decision_error',
    );
  }
  if (!decision.alternatives.length) {
    throw new FlowError('ready decision must retain a rejected alternative', 'decision_error');
  }
  if (!decision.evidence.length) {
    throw new FlowError(
      'ready decision must cite repository or selected research evidence',
      'decision_error',
    );
  }
  if (
    decision.outcome !== decision.plan.outcome ||
    decision.root_cause !== decision.plan.root_cause
  ) {
    throw new FlowError('decision outcome and root cause must match the plan', 'decision_error');
  }
  if (input.task_type === 'bug' && decision.root_cause === null) {
    throw new FlowError('a ready bug decision requires an evidenced root cause', 'decision_error');
  }
  const plan = buildPlanValue(decision.plan);
  const body = renderPlanMarkdown(decision.plan, input.language);
  const report = validatePlan({ issue: 1, title: issueTitle(input), body, plan });
  if (report.verdict !== 'pass') {
    throw new FlowError(
      `think plan violates the build contract: ${[...report.blockers, ...report.reason_codes].join('; ')}`,
      'decision_error',
    );
  }
  const revalidation = revalidatePlan(plan, input.repo);
  if (revalidation.verdict !== 'pass') {
    throw new FlowError(
      `think plan references missing or stale repository state: ${revalidation.drift.map((item) => item.path).join(', ')}`,
      'decision_error',
    );
  }
}

function validateAndSeal(
  input: ThinkInput,
  decision: ThinkDecision,
  research: readonly SelectedResearch[],
): ThinkReportEvidence[] {
  validateDecision(input, decision);
  return sealEvidence(input.repo, decision, research);
}

/** Gives one invalid final handoff back to the reviewer with the controller's concrete blockers. */
async function reviewedDecision(
  input: ThinkInput,
  draft: ThinkDraft,
  selectedResearch: SelectedResearch[],
  buildContract: unknown,
  agent: ThinkAgent,
  context: ThinkContextSummary[] = [],
): Promise<{ decision: ThinkDecision; evidence: ThinkReportEvidence[] }> {
  const research = selectedResearch.map((item) => item.context);
  const first = await agent.review(input, draft, research, buildContract, undefined, context);
  try {
    return { decision: first, evidence: validateAndSeal(input, first, selectedResearch) };
  } catch (error) {
    if (!['decision_error', 'evidence_error'].includes(errorCode(error) ?? '')) throw error;
    const second = await agent.review(
      input,
      draft,
      research,
      buildContract,
      {
        rejected: first,
        errors: [errorMessage(error)],
      },
      context,
    );
    return { decision: second, evidence: validateAndSeal(input, second, selectedResearch) };
  }
}

/** Runs comparison and independent review against one immutable repository snapshot. */
export async function runThink(
  input: ThinkInput,
  agent: ThinkAgent = new CodexThinkAgent(),
): Promise<ThinkRunResult> {
  const before = repositoryInvariant(input.repo);
  const selectedResearch = input.research_reports.map((file, index) =>
    reportContext(input.repo, file, index),
  );
  const research = selectedResearch.map((item) => item.context);
  const buildContract = describeBuildPlan();
  let contextLoad: ReturnType<typeof compileContext>;
  try {
    contextLoad = compileContext(input.repo, 'think');
  } catch {
    contextLoad = { status: 'degraded', entries: [] };
  }
  const context: ThinkContextSummary[] = contextLoad.entries
    .filter((e) => e.status === 'active')
    .map(({ id, kind, statement, source_artifact, source_id }) => ({
      id,
      kind,
      status: 'active',
      statement,
      source_artifact,
      source_id,
    }));
  const draft = await agent.design(input, research, buildContract, context);
  const { decision, evidence } = await reviewedDecision(
    input,
    draft,
    selectedResearch,
    buildContract,
    agent,
    context,
  );
  if (!sameWorkflowRepositoryInvariant(before, repositoryInvariant(input.repo))) {
    throw new FlowError('repository changed while think was running', 'state_error');
  }
  const report: ThinkReport = {
    protocol: THINK_REPORT_PROTOCOL,
    generated_at: new Date().toISOString(),
    request: input.request,
    task_type: input.task_type,
    language: input.language,
    repository: { head: before.head, dirty: Object.keys(before.changes).length > 0 },
    ...decision,
    evidence,
    research_reports: research.map((item) => item.path),
    next_step: decision.readiness === 'ready' ? 'issue' : 'research',
    timings: emptyStageTimings(),
  };
  const paths = persistThinkReport(input.repo, report);
  return {
    report,
    report_json: paths.json,
    report_markdown: paths.markdown,
    context_status: contextLoad.status,
  };
}
