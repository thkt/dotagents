/** @file Outcome: Every workflow SDK thread uses the signed-in Codex account and one shared response boundary. */

import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
} from '@openai/codex-sdk';

import { sandboxCodexEnvironment } from './codex-home.ts';
import { FlowError } from './errors.ts';
import { isObject, rejectUnknownKeys, type JsonObject } from './schema.ts';

/** Read-only investigation and decision threads always use the strongest reasoning profile. */
const THINKING_THREAD_OPTIONS = {
  model: 'gpt-5.6-sol',
  modelReasoningEffort: 'high',
} as const satisfies ThreadOptions;

/** Read-only investigation and decision threads work inside one repository snapshot and never call out. */
export function readOnlyThreadOptions(workingDirectory: string): ThreadOptions {
  return {
    ...THINKING_THREAD_OPTIONS,
    workingDirectory,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
  };
}

/** Repository-editing actors always use the lightweight implementation profile. */
export const IMPLEMENTATION_THREAD_OPTIONS = {
  model: 'gpt-5.6-luna',
  modelReasoningEffort: 'low',
} as const satisfies ThreadOptions;

interface ThreadResult {
  finalResponse: string;
}

const DEFAULT_MODEL_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface ModelActivity {
  event_type: ThreadEvent['type'];
  item_type?: ThreadItem['type'];
  event_count: number;
}

export type ModelActivitySink = (activity: ModelActivity) => void;

interface ModelRunPolicy {
  /** Human-readable stage name used only in the bounded idle error. */
  label: string;
  /** Stable workflow classification for an idle model. */
  idleCode: string;
  /** Inactivity window. This is deliberately not an absolute turn deadline. */
  idleTimeoutMs?: number;
  /** Receives safe event metadata only; model text and tool arguments never cross this boundary. */
  onActivity?: ModelActivitySink;
}

export interface CodexTurnOptions extends TurnOptions {
  modelRun: ModelRunPolicy;
}

interface CodexThreadLike {
  run(input: string, options: CodexTurnOptions): Promise<ThreadResult>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

type StreamedThreadLike = Pick<Thread, 'runStreamed'>;
export type IdleTimer = (callback: () => void, milliseconds: number) => () => void;
const idleTimer: IdleTimer = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};

function modelActivity(event: ThreadEvent, eventCount: number): ModelActivity {
  return {
    event_type: event.type,
    ...('item' in event ? { item_type: event.item.type } : {}),
    event_count: eventCount,
  };
}

/**
 * Consumes the SDK event stream, resetting the watchdog on every real event.
 * Only an inactive stream is stopped; a model that keeps making progress has no wall-clock deadline.
 */
export async function runStreamedCodexTurn(
  thread: StreamedThreadLike,
  input: string,
  options: CodexTurnOptions,
  startIdleTimer: IdleTimer = idleTimer,
): Promise<ThreadResult> {
  const { modelRun, signal: callerSignal, ...turnOptions } = options;
  const timeoutMs = modelRun.idleTimeoutMs ?? DEFAULT_MODEL_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new FlowError(`${modelRun.label} idle timeout must be a positive finite number`);
  }

  const idleController = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, idleController.signal])
    : idleController.signal;
  let cancelIdle = (): void => undefined;
  let idleFailure: FlowError | undefined;
  let eventCount = 0;
  let lastActivity = 'request_started';
  let finalResponse = '';
  let completed = false;
  let terminalFailed = false;
  let streamError: Error | undefined;

  const armWatchdog = (): void => {
    cancelIdle();
    cancelIdle = startIdleTimer(() => {
      idleFailure = new FlowError(
        `${modelRun.label} produced no SDK event for ${timeoutMs}ms; last activity: ${lastActivity}; events: ${eventCount}`,
        modelRun.idleCode,
      );
      idleController.abort(idleFailure);
    }, timeoutMs);
  };

  armWatchdog();
  try {
    const { events } = await thread.runStreamed(input, { ...turnOptions, signal });
    for await (const event of events) {
      eventCount += 1;
      const activity = modelActivity(event, eventCount);
      if (event.type !== 'error') {
        lastActivity = activity.item_type
          ? `${activity.event_type}:${activity.item_type}`
          : event.type;
        armWatchdog();
      }
      try {
        modelRun.onActivity?.(activity);
      } catch {
        // Observability is best-effort and never changes the model verdict.
      }

      if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        finalResponse = event.item.text;
      } else if (event.type === 'turn.completed') {
        completed = true;
      } else if (event.type === 'turn.failed') {
        terminalFailed = true;
        throw new Error(event.error.message);
      } else if (event.type === 'error') {
        // The CLI can emit reconnect diagnostics before a later lifecycle terminal.
        // Preserve the latest diagnostic, but let turn.completed or turn.failed decide the verdict.
        streamError = new Error(event.message);
      }
    }
    if (!completed) {
      if (streamError) throw new FlowError(streamError.message, 'model_unavailable');
      throw new FlowError(
        `${modelRun.label} stream ended without turn.completed`,
        'execution_error',
      );
    }
    return { finalResponse };
  } catch (error) {
    if (idleFailure) {
      if (streamError) {
        throw new FlowError(
          `${idleFailure.message}; last stream error: ${streamError.message}`,
          'model_unavailable',
        );
      }
      throw idleFailure;
    }
    if (streamError && !terminalFailed) {
      throw new FlowError(streamError.message, 'model_unavailable');
    }
    throw error;
  } finally {
    cancelIdle();
  }
}

class StreamingCodexClient implements CodexClientLike {
  private readonly client: Codex;

  constructor(client: Codex) {
    this.client = client;
  }

  startThread(options?: ThreadOptions): CodexThreadLike {
    const thread: Thread = this.client.startThread(options);
    return {
      run: (input, turnOptions) => runStreamedCodexTurn(thread, input, turnOptions),
    };
  }
}

export interface StageTimings {
  repository_snapshot_ms: number;
  investigator_model_call_ms: number;
  investigator_structured_validation_ms: number;
  auditor_model_call_ms: number;
  auditor_structured_validation_ms: number;
  designer_model_call_ms: number;
  designer_structured_validation_ms: number;
  reviewer_model_call_ms: number;
  reviewer_structured_validation_ms: number;
  controller_evidence_validation_ms: number;
}

export const STAGE_TIMING_KEYS = [
  'repository_snapshot_ms',
  'investigator_model_call_ms',
  'investigator_structured_validation_ms',
  'auditor_model_call_ms',
  'auditor_structured_validation_ms',
  'designer_model_call_ms',
  'designer_structured_validation_ms',
  'reviewer_model_call_ms',
  'reviewer_structured_validation_ms',
  'controller_evidence_validation_ms',
] as const satisfies readonly (keyof StageTimings)[];

export function emptyStageTimings(): StageTimings {
  return Object.fromEntries(STAGE_TIMING_KEYS.map((key) => [key, 0])) as unknown as StageTimings;
}

export function parseStageTimings(
  value: unknown,
  label: string,
  code?: ConstructorParameters<typeof FlowError>[1],
): StageTimings {
  if (
    !isObject(value) ||
    STAGE_TIMING_KEYS.some(
      (key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0,
    )
  ) {
    throw new FlowError(`${label} must contain non-negative finite milliseconds`, code);
  }
  rejectUnknownKeys(value, STAGE_TIMING_KEYS, label, code);
  return Object.fromEntries(
    STAGE_TIMING_KEYS.map((key) => [key, value[key] as number]),
  ) as unknown as StageTimings;
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function createSignedInCodexClient(env: NodeJS.ProcessEnv = process.env): CodexClientLike {
  return new StreamingCodexClient(new Codex({ env: sandboxCodexEnvironment(env) }));
}

/** Normalizes malformed SDK output before workflow-specific parsing. */
export function structuredResponseObject(text: string, label: string): JsonObject {
  try {
    const value = JSON.parse(text) as unknown;
    if (isObject(value)) return value;
  } catch {
    // The SDK schema is authoritative; this only normalizes its failure mode.
  }
  throw new FlowError(`${label} returned invalid structured output`, 'execution_error');
}
