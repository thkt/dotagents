#!/usr/bin/env bun
/** @file Outcome: One command drives an armed flow through actors, actions, and gates to a terminal state. */

import { RESULT_PROTOCOL, type CommandResult, type FlowDirective } from './contracts.ts';
import { executeAction } from './build/actions.ts';
import { resetScreenshotAttachments } from './build/screenshots.ts';
import { ActorEscalation, CodexWorkflowAgent, type WorkflowAgent } from './agent.ts';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { isMainModule } from '../shared/environment.ts';
import { parseCommand, requireExactFlags } from '../shared/cli.ts';
import { runIsolatedActor, withRepositorySnapshot } from './isolation.ts';
import { ProgressReporter, workflowProgress, type ProgressContext } from '../shared/progress.ts';
import { repositoryInvariant, requireUnchangedRepository } from '../shared/repository.ts';
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

function progressContext(
  workflow: 'build' | 'code',
  directive: Exclude<FlowDirective, { kind: 'done' | 'ship-ready' | 'blocked' | 'cancelled' }>,
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
    case 'seal-gate':
      stage = 'controller_evidence_validation';
      break;
    case 'run-action':
      stage = `action_${directive.action}`;
      break;
    case 'calibrate-gate':
      stage = 'gate_calibration';
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
export async function driveWorkflow(
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
        directive.kind !== 'ship-ready' &&
        directive.kind !== 'blocked' &&
        directive.kind !== 'cancelled'
      ) {
        stage = progressContext(workflow, directive).stage;
      }
      switch (directive.kind) {
        case 'done':
        case 'ship-ready':
          return { result: workflowStatus(runId), exitCode: 0 };
        case 'blocked':
          return { result: workflowStatus(runId), exitCode: 2 };
        case 'cancelled':
          return { result: workflowStatus(runId), exitCode: 0 };
        case 'run-actor':
          await progress.run(progressContext(workflow, directive), async (stage) => {
            resetScreenshotAttachments(runId, directive.screenshots ?? []);
            await runIsolatedActor(repo, directive.files, (sandboxRepo) =>
              runtime.agent.runActor(sandboxRepo, directive, (activity) =>
                stage.activity(activity),
              ),
            );
            completeCurrentDirective(runId, directive.step_id);
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
            const review = await withRepositorySnapshot(repo, (snapshotRepo) =>
              runtime.agent.reviewBuild(snapshotRepo, directive, (activity) =>
                stage.activity(activity),
              ),
            );
            requireUnchangedRepository(before, repo, 'build semantic review');
            completeBuildReview(
              runId,
              directive.step_id,
              review,
              Math.max(0, Math.round(performance.now() - startedAt)),
            );
          });
          break;
        case 'calibrate-gate':
        case 'run-gate':
          progress.runSync(progressContext(workflow, directive), () =>
            completeCurrentDirective(runId, directive.step_id),
          );
          break;
        case 'seal-gate': {
          await progress.run(progressContext(workflow, directive), async (stage) => {
            const candidateId = await runtime.agent.selectEvidenceCandidate(
              repo,
              directive,
              (activity) => stage.activity(activity),
            );
            completeCurrentDirective(runId, directive.step_id, candidateId);
          });
          break;
        }
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
  if (command === 'cancel') {
    requireExactFlags(flags, ['--manifest', '--run-id']);
    return { result: cancelWorkflow(flags['--run-id']!, flags['--manifest']!), exitCode: 0 };
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
