#!/usr/bin/env bun
/** @file Outcome: Explicit workflows start and resume only through their task-bound controller. */

import * as fs from 'node:fs';
import path from 'node:path';

import type { FlowState } from '../workflows/flow/contracts.ts';
import { loadWorkflowState } from '../workflows/flow/controller.ts';
import {
  armIntent,
  clearIntent,
  loadIntent,
  parseExplicitInvocation,
  type WorkflowIntent,
} from '../workflows/invocation.ts';
import { SHELL_CONTROL, shellArgument } from '../workflows/shared/command.ts';
import {
  FLOW_COMMAND,
  ISSUE_COMMAND,
  RESEARCH_COMMAND,
  THINK_COMMAND,
  isMainModule,
} from '../workflows/shared/environment.ts';
import { errorCode, errorMessage } from '../workflows/shared/errors.ts';
import { workflowInputPath } from '../workflows/shared/storage.ts';

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'file',
  'head',
  'jq',
  'ls',
  'pwd',
  'realpath',
  'rg',
  'stat',
  'tail',
  'wc',
]);
const READ_ONLY_GIT_COMMANDS = new Set(['diff', 'log', 'ls-files', 'rev-parse', 'show', 'status']);
const UNSAFE_GIT_READ_FLAGS = ['--ext-diff', '--output', '--textconv'] as const;

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

function activeState(runId: string | undefined): FlowState | null {
  const state = controllerState(runId);
  return state?.status === 'running' ? state : null;
}

function controllerState(runId: string | undefined): FlowState | null {
  if (!runId) return null;
  try {
    return loadWorkflowState(runId).state;
  } catch (error) {
    if (errorCode(error) === 'no_flow') return null;
    throw error;
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

function eventCwd(input: HookInput, fallback: string): string {
  const raw = typeof input.cwd === 'string' ? input.cwd : fallback;
  try {
    return fs.realpathSync(raw);
  } catch {
    return path.resolve(raw);
  }
}

function requestedWriteFiles(input: HookInput, fallback: string): string[] {
  const cwd = eventCwd(input, fallback);
  const raw =
    input.tool_name === 'apply_patch'
      ? [
          ...String(input.tool_input?.command || '').matchAll(
            /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm,
          ),
        ].map((match) => match[1] || match[2])
      : [input.tool_input?.file_path, input.tool_input?.path];
  return raw
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((file) => path.resolve(path.isAbsolute(file) ? file : path.join(cwd, file)));
}

function commandWords(command: string): string[] {
  return [...command.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/gu)].map((match) => {
    const token = match[0];
    if (token.startsWith('"')) {
      try {
        return JSON.parse(token) as string;
      } catch {
        return token;
      }
    }
    return token.startsWith("'") ? token.slice(1, -1) : token;
  });
}

function commandSubcommand(command: string, executable: string): string | null {
  const words = commandWords(command);
  return words[0] === executable ? words[1] || '' : null;
}

const WORKFLOW_RUNTIMES = {
  build: { executable: FLOW_COMMAND, flag: '--manifest', start: 'run', noun: 'manifest' },
  code: { executable: FLOW_COMMAND, flag: '--manifest', start: 'run', noun: 'manifest' },
  issue: { executable: ISSUE_COMMAND, flag: '--input', start: 'draft', noun: 'issue input' },
  research: { executable: RESEARCH_COMMAND, flag: '--input', start: 'run', noun: 'research input' },
  think: { executable: THINK_COMMAND, flag: '--input', start: 'run', noun: 'think input' },
} as const;
type WorkflowName = keyof typeof WORKFLOW_RUNTIMES;

function workflowSubcommand(command: string, workflow: WorkflowName): string | null {
  return commandSubcommand(command, WORKFLOW_RUNTIMES[workflow].executable);
}

function pathArgument(command: string, flag: '--manifest' | '--input'): string | null {
  const words = commandWords(command);
  const index = words.indexOf(flag);
  return index < 0 ? null : words[index + 1] || null;
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

function isReadOnlyPreparationCommand(command: string): boolean {
  if (!command.trim() || SHELL_CONTROL.test(command)) return false;
  const words = commandWords(command);
  const executable = path.basename(words[0] || '');
  if (READ_ONLY_COMMANDS.has(executable)) {
    return (
      executable !== 'rg' || !words.some((word) => word === '--pre' || word.startsWith('--pre='))
    );
  }
  if (executable !== 'git') return false;
  let index = 1;
  if (words[index] === '-C') index += 2;
  if (!READ_ONLY_GIT_COMMANDS.has(words[index] || '')) return false;
  return !words
    .slice(index + 1)
    .some((word) =>
      UNSAFE_GIT_READ_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`)),
    );
}

function exactInputPath(
  input: HookInput,
  command: string,
  flag: '--manifest' | '--input',
  expected: string,
): boolean {
  const supplied = pathArgument(command, flag);
  if (!supplied) return false;
  if (path.isAbsolute(supplied)) return path.resolve(supplied) === expected;
  return (
    typeof input.cwd === 'string' && path.resolve(eventCwd(input, input.cwd), supplied) === expected
  );
}

function pendingWrite(input: HookInput, pending: WorkflowIntent): HookResponse {
  const files = requestedWriteFiles(input, pending.repo);
  const allowed = new Set([
    pending.input_path,
    ...(pending.build_source_path ? [pending.build_source_path] : []),
  ]);
  return files.length === 1 && allowed.has(files[0]!)
    ? {}
    : deny(`prepare only the hook-supplied files: ${[...allowed].join(', ')}`);
}

function pendingPreToolUse(
  input: HookInput,
  pending: WorkflowIntent,
  command: string,
): HookResponse {
  if (
    input.tool_name === 'apply_patch' ||
    input.tool_name === 'Edit' ||
    input.tool_name === 'Write'
  ) {
    return pendingWrite(input, pending);
  }
  if (input.tool_name !== 'Bash') return {};
  const { executable, flag, start } = invocationRuntime(pending);
  const subcommand = commandSubcommand(command, executable);
  if (subcommand === 'describe') {
    return SHELL_CONTROL.test(command)
      ? deny('workflow command may not be chained or redirected')
      : {};
  }
  if (subcommand === start) {
    return exactInputPath(input, command, flag, pending.input_path)
      ? injectRunId(input, command)
      : deny(`${start} with the hook-supplied input: ${pending.input_path}`);
  }
  if (subcommand !== null) return deny('run the pending workflow before other commands');
  if (
    [FLOW_COMMAND, ISSUE_COMMAND, RESEARCH_COMMAND, THINK_COMMAND].some(
      (candidate) => candidate !== executable && commandSubcommand(command, candidate) !== null,
    )
  ) {
    return deny(`the pending workflow must run through ${executable}`);
  }
  return isReadOnlyPreparationCommand(command)
    ? {}
    : deny(
        'only read-only inspection and workflow input preparation are allowed before workflow run',
      );
}

function invocationRuntime(pending: WorkflowIntent): {
  executable: string;
  flag: '--manifest' | '--input';
  start: 'run' | 'draft';
  noun: string;
} {
  return WORKFLOW_RUNTIMES[pending.workflow];
}

function userPromptSubmit(input: HookInput): HookResponse {
  const workflow = parseExplicitInvocation(input.prompt);
  if (!workflow) return {};
  if (!input.session_id || !input.cwd) {
    return { decision: 'block', reason: `explicit $${workflow} requires session_id and cwd` };
  }
  try {
    const pending = armIntent({ runId: input.session_id, workflow, cwd: input.cwd });
    const buildPaths =
      pending.workflow === 'build'
        ? ` Prepare the published-issue source at ${pending.build_source_path}.`
        : '';
    const { executable, flag, start, noun } = invocationRuntime(pending);
    const command = `${executable} ${start} ${flag} ${shellArgument(pending.input_path)}`;
    const externalWriteApproval =
      workflow === 'issue'
        ? " The user's leading explicit $issue invocation authorizes exactly one GitHub Issue create or edit for this task and repository; no additional publication confirmation is required."
        : workflow === 'build'
          ? " The user's leading explicit $build invocation authorizes exactly one push and one draft PR creation for this task and repository; include Ship unless the same request explicitly excludes push or draft PR creation, and do not request another Ship confirmation."
          : '';
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Explicit $${workflow} is armed.${externalWriteApproval} Write the ${noun} only to the hook-supplied path ${pending.input_path}.${buildPaths} Then run ${command}.`,
      },
    };
  } catch (error) {
    return { decision: 'block', reason: errorMessage(error) };
  }
}

function preToolUse(input: HookInput): HookResponse {
  const command = String(input.tool_input?.command || '');
  const pending = loadIntent(input.session_id);
  if (pending) return pendingPreToolUse(input, pending, command);

  const subcommand = input.tool_name === 'Bash' ? commandSubcommand(command, FLOW_COMMAND) : null;
  const issue = input.tool_name === 'Bash' ? workflowSubcommand(command, 'issue') : null;
  const research = input.tool_name === 'Bash' ? workflowSubcommand(command, 'research') : null;
  const think = input.tool_name === 'Bash' ? workflowSubcommand(command, 'think') : null;
  const standalone =
    subcommand === 'describe' ||
    issue === 'describe' ||
    research === 'describe' ||
    think === 'describe';
  if (standalone && SHELL_CONTROL.test(command)) {
    return deny('workflow command may not be chained or redirected');
  }
  if (standalone) return {};
  if (subcommand === 'cancel') {
    const state = controllerState(input.session_id);
    if (!state || (state.status !== 'running' && state.status !== 'cancelled')) {
      return deny('cancel requires an active workflow controller for this task');
    }
    const expected = workflowInputPath(state.run_id);
    return exactInputPath(input, command, '--manifest', expected)
      ? injectRunId(input, command)
      : deny(`cancel with the hook-supplied manifest: ${expected}`);
  }
  if (issue !== null) return deny('explicit $issue invocation is required before drafting');
  if (research !== null) return deny('explicit $research invocation is required');
  if (think !== null) return deny('explicit $think invocation is required');
  const state = activeState(input.session_id);
  if (!state) {
    return subcommand === null ? {} : deny('explicit $code or $build invocation is required');
  }
  const expected = workflowInputPath(state.run_id);
  if (subcommand === 'run') {
    return exactInputPath(input, command, '--manifest', expected)
      ? injectRunId(input, command)
      : deny(`resume with the hook-supplied manifest: ${expected}`);
  }
  if (input.tool_name === 'Bash' && subcommand === null && isReadOnlyPreparationCommand(command))
    return {};
  return deny(
    `workflow controller is active; resume it with ${FLOW_COMMAND} run --manifest ${expected}`,
  );
}

function stop(input: HookInput): HookResponse {
  const pending = loadIntent(input.session_id);
  if (pending) {
    const { executable, flag, start } = invocationRuntime(pending);
    const command = `${executable} ${start} ${flag} ${shellArgument(pending.input_path)}`;
    const reason = `The explicit $${pending.workflow} workflow has not run. Create ${pending.input_path} and run ${command}.`;
    if (input.stop_hook_active) {
      clearIntent(pending.run_id);
      return {
        continue: false,
        systemMessage: `${reason} Automatic continuation already ran once. Report the preparation blocker.`,
      };
    }
    return { decision: 'block', reason };
  }
  const state = activeState(input.session_id);
  if (!state) return {};
  const command = `${FLOW_COMMAND} run --manifest ${shellArgument(workflowInputPath(state.run_id))}`;
  const reason = `The ${state.workflow} workflow is incomplete. Resume its controller with ${command}.`;
  return input.stop_hook_active
    ? { continue: false, systemMessage: `${reason} Report the runtime blocker if it fails again.` }
    : { decision: 'block', reason };
}

/** Applies the event-specific workflow boundary without executing workflow policy itself. */
function handle(input: HookInput): HookResponse {
  try {
    if (input.hook_event_name === 'UserPromptSubmit') return userPromptSubmit(input);
    if (input.hook_event_name === 'PreToolUse') return preToolUse(input);
    if (input.hook_event_name === 'Stop') return stop(input);
    return {};
  } catch (error) {
    const reason = `workflow enforcement unavailable: ${errorMessage(error)}`;
    return input.hook_event_name === 'PreToolUse' ? deny(reason) : { decision: 'block', reason };
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(handle(readInput()))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        decision: 'block',
        reason: `workflow hook input is invalid: ${errorMessage(error)}`,
      })}\n`,
    );
  }
}

export { FLOW_COMMAND, ISSUE_COMMAND, RESEARCH_COMMAND, THINK_COMMAND, handle, preToolUse, stop };
export type { HookInput, HookResponse };
