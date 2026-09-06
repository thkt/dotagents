#!/usr/bin/env bun
/** @file Outcome: One explicit command validates and publishes one exact issue draft. */

import { stopPendingIntent } from '../runtime/invocation.ts';
import { parseCommand, requireExactFlags, runCli } from '../runtime/cli.ts';
import { ISSUE_COMMAND, isMainModule } from '../runtime/environment.ts';
import { FlowError } from '../shared/errors.ts';

import { ProgressReporter, workflowProgress } from '../shared/progress.ts';
import { ISSUE_DESCRIPTION_PROTOCOL, ISSUE_RESULT_PROTOCOL } from './contracts.ts';
import type { IssueGateway } from './github.ts';
import type { IssueAgent } from './agent.ts';
import { runIssue } from './lifecycle.ts';

interface IssueDescription {
  protocol: typeof ISSUE_DESCRIPTION_PROTOCOL;
  outcome: string;
  cli: {
    describe: string;
    draft: string;
    stop: string;
    task_binding: 'hook-injected';
  };
  input_template: {
    repo: string;
    mode: 'create';
    think_report: string;
    title: string;
    prose: string;
    plan_markdown: string;
  };
  update_template: {
    repo: string;
    mode: 'update';
    think_report: string;
    target_issue: number;
    title: string;
    prose: string;
    plan_markdown: string;
  };
  contracts: {
    source: string;
    missing_source: string;
    preview: string;
    publish: string;
    plan_markdown: string;
  };
}

export interface IssuePublishCommandResult {
  protocol: typeof ISSUE_RESULT_PROTOCOL;
  status: 'published';
  issue_number: number;
  url: string;
  build_source: {
    repo: string;
    issue_number: number;
  };
  next_step: 'build';
}

export interface IssueStopCommandResult {
  protocol: typeof ISSUE_RESULT_PROTOCOL;
  status: 'blocked';
  classification: 'missing_decision';
  error: 'ready Think artifact is required before Issue publication';
  next_step: 'think';
}

type IssueCommandResult = IssuePublishCommandResult | IssueStopCommandResult;

/** Exposes the human decisions while leaving Plan rendering and publication mechanics to code. */
export function describeIssue(): IssueDescription {
  return {
    protocol: ISSUE_DESCRIPTION_PROTOCOL,
    outcome:
      'Research-backed prose and one reviewed Plan are published as a readable, build-ready GitHub issue.',
    cli: {
      describe: `${ISSUE_COMMAND} describe`,
      draft: `${ISSUE_COMMAND} draft --input <absolute-json>`,
      stop: `${ISSUE_COMMAND} stop --input <hook-supplied-json>`,
      task_binding: 'hook-injected',
    },
    input_template: {
      repo: '/absolute/git-root',
      mode: 'create',
      think_report: '/absolute/private-think-report.json',
      title: 'Concise title without a task-type prefix',
      prose: 'Human-readable issue context in the configured language',
      plan_markdown: 'Optional faithful Plan display body in the configured language',
    },
    update_template: {
      repo: '/absolute/git-root',
      mode: 'update',
      think_report: '/absolute/private-think-report.json',
      target_issue: 123,
      title: 'Updated concise title',
      prose: 'Updated human-readable issue context in the configured language',
      plan_markdown: 'Optional faithful Plan display body in the configured language',
    },
    contracts: {
      source: 'think_report must contain a ready Plan',
      plan_markdown:
        'Optional presentation only: translate the complete ready Think Plan outcome, test command, unit goals, files, contracts and acceptance checks in the same order into the configured language used for the Issue title and prose. Preserve identifiers, test_command and file paths verbatim. Supply only the display body with H3 or smaller headings; omit H1/H2, fences and details/summary tags. The runtime adds the Plan heading and unchanged canonical JSON. Omit this field to use the existing English-label renderer.',
      missing_source:
        'stop consumes the pending intent and publication approval without creating an input or writing to GitHub',
      preview:
        'draft passes static validation and independent fidelity review; corrections are bounded and resumable',
      publish:
        'one accepted create or update is written and verified; uncertain create outcomes block without retry, known targets are reconciled on resume',
    },
  };
}

/** Stops an Issue invocation that cannot select the required ready Think artifact. */
export function stopIssueWorkflow(runId: string, inputFile: string): IssueStopCommandResult {
  stopPendingIntent(runId, 'issue', inputFile, 'issue input');
  return {
    protocol: ISSUE_RESULT_PROTOCOL,
    status: 'blocked',
    classification: 'missing_decision',
    error: 'ready Think artifact is required before Issue publication',
    next_step: 'think',
  };
}

/** Validates and publishes only the issue input armed for this Codex task. */
export async function draftIssueWorkflow(
  runId: string,
  inputFile: string,
  gateway?: IssueGateway,
  progress: ProgressReporter = workflowProgress,
  agent?: IssueAgent,
): Promise<IssuePublishCommandResult> {
  const published = await progress.run({ workflow: 'issue', stage: 'issue_draft' }, () =>
    runIssue(runId, inputFile, gateway, agent, progress),
  );
  return {
    protocol: ISSUE_RESULT_PROTOCOL,
    status: 'published',
    issue_number: published.issue.number,
    url: published.issue.url,
    build_source: {
      repo: published.repo,
      issue_number: published.issue.number,
    },
    next_step: 'build',
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<IssueDescription | IssueCommandResult> {
  const { command, flags } = parseCommand(argv);
  if (command === 'describe') {
    requireExactFlags(flags, []);
    return describeIssue();
  }
  if (command === 'draft') {
    requireExactFlags(flags, ['--input', '--run-id']);
    return draftIssueWorkflow(flags['--run-id']!, flags['--input']!);
  }
  if (command === 'stop') {
    requireExactFlags(flags, ['--input', '--run-id']);
    return stopIssueWorkflow(flags['--run-id']!, flags['--input']!);
  }
  throw new FlowError(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  runCli(main, ISSUE_RESULT_PROTOCOL);
}
