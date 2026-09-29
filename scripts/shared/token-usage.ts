import { isRecord } from './values.ts';

export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

const keys = ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const;
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const { input_tokens, cached_input_tokens, output_tokens } = value;
  if (!isCount(input_tokens) || !isCount(cached_input_tokens) || !isCount(output_tokens)) {
    return null;
  }
  return {
    input_tokens,
    cached_input_tokens,
    output_tokens,
  };
}

export function addTokenUsage(total: TokenUsage, value: TokenUsage): TokenUsage | null {
  const next = {
    input_tokens: total.input_tokens + value.input_tokens,
    cached_input_tokens: total.cached_input_tokens + value.cached_input_tokens,
    output_tokens: total.output_tokens + value.output_tokens,
  };
  return keys.every((key) => Number.isSafeInteger(next[key])) ? next : null;
}
