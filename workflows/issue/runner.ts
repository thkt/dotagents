#!/usr/bin/env bun
/** @file Outcome: One explicit command validates and publishes one exact issue draft. */

import {
  clearIntent,
  consumeIssueApproval,
  requireIssueIntent,
  stopPendingIntent,
} from '../invocation.ts';
import { BUILD_SOURCE_PROTOCOL } from '../flow/build/handoff.ts';
import { parseCommand, requireExactFlags } from '../shared/cli.ts';
import { ISSUE_COMMAND, isMainModule } from '../shared/environment.ts';
import { resolveConfiguredLanguage, type ConfiguredLanguage } from '../shared/language.ts';
import { FlowError } from '../shared/errors.ts';
import { readAbsoluteJson, runCli } from '../shared/runtime.ts';
import { ProgressReporter, workflowProgress } from '../shared/progress.ts';
import {
  ISSUE_DESCRIPTION_PROTOCOL,
  ISSUE_INPUT_PROTOCOL,
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
    protocol: typeof ISSUE_INPUT_PROTOCOL;
    repo: string;
    repository: string;
    remote: 'origin';
    mode: 'create';
    think_report: string;
    title: string;
    target_issue: null;
    priority: 'medium';
  };
  attach_plan_template: {
    protocol: typeof ISSUE_INPUT_PROTOCOL;
    repo: string;
    repository: string;
    remote: 'origin';
    mode: 'attach-plan';
    think_report: string;
    title: null;
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
    protocol: typeof BUILD_SOURCE_PROTOCOL;
    repository: string;
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
export function describeIssue(
  language: ConfiguredLanguage = resolveConfiguredLanguage('japanese'),
): IssueDescription {
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
      protocol: ISSUE_INPUT_PROTOCOL,
      repo: '/absolute/git-root',
      repository: 'owner/name',
      remote: 'origin',
      mode: 'create',
      think_report: '/absolute/private-think-report.json',
      title:
        language === 'japanese'
          ? '作業内容を具体的に表す短いタイトル'
          : 'Concise title without a task-type prefix',
      target_issue: null,
      priority: 'medium',
    },
    attach_plan_template: {
      protocol: ISSUE_INPUT_PROTOCOL,
      repo: '/absolute/git-root',
      repository: 'owner/name',
      remote: 'origin',
      mode: 'attach-plan',
      think_report: '/absolute/private-think-report.json',
      title: null,
      target_issue: 123,
      priority: 'medium',
    },
    contracts: {
      source: 'think_report must be ready, share the current HEAD, and retain valid evidence',
      missing_source:
        'stop consumes the pending intent and publication approval without creating an input or writing to GitHub',
      preview: 'draft is validated and publication verifies the exact draft before writing',
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
      protocol: BUILD_SOURCE_PROTOCOL,
      repository: input.repository,
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
