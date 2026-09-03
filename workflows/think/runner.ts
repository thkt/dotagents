#!/usr/bin/env bun
/** @file Outcome: One explicit command turns a change request into a reviewed decision or a concrete research route. */

import { consumeIntentAfter, requireThinkIntent } from '../invocation.ts';
import { parseCommand, requireExactFlags } from '../shared/cli.ts';
import { isMainModule, THINK_COMMAND } from '../shared/environment.ts';
import { FlowError } from '../shared/errors.ts';
import { readAbsoluteJson, runCli } from '../shared/runtime.ts';
import {
  THINK_DESCRIPTION_PROTOCOL,
  THINK_RESULT_PROTOCOL,
  thinkNextStep,
  validateThinkInput,
} from './contracts.ts';
import type { ThinkAgent } from './agent.ts';
import { runThink } from './pipeline.ts';

interface ThinkDescription {
  protocol: typeof THINK_DESCRIPTION_PROTOCOL;
  outcome: string;
  cli: { describe: string; run: string; task_binding: 'hook-injected' };
  input_template: {
    repo: string;
    request: string;
    research_reports: string[];
  };
  contracts: {
    research_reports: string;
    result: string;
    artifacts: string;
  };
}

export interface ThinkCommandResult {
  protocol: typeof THINK_RESULT_PROTOCOL;
  status: 'ready' | 'research_required';
  report_json: string;
  report_markdown: string;
  units: number;
  next_step: 'issue' | 'research';
}

/** Exposes the authoring boundary without starting a model or workflow. */
export function describeThink(): ThinkDescription {
  return {
    protocol: THINK_DESCRIPTION_PROTOCOL,
    outcome:
      'A source-backed decision is either issue-ready or routed to one concrete research gap.',
    cli: {
      describe: `${THINK_COMMAND} describe`,
      run: `${THINK_COMMAND} run --input <absolute-json>`,
      task_binding: 'hook-injected',
    },
    input_template: {
      repo: '/absolute/git-root',
      request: 'One change whose outcome needs an implementation decision',
      research_reports: [],
    },
    contracts: {
      research_reports:
        'optional selected Research artifact paths or basenames; related Knowledge is supplied automatically',
      result:
        'ready hands off a build-contract-compatible plan to issue; research_required returns no plan',
      artifacts:
        'repository-local ignored cache holds the JSON handoff and paired Markdown; it is not Build authority',
    },
  };
}

/** Runs only the think input armed for this Codex task, then consumes its intent. */
export async function runThinkWorkflow(
  runId: string,
  inputFile: string,
  agent?: ThinkAgent,
): Promise<ThinkCommandResult> {
  const request = validateThinkInput(readAbsoluteJson(inputFile, 'think'));
  requireThinkIntent(runId, request.repo, inputFile);
  const input = request;
  const result = await consumeIntentAfter(runId, () => runThink(input, agent));
  return {
    protocol: THINK_RESULT_PROTOCOL,
    status: result.report.status,
    report_json: result.report_json,
    report_markdown: result.report_markdown,
    units: result.report.plan?.units.length ?? 0,
    next_step: thinkNextStep(result.report.status),
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<ThinkDescription | ThinkCommandResult> {
  const { command, flags } = parseCommand(argv);
  if (command === 'describe') {
    requireExactFlags(flags, []);
    return describeThink();
  }
  if (command === 'run') {
    requireExactFlags(flags, ['--input', '--run-id']);
    return runThinkWorkflow(flags['--run-id']!, flags['--input']!);
  }
  throw new FlowError(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  runCli(main, THINK_RESULT_PROTOCOL);
}
