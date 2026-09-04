/** @file Outcome: Research and current repository context become one reviewed Plan or concrete research questions. */

import * as fs from 'node:fs';
import path from 'node:path';

import { validatePlan } from '../plan/validation.ts';
import { withRepositorySnapshot } from '../execution/repository-isolation.ts';
import { searchKnowledge } from '../research/knowledge.ts';
import { parseResearchReport } from '../research/contracts.ts';
import { errorCode, errorMessage, FlowError } from '../shared/errors.ts';
import { realpathInside } from '../shared/repository.ts';
import { researchArtifactDirectory } from '../runtime/storage.ts';
import { CodexThinkAgent, type ThinkAgent, type ThinkResearchContext } from './agent.ts';
import { persistThinkReport } from './artifact.ts';
import {
  THINK_PLAN_SCHEMA,
  THINK_REPORT_PROTOCOL,
  type ThinkDecision,
  type ThinkDraft,
  type ThinkInput,
  type ThinkReport,
} from './contracts.ts';

export interface ThinkRunResult {
  report: ThinkReport;
  report_json: string;
  report_markdown: string;
}

function reportContext(repo: string, file: string, index: number): ThinkResearchContext {
  const label = `think input.research_reports[${index}]`;
  const directory = researchArtifactDirectory(repo);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || !realpathInside(directory, file) || path.extname(file) !== '.json') {
    throw new FlowError(`${label} must name a readable research JSON artifact for this repository`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    throw new FlowError(`${label} must contain valid JSON`);
  }
  const report = parseResearchReport(raw);
  return {
    path: path.basename(file),
    generated_at: report.generated_at,
    question: report.question,
    answer: report.answer,
    findings: report.findings,
    unknowns: report.unknowns,
    limitations: report.limitations,
  };
}

function validateDecision(decision: ThinkDecision): void {
  if (decision.status === 'research_required') return;
  if (!decision.plan) throw new FlowError('ready decision must contain a plan', 'decision_error');
  const report = validatePlan(decision.plan);
  if (report.verdict !== 'pass') {
    throw new FlowError(
      `think plan violates the build contract: ${[...report.blockers, ...report.reason_codes].join('; ')}`,
      'decision_error',
    );
  }
}

/** Gives one invalid reviewed Plan back to the reviewer with concrete Build blockers. */
async function reviewedDecision(
  input: ThinkInput,
  draft: ThinkDraft,
  research: ThinkResearchContext[],
  knowledge: ThinkResearchContext[],
  buildContract: unknown,
  agent: ThinkAgent,
  snapshotRepo: string,
): Promise<ThinkDecision> {
  const first = await agent.review(
    input,
    draft,
    research,
    knowledge,
    buildContract,
    undefined,
    snapshotRepo,
  );
  try {
    validateDecision(first);
    return first;
  } catch (error) {
    if (errorCode(error) !== 'decision_error') throw error;
    const second = await agent.review(
      input,
      draft,
      research,
      knowledge,
      buildContract,
      { rejected: first, errors: [errorMessage(error)] },
      snapshotRepo,
    );
    validateDecision(second);
    return second;
  }
}

/** Runs design and independent review against one immutable read snapshot. */
export async function runThink(
  input: ThinkInput,
  agent: ThinkAgent = new CodexThinkAgent(),
): Promise<ThinkRunResult> {
  const { decision, research } = await withRepositorySnapshot(input.repo, async (snapshotRepo) => {
    const research = [...new Set(input.research_reports)].map((file, index) =>
      reportContext(input.repo, file, index),
    );
    const knowledge = searchKnowledge(
      input.repo,
      input.request,
      research.map((report) => report.path),
    ).flatMap((entry) =>
      entry.sources.flatMap((source) => {
        try {
          return [
            reportContext(
              input.repo,
              path.join(researchArtifactDirectory(input.repo), source.report),
              0,
            ),
          ];
        } catch {
          // A derived index may outlive its original report; optional context must not block Think.
          return [];
        }
      }),
    );
    const buildContract = { plan_schema: THINK_PLAN_SCHEMA };
    const draft = await agent.design(input, research, knowledge, buildContract, snapshotRepo);
    const decision = await reviewedDecision(
      input,
      draft,
      research,
      knowledge,
      buildContract,
      agent,
      snapshotRepo,
    );
    return { decision, research: [...research, ...knowledge] };
  });
  const report: ThinkReport = {
    protocol: THINK_REPORT_PROTOCOL,
    generated_at: new Date().toISOString(),
    request: input.request,
    ...decision,
    research_reports: research.map((item) => item.path),
  };
  const paths = persistThinkReport(input.repo, report);
  return {
    report,
    report_json: paths.json,
    report_markdown: paths.markdown,
  };
}
