import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isRecord } from '../shared/values.ts';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageShape = z
  .object({
    input_tokens: count,
    cached_input_tokens: count,
    output_tokens: count,
  })
  .refine((usage) => usage.cached_input_tokens <= usage.input_tokens);
export type Usage = z.infer<typeof usageShape>;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function sumUsage(values: Usage[]): Usage | null {
  if (!values.length) {
    return null;
  }
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  for (const value of values) {
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const) {
      total[key] += value[key];
      assert(Number.isSafeInteger(total[key]), 'Token sum exceeds safe integer range');
    }
  }
  return total;
}

interface Turn {
  ordinal: number;
  line: number;
  sha256: string;
  usage: Usage;
}
interface Stream {
  threadId: string | null;
  active: boolean;
  ordinal: number;
  turns: Turn[];
  problems: string[];
}

function consume(stream: Stream, event: Record<string, unknown>, line: number, raw: string) {
  switch (event.type) {
    case 'thread.started':
      assert(
        stream.threadId === null && typeof event.thread_id === 'string' && event.thread_id.trim(),
        'Duplicate or invalid thread identity',
      );
      stream.threadId = event.thread_id;
      break;
    case 'turn.started':
      assert(stream.threadId && !stream.active, 'Unmatched turn start');
      stream.ordinal++;
      stream.active = true;
      break;
    case 'turn.completed': {
      assert(stream.active, 'Duplicate or unmatched turn completion');
      stream.active = false;
      const parsed = usageShape.safeParse(event.usage);
      assert(parsed.success, 'Missing or invalid turn usage');
      stream.turns.push({ ordinal: stream.ordinal, line, sha256: hash(raw), usage: parsed.data });
      break;
    }
    case 'turn.failed':
      assert(stream.active, 'Unmatched failed turn');
      stream.active = false;
      stream.problems.push(`line ${line}: Failed turn has no complete usage`);
      break;
    case 'error':
      stream.problems.push(`line ${line}: CLI error; usage may be incomplete`);
      break;
  }
}

function eventError(error: unknown) {
  if (error instanceof SyntaxError) {
    return 'Invalid JSON';
  }
  return error instanceof Error ? error.message : 'Invalid event';
}

// Identity is thread + ordered turn start, never equality of token values.
export function readUsageEvents(raw: string) {
  const stream: Stream = { threadId: null, active: false, ordinal: 0, turns: [], problems: [] };
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event: unknown = JSON.parse(line);
      assert(isRecord(event) && typeof event.type === 'string', 'Invalid event');
      consume(stream, event, index + 1, line);
    } catch (error) {
      stream.problems.push(`line ${index + 1}: ${eventError(error)}; remaining events not counted`);
      break; // After an ambiguous boundary, later ordinals cannot establish event identity.
    }
  }
  if (!stream.threadId) {
    stream.problems.push('Missing thread identity');
  }
  if (stream.active) {
    stream.problems.push('Unfinished turn; usage missing');
  }
  if (!stream.turns.length) {
    stream.problems.push('No completed turn usage');
  }
  return {
    threadId: stream.threadId,
    turns: stream.turns,
    observed: sumUsage(stream.turns.map((turn) => turn.usage)),
    problems: stream.problems,
  };
}
