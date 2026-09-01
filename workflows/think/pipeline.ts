/** @file Outcome: Only repository-valid, independently reviewed decisions become issue-ready think artifacts. */

import * as fs from 'node:fs';
import path from 'node:path';

import { describe as describeBuildPlan, validatePlan } from '../flow/build/plan.ts';
import { buildPlanValue, renderPlanMarkdown } from '../flow/build/authoring.ts';
import { revalidatePlan } from '../flow/build/revalidate.ts';
import { parseResearchReport } from '../research/contracts.ts';
import { readRepositoryEvidence, sha256 } from '../shared/evidence.ts';
import { errorMessage, FlowError } from '../shared/errors.ts';
import { elapsedMs, emptyStageTimings, type StageTimings } from '../shared/codex.ts';
import { realpathInside, repositoryInvariant } from '../shared/repository.ts';
import { researchArtifactDirectory } from '../shared/storage.ts';
import { persistThinkReport } from './artifact.ts';
import { runInImmutableRepositorySnapshot } from '../flow/isolation.ts';
import { CodexThinkAgent, type ThinkAgent, type ThinkResearchContext } from './agent.ts';
import {
  THINK_REPORT_PROTOCOL,
  type ThinkDecision,
  type ThinkDraft,
  type ThinkInput,
  type ThinkReport,
  type ThinkReportEvidence,
} from './contracts.ts';

export interface ThinkRunResult {
  report: ThinkReport;
  report_json: string;
  report_markdown: string;
  timings: StageTimings;
  artifact_persist_ms: number;
}

interface SelectedResearch {
  context: ThinkResearchContext;
  source_sha256: string;
}

function reportContext(
  repo: string,
  evidenceRepo: string,
  file: string,
  index: number,
): SelectedResearch {
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
        evidenceRepo,
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
  indexOffset = 0,
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
        id: `E-${String(index + indexOffset + 1).padStart(3, '0')}`,
        source_sha256: report.source_sha256,
      };
    }
    const snapshot = readRepositoryEvidence(repo, evidence.source, evidence.locator, label);
    return {
      ...evidence,
      id: `E-${String(index + indexOffset + 1).padStart(3, '0')}`,
      ...snapshot,
    };
  });
}

function issueTitle(input: ThinkInput): string {
  return input.task_type === 'bug' ? '[Bug] Think decision' : 'Think decision';
}

function validateAndSeal(
  input: ThinkInput,
  decision: ThinkDecision,
  research: readonly SelectedResearch[],
): ThinkReportEvidence[] {
  const blockers: string[] = [];
  if (decision.readiness === 'research_required') {
    if (!decision.research_questions.length)
      blockers.push('research_required decision must contain a research question');
  } else {
    if (decision.plan === null) blockers.push('ready decision must contain a plan');
    if (decision.research_questions.length)
      blockers.push('ready decision cannot contain unresolved research questions');
    if (!decision.alternatives.length)
      blockers.push('ready decision must retain a rejected alternative');
    if (!decision.evidence.length)
      blockers.push('ready decision must cite repository or selected research evidence');
    if (decision.plan && decision.outcome !== decision.plan.outcome)
      blockers.push('decision outcome and root cause must match the plan');
    if (decision.plan && decision.root_cause !== decision.plan.root_cause)
      blockers.push('decision outcome and root cause must match the plan');
    if (input.task_type === 'bug' && decision.root_cause === null)
      blockers.push('a ready bug decision requires an evidenced root cause');
    if (decision.plan) {
      const plan = buildPlanValue(decision.plan);
      const report = validatePlan({
        issue: 1,
        title: issueTitle(input),
        body: renderPlanMarkdown(decision.plan),
        plan,
      });
      blockers.push(...report.blockers, ...report.reason_codes);
      const drift = revalidatePlan(plan, input.repo);
      blockers.push(...drift.drift.map((item) => `plan drift: ${item.path}`));
    }
  }
  const evidence: ThinkReportEvidence[] = [];
  for (const [index, item] of decision.evidence.entries()) {
    try {
      evidence.push(
        sealEvidence(input.repo, { ...decision, evidence: [item] }, research, index)[0]!,
      );
    } catch (error) {
      blockers.push(`evidence[${index}]: ${errorMessage(error)}`);
    }
  }
  const unique = [...new Set(blockers)];
  if (unique.length) throw new FlowError(JSON.stringify(unique), 'decision_error');
  return evidence;
}

function proposalDecision(
  draft: ThinkDraft,
  findings: ThinkDecision['review_findings'],
): ThinkDecision {
  const blocking = findings.some((f) => f.severity === 'blocking');
  return {
    ...draft,
    readiness: blocking ? 'research_required' : draft.plan ? 'ready' : 'research_required',
    research_questions: blocking
      ? [
          ...draft.research_questions,
          ...findings.filter((f) => f.severity === 'blocking').map((f) => f.required_action),
        ]
      : draft.research_questions,
    plan: draft.plan,
    review_findings: findings.map((f) => ({
      ...f,
      disposition: blocking && f.severity === 'blocking' ? 'block_issue' : 'advisory',
    })),
    review_notes: findings.map((f) => `${f.severity}: ${f.statement} — ${f.required_action}`),
  };
}

/** Validates the designer proposal before semantic review; reviewer never rewrites it. */
async function reviewedDecision(
  input: ThinkInput,
  agentInput: ThinkInput,
  draft: ThinkDraft,
  selectedResearch: SelectedResearch[],
  buildContract: unknown,
  agent: ThinkAgent,
): Promise<{ decision: ThinkDecision; evidence: ThinkReportEvidence[] }> {
  const research = selectedResearch.map((item) => item.context);
  const proposal = proposalDecision(draft, []);
  validateAndSeal(input, proposal, selectedResearch);
  let findings;
  try {
    findings = await agent.review(agentInput, draft, research, buildContract);
  } catch (firstError) {
    findings = await agent.review(agentInput, draft, research, buildContract, {
      errors: [errorMessage(firstError)],
    });
  }
  const decision = proposalDecision(draft, findings);
  return { decision, evidence: validateAndSeal(input, decision, selectedResearch) };
}

/** Runs comparison and independent review against one immutable repository snapshot. */
export async function runThink(
  input: ThinkInput,
  agent: ThinkAgent = new CodexThinkAgent(),
): Promise<ThinkRunResult> {
  const timings: StageTimings = emptyStageTimings();
  const before = repositoryInvariant(input.repo);
  const snapshotStarted = performance.now();
  const staged = await runInImmutableRepositorySnapshot(input.repo, async (snapshotRepo) => {
    timings.repository_snapshot_ms = elapsedMs(snapshotStarted);
    const modelInput = { ...input, repo: snapshotRepo };
    const selectedResearch = input.research_reports.map((file, index) =>
      reportContext(input.repo, snapshotRepo, file, index),
    );
    const research = selectedResearch.map((item) => item.context);
    const buildContract = describeBuildPlan();
    const designStarted = performance.now();
    const draft = await agent.design(modelInput, research, buildContract);
    timings.designer_model_call_ms = elapsedMs(designStarted);
    Object.assign(timings, agent.lastTimings);
    const validationStarted = performance.now();
    const reviewed = await reviewedDecision(
      modelInput,
      modelInput,
      draft,
      selectedResearch,
      buildContract,
      agent,
    );
    timings.controller_evidence_validation_ms += elapsedMs(validationStarted);
    Object.assign(timings, agent.lastTimings);
    return { ...reviewed, draft, research };
  });
  const { decision, evidence, research } = staged;
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
    timings,
  };
  const persistStarted = performance.now();
  const paths = persistThinkReport(input.repo, report);
  return {
    report,
    report_json: paths.json,
    report_markdown: paths.markdown,
    timings,
    artifact_persist_ms: elapsedMs(persistStarted),
  };
}
