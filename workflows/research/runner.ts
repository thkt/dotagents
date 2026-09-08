#!/usr/bin/env bun
/** @file Outcome: One explicit command turns a closed research question into verified JSON and Markdown artifacts. */

import { parseCommand, requireExactFlags, runCli } from '../runtime/cli.ts';
import { RESEARCH_COMMAND, isMainModule } from '../runtime/environment.ts';
import { FlowError } from '../shared/errors.ts';

import { RESEARCH_DESCRIPTION_PROTOCOL, RESEARCH_RESULT_PROTOCOL } from './contracts.ts';
import { runResearch } from './pipeline.ts';
import type { ResearchAgent } from './agent.ts';

interface ResearchDescription {
  protocol: typeof RESEARCH_DESCRIPTION_PROTOCOL;
  outcome: string;
  cli: {
    describe: string;
    run: string;
    task_binding: 'hook-injected';
  };
  input_template: {
    repo: string;
    question: string;
    scope_paths: string[];
    allow_external_sources: false;
  };
  contracts: {
    scope_paths: string;
    subquestions: string;
    allow_external_sources: string;
    artifacts: string;
    retained_child_report: string;
  };
}

interface ResearchCompletedResult {
  protocol: typeof RESEARCH_RESULT_PROTOCOL;
  status: 'completed';
  report_json: string;
  report_markdown: string;
  findings: number;
  unknowns: number;
  next_step: 'think';
}

export type ResearchCommandResult =
  | ResearchCompletedResult
  | (import('../runtime/clarification.ts').WaitingResult & {
      protocol: typeof RESEARCH_RESULT_PROTOCOL;
      report_json?: never;
      report_markdown?: never;
    });

/** Exposes the authoring contract without starting a workflow or model. */
export function describeResearch(): ResearchDescription {
  return {
    protocol: RESEARCH_DESCRIPTION_PROTOCOL,
    outcome:
      'A source-valid answer, explicit unknowns, and an independently audited handoff artifact.',
    cli: {
      describe: `${RESEARCH_COMMAND} describe`,
      run: `${RESEARCH_COMMAND} run --input <absolute-json>`,
      task_binding: 'hook-injected',
    },
    input_template: {
      repo: '/absolute/git-root',
      question: 'One answerable project or technical question',
      scope_paths: [],
      allow_external_sources: false,
    },
    contracts: {
      subquestions:
        'Optional one or two distinct independently answerable parts of question. Both retain the original scope and permissions; omission uses one investigator with no extra planning call.',
      scope_paths:
        'empty means the repository; otherwise every repository citation stays inside these paths',
      allow_external_sources:
        'false keeps research repository-only; true permits external evidence with primary sources preferred',
      retained_child_report:
        'Optional explicit original private child JSON path. Requires readable completed same-repository child state, ownership and independent audit. Captured as dated context at startup; fresh standalone investigation and both audits are mandatory before sharing.',
      artifacts:
        'Standalone Research returns unignored research/records/<research_id>.json and research/reports/<research_id>.md for human review and commit, independent of CODEX_FLOW_ARTIFACT_DIR. Automatic children return private audited evidence only. Canonical originals supply the best-effort private Knowledge index. Resume reconciles owned interrupted pairs; incompatible state requires its original runtime or a new task. Research never stages, commits, pushes or publishes Issues; none is Build authority',
    },
  };
}

/** Runs only the research input armed for this Codex task, then consumes its intent. */
export async function runResearchWorkflow(
  runId: string,
  inputFile: string,
  agent?: ResearchAgent,
): Promise<ResearchCommandResult> {
  const result = await runResearch(runId, inputFile, agent);
  if ('status' in result && result.status === 'waiting')
    return {
      protocol: RESEARCH_RESULT_PROTOCOL,
      status: 'waiting',
      question: result.question,
      owner: result.owner,
    };
  if (!('report' in result)) throw new FlowError('Research returned an invalid result');
  return {
    protocol: RESEARCH_RESULT_PROTOCOL,
    status: 'completed',
    report_json: result.report_json,
    report_markdown: result.report_markdown,
    findings: result.report.findings.length,
    unknowns: result.report.unknowns.length,
    next_step: 'think',
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<ResearchDescription | ResearchCommandResult> {
  const { command, flags } = parseCommand(argv);
  if (command === 'describe') {
    requireExactFlags(flags, []);
    return describeResearch();
  }
  if (command === 'run') {
    requireExactFlags(flags, ['--input', '--run-id']);
    return runResearchWorkflow(flags['--run-id']!, flags['--input']!);
  }
  throw new FlowError(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  runCli(main, RESEARCH_RESULT_PROTOCOL);
}
