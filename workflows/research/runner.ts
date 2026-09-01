#!/usr/bin/env bun
/** @file Outcome: One explicit command turns a closed research question into verified JSON and Markdown artifacts. */

import { clearIntent, loadIntent, requireResearchIntent } from '../invocation.ts';
import { parseCommandWithRepeatable, requireExactFlags } from '../shared/cli.ts';
import { RESEARCH_COMMAND, isMainModule } from '../shared/environment.ts';
import { FlowError } from '../shared/errors.ts';
import { runCli } from '../shared/runtime.ts';
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
    language: 'japanese';
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
}

/** Exposes the authoring contract without starting a workflow or model. */
export function describeResearch(): ResearchDescription {
  return {
    protocol: RESEARCH_DESCRIPTION_PROTOCOL,
    outcome:
      'A source-valid answer, explicit unknowns, and an independently audited handoff artifact.',
    cli: {
      describe: `${RESEARCH_COMMAND} describe`,
      run: `${RESEARCH_COMMAND} run --question <text> --mode <understand|plan|diagnose> --language <english|japanese> [--scope-path <repo-relative-path>] [--external-sources <none|primary|broad>]`,
      task_binding: 'hook-injected',
    },
    input_template: {
      protocol: RESEARCH_INPUT_PROTOCOL,
      repo: '/absolute/git-root',
      question: 'One answerable project or technical question',
      mode: 'understand',
      scope_paths: [],
      external_sources: 'none',
      language: 'japanese',
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
  question: string,
  mode: string,
  language: string,
  scopePaths: string | string[] | undefined,
  externalSources: string,
  agent?: ResearchAgent,
): Promise<ResearchCommandResult> {
  const intent = loadIntent(runId);
  if (!intent || intent.workflow !== 'research')
    throw new FlowError('explicit $research invocation is required');
  requireResearchIntent(runId, intent.repo);
  const input = validateResearchInput({
    protocol: RESEARCH_INPUT_PROTOCOL,
    repo: intent.repo,
    question,
    mode,
    scope_paths: scopePaths ? (Array.isArray(scopePaths) ? scopePaths : [scopePaths]) : [],
    external_sources: externalSources,
    language,
  });
  clearIntent(runId);
  const result = await runResearch(input, agent);
  return {
    protocol: RESEARCH_RESULT_PROTOCOL,
    status: 'completed',
    report_json: result.report_json,
    report_markdown: result.report_markdown,
    findings: result.report.findings.length,
    unknowns: result.report.unknowns.length,
    next_step: result.report.next_step,
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<ResearchDescription | ResearchCommandResult> {
  const { command, flags } = parseCommandWithRepeatable(argv, ['--scope-path']);
  if (command === 'describe') {
    requireExactFlags(flags, []);
    return describeResearch();
  }
  if (command === 'run') {
    requireExactFlags(flags, [
      '--question',
      '--mode',
      '--language',
      '--external-sources',
      '--run-id',
    ]);
    return runResearchWorkflow(
      flags['--run-id'] as string,
      flags['--question'] as string,
      flags['--mode'] as string,
      flags['--language'] as string,
      flags['--scope-path'],
      flags['--external-sources'] as string,
    );
  }
  throw new FlowError(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  runCli(main, RESEARCH_RESULT_PROTOCOL);
}
