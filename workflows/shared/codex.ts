/** @file Outcome: Every workflow SDK thread uses the signed-in Codex account and one shared response boundary. */

import { Codex, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';

import { FlowError } from './errors.ts';
import { isObject, type JsonObject } from './schema.ts';

/** Read-only investigation and decision threads always use the strongest reasoning profile. */
export const THINKING_THREAD_OPTIONS = {
  model: 'gpt-5.6-sol',
  modelReasoningEffort: 'high',
} as const satisfies ThreadOptions;

/** Repository-editing actors always use the lightweight implementation profile. */
export const IMPLEMENTATION_THREAD_OPTIONS = {
  model: 'gpt-5.6-luna',
  modelReasoningEffort: 'low',
} as const satisfies ThreadOptions;

interface ThreadResult {
  finalResponse: string;
}

export interface CodexThreadLike {
  run(input: string, options?: TurnOptions): Promise<ThreadResult>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
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
