/** @file Outcome: Long workflow stages are observable on stderr without changing result contracts. */

import { errorCode } from './errors.ts';
import type { ModelActivity, StageTimings } from './codex.ts';

export type ProgressWorkflow = 'think' | 'research' | 'issue' | 'build' | 'code';
export type ProgressStatus = 'started' | 'still_running' | 'completed' | 'failed';
type TimingStage<T> = T extends `${infer Stage}_ms` ? Stage : never;
type WorkflowSpecificStage =
  | 'issue_draft'
  | 'issue_publish'
  | 'actor_model_call'
  | 'build_semantic_review'
  | 'gate_verification'
  | 'action_branch'
  | 'action_commit'
  | 'action_ship';

/** StageTimings names are canonical; workflow-specific mappings are closed here. */
export type ProgressStageName = TimingStage<keyof StageTimings> | WorkflowSpecificStage;

export interface ProgressContext {
  workflow: ProgressWorkflow;
  stage: ProgressStageName;
  attempt?: number;
  unit_id?: string;
}

export interface ProgressEvent extends ProgressContext {
  status: ProgressStatus;
  elapsed_ms: number;
  classification?: string;
  event_type?: ModelActivity['event_type'];
  item_type?: ModelActivity['item_type'];
  event_count?: number;
}

interface IntervalHandle {
  unref?: () => void;
}

export interface ProgressReporterOptions {
  write?: (line: string) => void;
  now?: () => number;
  heartbeatMs?: number;
  setInterval?: (callback: () => void, milliseconds: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
}

export interface ProgressStage {
  activity(activity: ModelActivity): void;
  complete(): void;
  fail(error: unknown): void;
}

function failureClassification(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'timeout';
  }
  return errorCode(error) ?? 'execution_error';
}

/** Emits bounded progress records; all telemetry-side failures are deliberately ignored. */
export class ProgressReporter {
  private readonly write: (line: string) => void;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly schedule: (callback: () => void, milliseconds: number) => IntervalHandle;
  private readonly cancel: (handle: IntervalHandle) => void;

  constructor(options: ProgressReporterOptions = {}) {
    this.write = options.write ?? ((line) => process.stderr.write(line));
    this.now = options.now ?? (() => performance.now());
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.schedule =
      options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    this.cancel = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  start(context: ProgressContext): ProgressStage {
    let startedAt = 0;
    try {
      startedAt = this.now();
    } catch {
      // A broken telemetry clock must not affect the workflow.
    }
    let finished = false;
    let timer: IntervalHandle | undefined;
    let latestActivity: ModelActivity | undefined;
    const emit = (
      status: ProgressStatus,
      classification?: string,
      activity?: ModelActivity,
    ): void => {
      try {
        const elapsed = Math.max(0, Math.round(this.now() - startedAt));
        const event: ProgressEvent = {
          ...context,
          status,
          elapsed_ms: status === 'started' ? 0 : elapsed,
          ...(classification ? { classification } : {}),
          ...activity,
        };
        this.write(`${JSON.stringify(event)}\n`);
      } catch {
        // Telemetry is best-effort and never changes a workflow verdict.
      }
    };
    const finish = (status: 'completed' | 'failed', error?: unknown): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) {
        try {
          this.cancel(timer);
        } catch {
          // Cleanup failure is telemetry-only.
        }
      }
      emit(status, status === 'failed' ? failureClassification(error) : undefined);
    };
    const activity = (event: ModelActivity): void => {
      if (!finished) latestActivity = event;
    };

    emit('started');
    try {
      timer = this.schedule(() => {
        if (!finished) emit('still_running', undefined, latestActivity);
      }, this.heartbeatMs);
      timer.unref?.();
    } catch {
      // A missing heartbeat must not stop the stage.
    }
    return {
      activity,
      complete: () => finish('completed'),
      fail: (error) => finish('failed', error),
    };
  }

  async run<T>(
    context: ProgressContext,
    operation: (stage: ProgressStage) => Promise<T>,
  ): Promise<T> {
    const stage = this.start(context);
    try {
      const result = await operation(stage);
      stage.complete();
      return result;
    } catch (error) {
      stage.fail(error);
      throw error;
    }
  }

  runSync<T>(context: ProgressContext, operation: () => T): T {
    const stage = this.start(context);
    try {
      const result = operation();
      stage.complete();
      return result;
    } catch (error) {
      stage.fail(error);
      throw error;
    }
  }
}

export const workflowProgress = new ProgressReporter();
