#!/usr/bin/env bun
/** @file Outcome: One command drives an armed flow through actors, actions, and gates to a terminal state. */

import { RESULT_PROTOCOL, type CommandResult, type FlowDirective } from './contracts.ts';
import { executeAction } from './build/actions.ts';
import { ActorEscalation, CodexWorkflowAgent, type WorkflowAgent } from './agent.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { isMainModule } from '../shared/environment.ts';
import { parseCommand, requireExactFlags } from '../shared/cli.ts';
import { runIsolatedActor } from './isolation.ts';
import {
  completeCurrentDirective,
  currentDirective,
  describe,
  loadWorkflowState,
  startOrResumeWorkflow,
  workflowStatus,
  escalateWorkflow,
} from './controller.ts';

type ActionDirective = Extract<FlowDirective, { kind: 'run-action' }>;

export interface WorkflowRuntime {
  agent: WorkflowAgent;
  executeAction(repo: string, directive: ActionDirective): void;
  onDirective?(directive: FlowDirective): void;
}

function defaultRuntime(): WorkflowRuntime {
  return {
    agent: new CodexWorkflowAgent(),
    executeAction,
  };
}

/** Drives persisted controller state until it reaches a terminal directive. */
export async function driveWorkflow(
  runId: string,
  runtime: WorkflowRuntime = defaultRuntime(),
): Promise<CommandResult> {
  const repo = loadWorkflowState(runId).state.manifest.repo;

  while (true) {
    const directive = currentDirective(runId);
    runtime.onDirective?.(directive);
    switch (directive.kind) {
      case 'done':
      case 'ship-ready':
        return { result: workflowStatus(runId), exitCode: 0 };
      case 'blocked':
        return { result: workflowStatus(runId), exitCode: 2 };
      case 'run-actor':
        try {
          await runIsolatedActor(repo, directive.files, (sandboxRepo) =>
            runtime.agent.runActor(sandboxRepo, directive),
          );
        } catch (error) {
          if (error instanceof ActorEscalation)
            return {
              result: escalateWorkflow(runId, directive.step_id, {
                next_step: error.route,
                question: error.question,
                summary: error.summary,
              }),
              exitCode: 2,
            };
          throw error;
        }
        completeCurrentDirective(runId, directive.step_id);
        break;
      case 'run-action':
        runtime.executeAction(repo, directive);
        completeCurrentDirective(runId, directive.step_id);
        break;
      case 'calibrate-gate':
      case 'run-gate':
        completeCurrentDirective(runId, directive.step_id);
        break;
      case 'seal-gate': {
        const candidateId = await runtime.agent.selectEvidenceCandidate(repo, directive);
        completeCurrentDirective(runId, directive.step_id, candidateId);
        break;
      }
    }
  }
}

/** Starts or resumes one task-bound workflow, then drives it to a stop state. */
export async function runWorkflow(
  runId: string,
  manifestFile: string,
  runtime: WorkflowRuntime = defaultRuntime(),
): Promise<CommandResult> {
  startOrResumeWorkflow(runId, manifestFile);
  return driveWorkflow(runId, runtime);
}

/** Parses the public CLI and dispatches its closed command set. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<CommandResult> {
  const { command, flags } = parseCommand(argv);
  if (command === 'describe') {
    requireExactFlags(flags, ['--workflow']);
    const workflow = flags['--workflow'];
    if (workflow !== 'code' && workflow !== 'build') {
      throw new FlowError('--workflow must be code or build');
    }
    return { result: describe(workflow), exitCode: 0 };
  }
  if (command === 'run') {
    requireExactFlags(flags, ['--manifest', '--run-id']);
    return runWorkflow(flags['--run-id']!, flags['--manifest']!);
  }
  throw new FlowError(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  void main()
    .then(({ result, exitCode }) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stdout.write(
        `${JSON.stringify(
          {
            protocol: RESULT_PROTOCOL,
            verdict: 'blocked',
            status: 'error',
            classification: errorCode(error) || 'execution_error',
            error: errorMessage(error),
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = 2;
    });
}
