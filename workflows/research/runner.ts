#!/usr/bin/env bun
/** @file Outcome: One explicit command turns a closed research question into verified JSON and Markdown artifacts. */

import { consumeIntentAfter, requireResearchIntent } from '../runtime/invocation.ts';
import { parseCommand, requireExactFlags, readAbsoluteJson, runCli } from '../runtime/cli.ts';
import { RESEARCH_COMMAND, isMainModule } from '../runtime/environment.ts';
import { FlowError } from '../shared/errors.ts';

import {
  RESEARCH_DESCRIPTION_PROTOCOL,
  RESEARCH_RESULT_PROTOCOL,
  validateResearchInput,
} from './contracts.ts';
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
    allow_external_sources: string;
    artifacts: string;
  };
}

export interface ResearchCommandResult {
  protocol: typeof RESEARCH_RESULT_PROTOCOL;
  status: 'completed';
  report_json: string;
  report_markdown: string;
  findings: number;
  unknowns: number;
  next_step: 'think';
}

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
      scope_paths:
        'empty means the repository; otherwise every repository citation stays inside these paths',
      allow_external_sources:
        'false keeps research repository-only; true permits external evidence with primary sources preferred',
      artifacts:
        'repository-local ignored cache holds the JSON handoff, paired Markdown, and automatically rebuilt Knowledge; none is Build authority',
    },
  };
}

/** Runs only the research input armed for this Codex task, then consumes its intent. */
export async function runResearchWorkflow(
  runId: string,
  inputFile: string,
  agent?: ResearchAgent,
): Promise<ResearchCommandResult> {
  const request = validateResearchInput(readAbsoluteJson(inputFile, 'research'));
  requireResearchIntent(runId, request.repo, inputFile);
  const input = request;
  const result = await consumeIntentAfter(runId, () => runResearch(input, agent));
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
