#!/usr/bin/env bun
/** @file Outcome: One explicit command turns a change request into a reviewed decision or a concrete research route. */

import { parseCommand, requireExactFlags, runCli } from '../runtime/cli.ts';
import { isMainModule, THINK_COMMAND } from '../runtime/environment.ts';
import { FlowError } from '../shared/errors.ts';

import { THINK_DESCRIPTION_PROTOCOL, THINK_RESULT_PROTOCOL, thinkNextStep } from './contracts.ts';
import type { StageAgents } from '../runtime/stage-return.ts';
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

interface ThinkCompletedResult {
  protocol: typeof THINK_RESULT_PROTOCOL;
  status: 'ready';
  report_json: string;
  report_markdown: string;
  units: number;
  next_step: 'issue' | 'research' | 'waiting';
}

export type ThinkCommandResult =
  | ThinkCompletedResult
  | (import('../runtime/clarification.ts').WaitingResult & {
      protocol: typeof THINK_RESULT_PROTOCOL;
      report_json?: never;
      report_markdown?: never;
    });

/** Exposes the authoring boundary without starting a model or workflow. */
export function describeThink(): ThinkDescription {
  return {
    protocol: THINK_DESCRIPTION_PROTOCOL,
    outcome: 'A verified ready Plan, or one independently accepted pending user-owned decision.',
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
        'ready hands off a verified Plan to Issue; waiting returns only the accepted question and its owner. Reviewed factual gaps run Research internally, then return to design and review.',
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
  children?: StageAgents,
): Promise<ThinkCommandResult> {
  const result = await runThink(runId, inputFile, agent, undefined, children);
  if ('status' in result) return { protocol: THINK_RESULT_PROTOCOL, ...result };
  if (!('report' in result)) throw new FlowError('Think returned an invalid result');
  return {
    protocol: THINK_RESULT_PROTOCOL,
    status: 'ready',
    report_json: result.report_json,
    report_markdown: result.report_markdown,
    units: result.report.plan?.units.length ?? 0,
    next_step: thinkNextStep(result.report.status) as 'issue' | 'research',
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
