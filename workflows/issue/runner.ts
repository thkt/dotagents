#!/usr/bin/env bun
/** @file Outcome: One explicit command validates and publishes one exact issue draft. */

import { clearIntent, consumeIssueApproval, requireIssueIntent } from '../invocation.ts';
import { BUILD_SOURCE_PROTOCOL } from '../flow/build/handoff.ts';
import { parseCommand, requireExactFlags } from '../shared/cli.ts';
import {
  configuredCodexLanguage,
  ISSUE_COMMAND,
  isMainModule,
  type ConfiguredLanguage,
} from '../shared/environment.ts';
import { FlowError } from '../shared/errors.ts';
import { readAbsoluteJson, runCli } from '../shared/runtime.ts';
import { ProgressReporter, workflowProgress } from '../shared/progress.ts';
import {
  ISSUE_DESCRIPTION_PROTOCOL,
  ISSUE_INPUT_PROTOCOL,
  ISSUE_RESULT_PROTOCOL,
  validateIssueInput,
} from './contracts.ts';
import type { IssueGateway } from './github.ts';
import { draftIssue, publishIssue } from './pipeline.ts';

interface IssueDescription {
  protocol: typeof ISSUE_DESCRIPTION_PROTOCOL;
  outcome: string;
  cli: {
    describe: string;
    draft: string;
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
  contracts: { source: string; preview: string; publish: string };
}

export interface IssuePublishCommandResult {
  protocol: typeof ISSUE_RESULT_PROTOCOL;
  status: 'published';
  issue_number: number;
  url: string;
  receipt_json: string;
  build_source: { protocol: typeof BUILD_SOURCE_PROTOCOL; receipt: string };
  next_step: 'build';
}

/** Exposes the human decisions while leaving Plan rendering and publication mechanics to code. */
export function describeIssue(
  language: ConfiguredLanguage = configuredCodexLanguage('japanese'),
): IssueDescription {
  return {
    protocol: ISSUE_DESCRIPTION_PROTOCOL,
    outcome: 'One reviewed Plan is validated and published as a build-ready GitHub issue.',
    cli: {
      describe: `${ISSUE_COMMAND} describe`,
      draft: `${ISSUE_COMMAND} draft --input <absolute-json>`,
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
    contracts: {
      source: 'think_report must be ready, share the current HEAD, and retain valid evidence',
      preview: 'draft is validated and publication verifies the exact draft before writing',
      publish: 'the validated draft is published atomically from the caller perspective',
    },
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
  const result = progress.runSync({ workflow: 'issue', stage: 'issue_draft' }, () =>
    draftIssue(input, gateway),
  );
  consumeIssueApproval(runId, input.repo);
  clearIntent(runId);
  const published = progress.runSync({ workflow: 'issue', stage: 'issue_publish' }, () =>
    publishIssue(result.draft_json, result.draft_sha256, gateway),
  );
  return {
    protocol: ISSUE_RESULT_PROTOCOL,
    status: 'published',
    issue_number: published.issue.number,
    url: published.issue.url,
    receipt_json: published.receipt_json,
    build_source: { protocol: BUILD_SOURCE_PROTOCOL, receipt: published.receipt_json },
    next_step: 'build',
  };
}

export function main(
  argv: string[] = process.argv.slice(2),
): IssueDescription | IssuePublishCommandResult {
  const { command, flags } = parseCommand(argv);
  if (command === 'describe') {
    requireExactFlags(flags, []);
    return describeIssue();
  }
  if (command === 'draft') {
    requireExactFlags(flags, ['--input', '--run-id']);
    return draftIssueWorkflow(flags['--run-id']!, flags['--input']!);
  }
  throw new FlowError(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  runCli(main, ISSUE_RESULT_PROTOCOL);
}
