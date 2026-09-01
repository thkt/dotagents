#!/usr/bin/env bun
/** @file Outcome: One explicit command turns a closed research question into verified JSON and Markdown artifacts. */

import { clearIntent, requireResearchIntent } from '../invocation.ts';
import { parseCommand, requireExactFlags } from '../shared/cli.ts';
import { RESEARCH_COMMAND, isMainModule } from '../shared/environment.ts';
import {
  requireConfiguredLanguage,
  resolveConfiguredLanguage,
  type ConfiguredLanguage,
} from '../shared/language.ts';
import { FlowError } from '../shared/errors.ts';
import { readAbsoluteJson, runCli } from '../shared/runtime.ts';
import {
  RESEARCH_DESCRIPTION_PROTOCOL,
  RESEARCH_INPUT_PROTOCOL,
  RESEARCH_RESULT_PROTOCOL,
  validateResearchInput,
} from './contracts.ts';
import { runResearch, type ResearchRunResult } from './pipeline.ts';
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
    protocol: typeof RESEARCH_INPUT_PROTOCOL;
    repo: string;
    question: string;
    mode: 'understand';
    scope_paths: string[];
    external_sources: 'none';
    language: ConfiguredLanguage;
  };
  contracts: {
    mode: string;
    scope_paths: string;
    external_sources: string;
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
  next_step: ResearchRunResult['report']['next_step'];
  context_status: ResearchRunResult['context_status'];
}

/** Exposes the authoring contract without starting a workflow or model. */
export function describeResearch(
  language: ConfiguredLanguage = resolveConfiguredLanguage('japanese'),
): ResearchDescription {
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
      protocol: RESEARCH_INPUT_PROTOCOL,
      repo: '/absolute/git-root',
      question: 'One answerable project or technical question',
      mode: 'understand',
      scope_paths: [],
      external_sources: 'none',
      language,
    },
    contracts: {
      mode: 'understand completes; plan hands off to think; diagnose hands off to fix',
      scope_paths:
        'empty means the repository; otherwise every repository citation stays inside these paths',
      external_sources: 'none, primary, or broad',
      artifacts:
        'private Codex state holds authoritative JSON with sealed repository citations and paired Markdown',
    },
  };
}

/** Runs only the research input armed for this Codex task, then consumes its intent. */
export async function runResearchWorkflow(
  runId: string,
  inputFile: string,
  agent?: ResearchAgent,
): Promise<ResearchCommandResult> {
  const input = validateResearchInput(readAbsoluteJson(inputFile, 'research'));
  requireResearchIntent(runId, input.repo, inputFile);
  requireConfiguredLanguage(input.language);
  const result = await runResearch(input, agent);
  clearIntent(runId);
  return {
    protocol: RESEARCH_RESULT_PROTOCOL,
    status: 'completed',
    report_json: result.report_json,
    report_markdown: result.report_markdown,
    findings: result.report.findings.length,
    unknowns: result.report.unknowns.length,
    next_step: result.report.next_step,
    context_status: result.context_status,
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
