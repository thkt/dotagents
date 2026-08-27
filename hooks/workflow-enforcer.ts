#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import {
  actorScopeChanges,
  loadState,
  nextDirective,
} from '../workflows/core/flow-control.ts';
import type { ActorStep, FlowState, FlowStep } from '../workflows/core/contracts.ts';
import {
  armIntent,
  loadIntent,
  parseExplicitInvocation,
  type FlowIntent,
} from '../workflows/core/intent.ts';
import { FLOW_COMMAND, isMainModule } from '../runtime/paths.ts';

const SHELL_CONTROL = /(?:\r|\n|&&|\|\||[;|`<>]|\$\()/u;
const READ_ONLY_COMMANDS = new Set([
  'file', 'find', 'head', 'ls', 'pwd', 'realpath', 'rg', 'sed', 'stat', 'tail', 'wc',
]);
const READ_ONLY_GIT_COMMANDS = new Set([
  'branch', 'diff', 'log', 'ls-files', 'rev-parse', 'show', 'status',
]);

interface HookInput {
  cwd?: string;
  hook_event_name?: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | string;
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
  hookEventName: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse';
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readInput(): HookInput {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')) as HookInput;
  } catch {
    return {};
  }
}

function activeState(runId: string | undefined): FlowState | null {
  if (!runId) return null;
  try {
    const state = loadState(runId).state;
    return state.status === 'running' ? state : null;
  } catch {
    return null;
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

function patchFiles(command: unknown): string[] {
  return [...String(command || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function eventCwd(input: HookInput, fallback: string): string {
  const raw = typeof input.cwd === 'string' ? input.cwd : fallback;
  try {
    return fs.realpathSync(raw);
  } catch {
    return path.resolve(raw);
  }
}

function resolvedPatchFiles(input: HookInput, fallback: string): string[] {
  const cwd = eventCwd(input, fallback);
  return patchFiles(input.tool_input?.command).map((file) =>
    path.resolve(path.isAbsolute(file) ? file : path.join(cwd, file)));
}

function directWriteFiles(input: HookInput, fallback: string): string[] {
  const cwd = eventCwd(input, fallback);
  return [input.tool_input?.file_path, input.tool_input?.path]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((file) => path.resolve(path.isAbsolute(file) ? file : path.join(cwd, file)));
}

function requestedWriteFiles(input: HookInput, fallback: string): string[] {
  return input.tool_name === 'apply_patch'
    ? resolvedPatchFiles(input, fallback)
    : directWriteFiles(input, fallback);
}

function allowedActorFiles(state: FlowState): { step: ActorStep | null; files: Set<string> } {
  const step = state.manifest.steps[state.cursor];
  if (!step || step.kind !== 'actor') return { step: null, files: new Set() };
  return {
    step,
    files: new Set(step.files.map((file) => path.resolve(state.manifest.repo, file))),
  };
}

function stagedPaths(repo: string): string[] | null {
  const result = spawnSync('git', ['-C', repo, 'diff', '--cached', '--name-only', '-z'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean);
}

function commitScope(state: FlowState, current: FlowStep | undefined): {
  allowed: Set<string>;
  staged: string[] | null;
  outside: string[];
} {
  const unit = /^((?:U-\d{3})):commit$/.exec(current?.id || '')?.[1];
  if (!unit) return { allowed: new Set(), staged: null, outside: [] };
  const allowed = new Set(state.manifest.steps
    .filter((step): step is ActorStep => step.kind === 'actor' && step.id.startsWith(`${unit}:`))
    .flatMap((step) => step.files));
  const staged = stagedPaths(state.manifest.repo);
  return {
    allowed,
    staged,
    outside: staged ? staged.filter((relative) => !allowed.has(relative)) : [],
  };
}

function injectRunId(input: HookInput, command: string): HookResponse {
  if (SHELL_CONTROL.test(command)) return deny('flow-control command may not be chained or redirected');
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
        command: `${command} --run-id ${JSON.stringify(input.session_id)}`,
      },
    },
  };
}

function commandWords(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean);
}

function isFlowCommand(command: string): boolean {
  return commandWords(command)[0] === FLOW_COMMAND;
}

function flowSubcommand(command: string): string | undefined {
  return isFlowCommand(command) ? commandWords(command)[1] : undefined;
}

function manifestArgument(command: string): string | null {
  const match = /(?:^|\s)--manifest\s+("[^"]+"|'[^']+'|\S+)/u.exec(command);
  if (!match) return null;
  const value = match[1];
  return value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
}

function isReadOnlyPreparationCommand(command: string): boolean {
  if (!command.trim() || SHELL_CONTROL.test(command)) return false;
  const words = commandWords(command);
  const executable = path.basename(words[0] || '');
  if (READ_ONLY_COMMANDS.has(executable)) return true;
  if (executable !== 'git') return false;
  let index = 1;
  if (words[index] === '-C') index += 2;
  return READ_ONLY_GIT_COMMANDS.has(words[index] || '');
}

function pendingWrite(input: HookInput, pending: FlowIntent): HookResponse {
  const files = requestedWriteFiles(input, pending.repo);
  if (files.length === 1 && files[0] === pending.manifest_path) return {};
  return deny(`prepare only the hook-supplied manifest: ${pending.manifest_path}`);
}

function pendingPreToolUse(input: HookInput, pending: FlowIntent, command: string): HookResponse {
  if (input.tool_name === 'apply_patch' || input.tool_name === 'Edit' || input.tool_name === 'Write') {
    return pendingWrite(input, pending);
  }
  if (input.tool_name !== 'Bash') return {};
  if (isFlowCommand(command)) {
    const subcommand = flowSubcommand(command);
    if (subcommand === 'describe') return {};
    if (subcommand === 'start') {
      const manifest = manifestArgument(command);
      if (!manifest || path.resolve(eventCwd(input, pending.repo), manifest) !== pending.manifest_path) {
        return deny(`start with the hook-supplied manifest: ${pending.manifest_path}`);
      }
      return injectRunId(input, command);
    }
    return deny('start the pending workflow before using stateful flow-control commands');
  }
  return isReadOnlyPreparationCommand(command)
    ? {}
    : deny('only read-only inspection and manifest preparation are allowed before workflow start');
}

function userPromptSubmit(input: HookInput): HookResponse {
  const workflow = parseExplicitInvocation(input.prompt);
  if (!workflow) return {};
  if (!input.session_id || !input.cwd) {
    return { decision: 'block', reason: `explicit $${workflow} requires session_id and cwd` };
  }
  try {
    const pending = armIntent({ runId: input.session_id, workflow, cwd: input.cwd });
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Explicit $${workflow} is armed. Write the manifest only to the hook-supplied manifest path ${pending.manifest_path}, then run ${FLOW_COMMAND} start --manifest ${pending.manifest_path}.`,
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

  if (input.tool_name === 'Bash' && isFlowCommand(command)) {
    return flowSubcommand(command) === 'describe' ? {} : injectRunId(input, command);
  }

  const state = activeState(input.session_id);
  if (!state) return {};
  const current = state.manifest.steps[state.cursor];

  if (input.tool_name === 'apply_patch' || input.tool_name === 'Edit' || input.tool_name === 'Write') {
    const { step, files } = allowedActorFiles(state);
    if (!step) return deny(`workflow expects ${current?.id || 'a gate'}, so editing is blocked`);
    const changed = requestedWriteFiles(input, state.manifest.repo);
    if (!changed.length) return deny('could not determine the files in the edit');
    const outside = changed.filter((file) => !files.has(file));
    if (outside.length) {
      return deny(`${step.id} may edit only ${[...files].join(', ')}; blocked ${outside.join(', ')}`);
    }
    return {};
  }

  if (input.tool_name === 'Bash') {
    const pushes = /(?:^|\s)git\s+push(?:\s|$)|(?:^|\s)gh\s+pr\s+create(?:\s|$)/u.test(command);
    if (pushes && !(current?.kind === 'action' && current.action === 'ship')) {
      return deny(`shipping is blocked until the controller reaches an authorized ship action; current step is ${current?.id}`);
    }
    const commits = /(?:^|\s)git\s+commit(?:\s|$)/u.test(command);
    if (commits) {
      if (!(current?.kind === 'action' && current.action === 'commit')) {
        return deny(`commit is blocked until the preceding unit gates pass; current step is ${current?.id}`);
      }
      const scope = commitScope(state, current);
      if (!scope.staged) return deny('could not inspect the staged commit paths');
      if (!scope.staged.length) return deny(`${current.id} requires explicitly staged unit files`);
      if (scope.outside.length) {
        return deny(`${current.id} may commit only ${[...scope.allowed].join(', ')}; blocked ${scope.outside.join(', ')}`);
      }
    }
  }
  return {};
}

function postToolUse(input: HookInput): HookResponse {
  const state = activeState(input.session_id);
  if (!state || state.manifest.steps[state.cursor]?.kind !== 'actor') return {};
  try {
    const scope = actorScopeChanges(state);
    if (!scope.outside.length) return {};
    const reason = `${scope.step?.id || 'actor'} changed files outside its declared scope: ${scope.outside.join(', ')}. Restore those paths to their actor-entry state before reporting completion.`;
    return {
      decision: 'block',
      reason,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reason },
    };
  } catch (error) {
    return { decision: 'block', reason: `workflow scope verification failed: ${errorMessage(error)}` };
  }
}

function stop(input: HookInput): HookResponse {
  const pending = loadIntent(input.session_id);
  if (pending) {
    return {
      decision: 'block',
      reason: `The explicit $${pending.workflow} workflow has not started. Create ${pending.manifest_path} and start the controller.`,
    };
  }
  const state = activeState(input.session_id);
  if (!state) return {};
  const directive = nextDirective(state.run_id);
  const reason = `The enforced ${state.workflow} forwarding loop is incomplete. Act on this typed directive, report it through ${FLOW_COMMAND}, then call next again: ${JSON.stringify(directive)}`;
  if (input.stop_hook_active) {
    return {
      continue: false,
      systemMessage: `${reason} Automatic continuation already ran once. Report the mechanical blocker instead of claiming success.`,
    };
  }
  return { decision: 'block', reason };
}

function handle(input: HookInput): HookResponse {
  if (input.hook_event_name === 'UserPromptSubmit') return userPromptSubmit(input);
  if (input.hook_event_name === 'PreToolUse') return preToolUse(input);
  if (input.hook_event_name === 'PostToolUse') return postToolUse(input);
  if (input.hook_event_name === 'Stop') return stop(input);
  return {};
}

if (isMainModule(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(handle(readInput()))}\n`);
}

export {
  FLOW_COMMAND,
  activeState,
  allowedActorFiles,
  commitScope,
  handle,
  injectRunId,
  isFlowCommand,
  isReadOnlyPreparationCommand,
  patchFiles,
  preToolUse,
  postToolUse,
  requestedWriteFiles,
  stop,
  userPromptSubmit,
};
export type { HookInput, HookResponse };
