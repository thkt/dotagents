#!/usr/bin/env bun
/** @file Outcome: One explicit command validates and publishes one exact issue draft. */

import {
  clearIntent,
  consumeIssueApproval,
  requireIssueIntent,
  stopPendingIntent,
} from '../invocation.ts';
import { parseCommand, requireExactFlags } from '../shared/cli.ts';
import { ISSUE_COMMAND, isMainModule } from '../shared/environment.ts';
import { FlowError } from '../shared/errors.ts';
import { readAbsoluteJson, runCli } from '../shared/runtime.ts';
import { ProgressReporter, workflowProgress } from '../shared/progress.ts';
import {
  ISSUE_DESCRIPTION_PROTOCOL,
  ISSUE_RESULT_PROTOCOL,
  validateIssueInput,
} from './contracts.ts';
import { GhIssueGateway, type IssueGateway } from './github.ts';
import { draftIssue, publishIssue } from './pipeline.ts';

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
    priority: 'medium';
  };
  attach_plan_template: {
    repo: string;
    mode: 'attach-plan';
    think_report: string;
    target_issue: number;
    priority: 'medium';
  };
  contracts: { source: string; missing_source: string; preview: string; publish: string };
}

export interface IssuePublishCommandResult {
  protocol: typeof ISSUE_RESULT_PROTOCOL;
  status: 'published';
  issue_number: number;
  url: string;
  receipt_json: string;
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
    outcome: 'One reviewed Plan is validated and published as a build-ready GitHub issue.',
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
      priority: 'medium',
    },
    attach_plan_template: {
      repo: '/absolute/git-root',
      mode: 'attach-plan',
      think_report: '/absolute/private-think-report.json',
      target_issue: 123,
      priority: 'medium',
    },
    contracts: {
      source: 'think_report must contain a ready Plan',
      missing_source:
        'stop consumes the pending intent and publication approval without creating an input or writing to GitHub',
      preview: 'draft is validated before publication',
      publish: 'the validated draft is published atomically from the caller perspective',
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
export function draftIssueWorkflow(
  runId: string,
  inputFile: string,
  gateway?: IssueGateway,
  progress: ProgressReporter = workflowProgress,
): IssuePublishCommandResult {
  const input = validateIssueInput(readAbsoluteJson(inputFile, 'issue'));
  requireIssueIntent(runId, input.repo, inputFile);
  const draftGateway = gateway ?? new GhIssueGateway();
  const result = progress.runSync({ workflow: 'issue', stage: 'issue_draft' }, () =>
    draftIssue(input, draftGateway),
  );
  consumeIssueApproval(runId, input.repo);
  clearIntent(runId);
  const publishGateway = gateway ?? new GhIssueGateway('issue-publication');
  const published = progress.runSync({ workflow: 'issue', stage: 'issue_publish' }, () =>
    publishIssue(result.draft_json, result.draft_sha256, publishGateway),
  );
  return {
    protocol: ISSUE_RESULT_PROTOCOL,
    status: 'published',
    issue_number: published.issue.number,
    url: published.issue.url,
    receipt_json: published.receipt_json,
    build_source: {
      repo: input.repo,
      issue_number: published.issue.number,
    },
    next_step: 'build',
  };
}

export function main(
  argv: string[] = process.argv.slice(2),
): IssueDescription | IssueCommandResult {
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
