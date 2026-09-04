/** @file Outcome: One internal engine drives an armed workflow through actors, actions, and gates. */

import {
  RESULT_PROTOCOL,
  type CommandResult,
  type FlowDirective,
  type Workflow,
} from './contracts.ts';
import { executeAction } from '../build/git-actions.ts';
import { resetScreenshotAttachments } from '../build/screenshots.ts';
import { ActorEscalation, CodexWorkflowAgent, type WorkflowAgent } from './agent.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { loadIntent, requireWorkflowInput } from '../runtime/invocation.ts';
import { parseCommand, requireExactFlags } from '../runtime/cli.ts';
import {
  completeActorPublication,
  runRecoverableActor,
  withRepositorySnapshot,
} from './repository-isolation.ts';
import { ProgressReporter, workflowProgress, type ProgressContext } from '../shared/progress.ts';
import { repositoryInvariant, requireUnchangedRepository } from '../shared/repository.ts';
import { sealRepository } from './source-seal.ts';
import {
  completeCurrentDirective,
  completeBuildReview,
  cancelWorkflow,
  currentDirective,
  describe,
  loadWorkflowState,
  reconcileCurrentAction,
  startOrResumeWorkflow,
  workflowStatus,
  escalateWorkflow,
  blockWorkflowOnRuntimeFailure,
} from './controller.ts';

type ActionDirective = Extract<FlowDirective, { kind: 'run-action' }>;

export interface WorkflowRuntime {
  agent: WorkflowAgent;
  executeAction(repo: string, directive: ActionDirective): void;
  onDirective?(directive: FlowDirective): void;
  progress?: ProgressReporter;
}

function defaultRuntime(): WorkflowRuntime {
  return {
    agent: new CodexWorkflowAgent(),
    executeAction,
  };
}

async function runImplementationActor(
  runId: string,
  repo: string,
  directive: Extract<FlowDirective, { kind: 'run-actor' }>,
  runtime: WorkflowRuntime,
  onActivity: Parameters<WorkflowAgent['runActor']>[2],
) {
  resetScreenshotAttachments(runId, directive.screenshots ?? []);
  return runRecoverableActor(runId, directive.step_id, repo, directive.files, (sandboxRepo) =>
    runtime.agent.runActor(sandboxRepo, directive, onActivity),
  );
}

function progressContext(
  workflow: 'build' | 'code',
  directive: Exclude<FlowDirective, { kind: 'done' | 'blocked' | 'cancelled' }>,
): ProgressContext {
  const unitId = directive.step_id.match(/^U-\d+/u)?.[0];
  let stage: ProgressContext['stage'];
  switch (directive.kind) {
    case 'run-actor':
      stage = 'actor_model_call';
      break;
    case 'run-review':
      stage = 'build_semantic_review';
      break;
    case 'run-action':
      stage = `action_${directive.action}`;
      break;
    case 'run-gate':
      stage = 'gate_verification';
      break;
  }
  return {
    workflow,
    stage,
    ...(unitId ? { unit_id: unitId } : {}),
    ...(directive.kind === 'run-actor' && directive.correction
      ? { attempt: directive.correction.attempt }
      : {}),
  };
}

/** Drives persisted controller state until it reaches a terminal directive. */
async function driveWorkflow(
  runId: string,
  runtime: WorkflowRuntime = defaultRuntime(),
): Promise<CommandResult> {
  const { repo, workflow } = loadWorkflowState(runId).state.manifest;
  const progress = runtime.progress ?? workflowProgress;

  while (true) {
    let failedDirective: FlowDirective | null = null;
    let stage = 'controller_dispatch';
    try {
      const directive = currentDirective(runId);
      failedDirective = directive;
      runtime.onDirective?.(directive);
      if (
        directive.kind !== 'done' &&
        directive.kind !== 'blocked' &&
        directive.kind !== 'cancelled'
      ) {
        stage = progressContext(workflow, directive).stage;
      }
      switch (directive.kind) {
        case 'done':
          return { result: workflowStatus(runId), exitCode: 0 };
        case 'blocked':
          return { result: workflowStatus(runId), exitCode: 2 };
        case 'cancelled':
          return { result: workflowStatus(runId), exitCode: 0 };
        case 'run-actor':
          await progress.run(progressContext(workflow, directive), async (stage) => {
            const actorResult = await runImplementationActor(
              runId,
              repo,
              directive,
              runtime,
              (activity) => stage.activity(activity),
            );
            completeCurrentDirective(runId, directive.step_id, actorResult);
            completeActorPublication(runId);
          });
          break;
        case 'run-action':
          progress.runSync(progressContext(workflow, directive), () => {
            if (reconcileCurrentAction(runId, directive.step_id)) return;
            runtime.executeAction(repo, directive);
            completeCurrentDirective(runId, directive.step_id);
          });
          break;
        case 'run-review':
          await progress.run(progressContext(workflow, directive), async (stage) => {
            const startedAt = performance.now();
            const before = repositoryInvariant(repo);
            const liveSeal = sealRepository(repo, { baseRef: directive.input.base_ref });
            const review = await withRepositorySnapshot(repo, async (snapshotRepo) => {
              const logical = {
                head: liveSeal.head,
                branch: liveSeal.branch,
                base_commit: liveSeal.base_commit,
              };
              const snapshotBefore = sealRepository(snapshotRepo, { logical });
              if (snapshotBefore.source_digest !== directive.input.source_digest) {
                throw new FlowError(
                  'review snapshot does not match its source binding',
                  'state_error',
                );
              }
              const candidates = await runtime.agent.reviewBuild(
                snapshotRepo,
                directive,
                (activity) => stage.activity(activity),
              );
              if (
                sealRepository(snapshotRepo, { logical }).source_digest !==
                snapshotBefore.source_digest
              ) {
                throw new FlowError('repository changed during build review', 'state_error');
              }
              return candidates;
            });
            requireUnchangedRepository(before, repo, 'build semantic review');
            completeBuildReview(
              runId,
              directive.step_id,
              review,
              Math.max(0, Math.round(performance.now() - startedAt)),
            );
          });
          break;
        case 'run-gate':
          progress.runSync(progressContext(workflow, directive), () =>
            completeCurrentDirective(runId, directive.step_id),
          );
          break;
      }
    } catch (error) {
      if (error instanceof ActorEscalation && failedDirective?.kind === 'run-actor') {
        return {
          result: escalateWorkflow(runId, failedDirective.step_id, {
            next_step: error.route,
            question: error.question,
            summary: error.summary,
          }),
          exitCode: 2,
        };
      }
      return {
        result: blockWorkflowOnRuntimeFailure(
          runId,
          failedDirective && 'step_id' in failedDirective ? failedDirective.step_id : null,
          stage,
          error,
        ),
        exitCode: 2,
      };
    }
  }
}

/** Starts or resumes one task-bound workflow, then drives it to a stop state. */
export async function runWorkflow(
  runId: string,
  inputFile: string,
  runtime: WorkflowRuntime = defaultRuntime(),
): Promise<CommandResult> {
  startOrResumeWorkflow(runId, inputFile);
  return driveWorkflow(runId, runtime);
}

function requireWorkflowBinding(
  workflow: Workflow,
  runId: string,
  inputFile: string,
  allowStart = false,
): void {
  try {
    const state = loadWorkflowState(runId).state;
    if (allowStart && state.status !== 'running' && loadIntent(runId)) {
      requireWorkflowInput(runId, workflow, inputFile);
      return;
    }
    if (state.manifest.workflow !== workflow) {
      throw new FlowError(
        `${workflow} command may only resume a ${workflow} workflow`,
        'authorization_error',
      );
    }
  } catch (error) {
    if (errorCode(error) !== 'no_flow') throw error;
    requireWorkflowInput(runId, workflow, inputFile);
  }
}

/** Parses one workflow-specific implementation CLI and dispatches its closed command set. */
export async function workflowMain(
  workflow: Workflow,
  argv: string[] = process.argv.slice(2),
): Promise<CommandResult> {
  const { command, flags } = parseCommand(argv);
  if (command === 'describe') {
    requireExactFlags(flags, []);
    return { result: describe(workflow), exitCode: 0 };
  }
  if (command === 'run') {
    requireExactFlags(flags, ['--input', '--run-id']);
    requireWorkflowBinding(workflow, flags['--run-id']!, flags['--input']!, true);
    return runWorkflow(flags['--run-id']!, flags['--input']!);
  }
  if (command === 'cancel') {
    requireExactFlags(flags, ['--input', '--run-id']);
    requireWorkflowBinding(workflow, flags['--run-id']!, flags['--input']!);
    return { result: cancelWorkflow(flags['--run-id']!, flags['--input']!), exitCode: 0 };
  }
  throw new FlowError(`unknown command: ${command}`);
}

/** Emits one stable JSON result for a workflow CLI. */
export function reportMain(result: Promise<CommandResult>): void {
  void result
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
