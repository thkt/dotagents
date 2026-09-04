#!/usr/bin/env bun
/** @file Outcome: The host binds explicit workflow invocations to a task; runners own execution policy. */

import * as fs from 'node:fs';
import {
  armIntent,
  clearIntent,
  parseBuildIssueNumber,
  parseExplicitInvocation,
  type WorkflowIntent,
} from '../workflows/runtime/invocation.ts';
import { githubRepositoryForRemote } from '../workflows/issue/github.ts';
import { SHELL_CONTROL, shellArgument, shellWords } from '../workflows/shared/command.ts';
import {
  BUILD_COMMAND,
  CODE_COMMAND,
  ISSUE_COMMAND,
  RESEARCH_COMMAND,
  THINK_COMMAND,
  isMainModule,
} from '../workflows/runtime/environment.ts';
import { errorMessage } from '../workflows/shared/errors.ts';
import { readProjectOutcome } from '../workflows/shared/project-outcome.ts';
import { atomicWrite } from '../workflows/runtime/storage.ts';

interface HookInput {
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  session_id?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    path?: string;
    [key: string]: unknown;
  };
}

interface HookSpecificOutput {
  hookEventName: 'UserPromptSubmit' | 'PreToolUse';
  permissionDecision?: 'allow' | 'deny';
  permissionDecisionReason?: string;
  updatedInput?: HookInput['tool_input'] & { command: string };
  additionalContext?: string;
}

interface HookResponse {
  hookSpecificOutput?: HookSpecificOutput;
  decision?: 'block';
  reason?: string;
  continue?: false;
  systemMessage?: string;
}

function readInput(): HookInput {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')) as HookInput;
  } catch (error) {
    throw new Error(`hook input is not valid JSON: ${errorMessage(error)}`);
  }
}

function deny(reason: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

const WORKFLOW_RUNTIMES = {
  build: { executable: BUILD_COMMAND, flag: '--input', start: 'run', noun: 'build input' },
  code: { executable: CODE_COMMAND, flag: '--input', start: 'run', noun: 'code input' },
  issue: { executable: ISSUE_COMMAND, flag: '--input', start: 'draft', noun: 'issue input' },
  research: { executable: RESEARCH_COMMAND, flag: '--input', start: 'run', noun: 'research input' },
  think: { executable: THINK_COMMAND, flag: '--input', start: 'run', noun: 'think input' },
} as const;

function invocationRuntime(pending: WorkflowIntent) {
  return WORKFLOW_RUNTIMES[pending.workflow];
}

function injectRunId(input: HookInput, command: string): HookResponse {
  if (SHELL_CONTROL.test(command))
    return deny('flow-control command may not be chained or redirected');
  if (/(?:^|\s)--run-id(?:\s|=)/u.test(command)) {
    return deny('omit --run-id; the workflow hook binds it to the current Codex task');
  }
  if (!input.session_id) return deny('workflow command requires a Codex session_id');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...input.tool_input,
        command: `${command} --run-id ${shellArgument(input.session_id)}`,
      },
    },
  };
}

/** Makes the outer workflow process network-capable before it starts an SDK or GitHub request. */
function networkExecutionInstruction(workflow: WorkflowIntent['workflow']): string {
  if (workflow === 'research') {
    return ' Invoke the first bound workflow command itself with network escalation and, when supported, request persistent approval for prefix ["codex-research", "run"] in that same tool call.';
  }
  if (workflow === 'think') {
    return ' Invoke the first bound workflow command itself with network escalation and, when supported, request persistent approval for prefix ["codex-think", "run"] in that same tool call.';
  }
  if (workflow === 'issue') {
    return ' When publishing, invoke the first bound draft command itself with network escalation and, when supported, request persistent approval for prefix ["codex-issue", "draft"] in that same tool call. The controller still requires the task- and repository-bound $issue approval and limits GitHub access to its closed Issue operation registry. The missing-source stop command does not require network escalation.';
  }
  if (workflow === 'build') {
    return ' Invoke the first bound Build command itself with network escalation and, when supported, request persistent approval for prefix ["codex-build", "run"] in that same tool call. The Build-only command still requires the task- and repository-bound $build Ship approval and exposes only Build run and cancel operations.';
  }
  return ' Invoke the first bound workflow command itself with network escalation. Do not request persistent approval for this command prefix because it can perform repository or GitHub writes.';
}

function userPromptSubmit(input: HookInput): HookResponse {
  const workflow = parseExplicitInvocation(input.prompt);
  if (!workflow) return {};
  if (!input.session_id || !input.cwd) {
    return { decision: 'block', reason: `explicit $${workflow} requires session_id and cwd` };
  }
  try {
    readProjectOutcome(input.cwd);
    const buildIssue = workflow === 'build' ? parseBuildIssueNumber(input.prompt) : null;
    const buildRepository =
      buildIssue === null ? null : githubRepositoryForRemote(input.cwd, 'origin');
    const pending = armIntent({ runId: input.session_id, workflow, cwd: input.cwd });
    try {
      if (buildIssue !== null && buildRepository !== null) {
        atomicWrite(pending.input_path, {
          repo: pending.repo,
          issue_number: buildIssue,
          ship: true,
          screenshots: [],
        });
      }
    } catch (error) {
      clearIntent(pending.run_id);
      throw error;
    }
    const buildPaths =
      pending.workflow === 'build'
        ? buildIssue === null
          ? ` Prepare the build input at ${pending.input_path}.`
          : ` The build input for ${buildRepository}#${buildIssue} is already prepared. The controller will read the public Plan once and compile its execution. If this invocation explicitly excludes Ship, set ship to false before running. Add screenshot name and alt pairs only when the user explicitly requests PR screenshots.`
        : '';
    const { executable, flag, start, noun } = invocationRuntime(pending);
    const command = `${executable} ${start} ${flag} ${shellArgument(pending.input_path)}`;
    const missingSource =
      workflow === 'issue'
        ? ` If no ready Think artifact exists, do not create a placeholder input; run ${ISSUE_COMMAND} stop --input ${shellArgument(pending.input_path)}.`
        : '';
    const externalWriteApproval =
      workflow === 'issue'
        ? " The user's leading explicit $issue invocation authorizes at most one GitHub Issue create or edit for this task and repository; no additional publication confirmation is required."
        : workflow === 'build'
          ? " The user's leading explicit $build invocation authorizes one final commit and, when Ship is enabled, one push and one draft PR creation for this task and repository; include Ship unless the same request explicitly excludes push or draft PR creation, and do not request another Ship confirmation."
          : '';
    const networkExecution = networkExecutionInstruction(workflow);
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Explicit $${workflow} is armed.${externalWriteApproval}${networkExecution}${missingSource} Otherwise write the ${noun} only to the hook-supplied path ${pending.input_path}.${buildPaths} Then run ${command}.`,
      },
    };
  } catch (error) {
    return { decision: 'block', reason: errorMessage(error) };
  }
}

/** Adds host identity only; each CLI validates its own intent, input and resumable state. */
function preToolUse(input: HookInput): HookResponse {
  if (input.tool_name !== 'Bash') return {};
  const command = String(input.tool_input?.command || '');
  const [executable, subcommand] = shellWords(command);
  if (!Object.values(WORKFLOW_RUNTIMES).some((runtime) => runtime.executable === executable)) {
    return {};
  }
  if (SHELL_CONTROL.test(command)) return deny('workflow command may not be chained or redirected');
  if (subcommand === 'describe') return {};
  return injectRunId(input, command);
}

/** Routes host events without interpreting controller state or forcing a retry. */
function handle(input: HookInput): HookResponse {
  try {
    if (input.hook_event_name === 'UserPromptSubmit') return userPromptSubmit(input);
    if (input.hook_event_name === 'PreToolUse') return preToolUse(input);
    return {};
  } catch (error) {
    const reason = `workflow binding unavailable: ${errorMessage(error)}`;
    return input.hook_event_name === 'PreToolUse' ? deny(reason) : { decision: 'block', reason };
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(handle(readInput()))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: errorMessage(error) })}\n`);
  }
}

export { handle };
