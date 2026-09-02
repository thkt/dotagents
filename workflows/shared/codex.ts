/** @file Outcome: Every workflow SDK thread uses the signed-in Codex account and one shared response boundary. */

import { Codex, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';

import { FlowError } from './errors.ts';
import { isObject, rejectUnknownKeys, type JsonObject } from './schema.ts';

/** Read-only investigation and decision threads always use the strongest reasoning profile. */
export const THINKING_THREAD_OPTIONS = {
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

interface CodexThreadLike {
  run(input: string, options?: TurnOptions): Promise<ThreadResult>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
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

/** Removes API-key overrides so workflow agents consume the signed-in Codex account. */
export function cleanCodexEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'OPENAI_API_KEY' && entry[0] !== 'CODEX_API_KEY',
    ),
  );
}

export function createSignedInCodexClient(env: NodeJS.ProcessEnv = process.env): CodexClientLike {
  return new Codex({ env: cleanCodexEnvironment(env) });
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
