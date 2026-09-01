#!/usr/bin/env bun
/** @file Outcome: One explicit command turns a change request into a reviewed decision or a concrete research route. */

import { clearIntent, loadIntent, requireThinkIntent } from '../invocation.ts';
import { parseCommandWithRepeatable, requireExactFlags } from '../shared/cli.ts';
import { isMainModule, THINK_COMMAND } from '../shared/environment.ts';
import { FlowError } from '../shared/errors.ts';
import { runCli } from '../shared/runtime.ts';
import {
  THINK_DESCRIPTION_PROTOCOL,
  THINK_INPUT_PROTOCOL,
  THINK_RESULT_PROTOCOL,
  validateThinkInput,
} from './contracts.ts';
import type { ThinkAgent } from './agent.ts';
import { runThink } from './pipeline.ts';

interface ThinkDescription {
  protocol: typeof THINK_DESCRIPTION_PROTOCOL;
  outcome: string;
  cli: { describe: string; run: string; task_binding: 'hook-injected' };
  input_template: {
    protocol: typeof THINK_INPUT_PROTOCOL;
    repo: string;
    request: string;
    task_type: 'feature';
    research_reports: string[];
    language: 'japanese';
  };
  contracts: {
    research_reports: string;
    readiness: string;
    artifacts: string;
  };
}

export interface ThinkCommandResult {
  protocol: typeof THINK_RESULT_PROTOCOL;
  status: 'completed';
  readiness: 'ready' | 'research_required' | 'blocked';
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
      run: `${THINK_COMMAND} run --request <text> --task-type <bug|feature|docs|chore> --language <english|japanese> [--research-report <absolute-json>]`,
      task_binding: 'hook-injected',
    },
    input_template: {
      protocol: THINK_INPUT_PROTOCOL,
      repo: '/absolute/git-root',
      request: 'One change whose outcome needs an implementation decision',
      task_type: 'feature',
      research_reports: [],
      language: 'japanese',
    },
    contracts: {
      research_reports:
        'optional absolute JSON paths returned by planning-mode codex-research runs',
      readiness:
        'ready hands off a build-contract-compatible plan to issue; research_required returns no plan',
      artifacts:
        'private Codex state holds authoritative JSON and paired Markdown without changing the worktree',
    },
  };
}

/** Runs only the think input armed for this Codex task, then consumes its intent. */
export async function runThinkWorkflow(
  runId: string,
  request: string,
  taskType: string,
  language: string,
  researchReports: string | string[] | undefined,
  agent?: ThinkAgent,
): Promise<ThinkCommandResult> {
  const intent = loadIntent(runId);
  if (!intent || intent.workflow !== 'think')
    throw new FlowError('explicit $think invocation is required');
  requireThinkIntent(runId, intent.repo);
  const input = validateThinkInput({
    protocol: THINK_INPUT_PROTOCOL,
    repo: intent.repo,
    request,
    task_type: taskType,
    research_reports: researchReports
      ? Array.isArray(researchReports)
        ? researchReports
        : [researchReports]
      : [],
    language,
  });
  clearIntent(runId);
  const result = await runThink(input, agent);
  return {
    protocol: THINK_RESULT_PROTOCOL,
    status: 'completed',
    readiness: result.report.readiness,
    report_json: result.report_json,
    report_markdown: result.report_markdown,
    units: result.report.plan?.units.length ?? 0,
    next_step: result.report.next_step,
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<ThinkDescription | ThinkCommandResult> {
  const { command, flags } = parseCommandWithRepeatable(argv, ['--research-report']);
  if (command === 'describe') {
    requireExactFlags(flags, []);
    return describeThink();
  }
  if (command === 'run') {
    requireExactFlags(flags, ['--request', '--task-type', '--language', '--run-id']);
    return runThinkWorkflow(
      flags['--run-id'] as string,
      flags['--request'] as string,
      flags['--task-type'] as string,
      flags['--language'] as string,
      flags['--research-report'],
    );
  }
  throw new FlowError(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  runCli(main, THINK_RESULT_PROTOCOL);
}
