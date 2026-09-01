/** @file Outcome: Runtime JSON validation rejects open or malformed values consistently. */

import { FlowError } from './errors.ts';

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  label: string,
  code = 'usage_error',
): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !accepted.has(key));
  if (unknown.length) throw new FlowError(`${label} has unknown key: ${unknown.join(', ')}`, code);
}

export function stringArray(value: unknown, label: string, code = 'usage_error'): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.length)) {
    throw new FlowError(`${label} must be an array of non-empty strings`, code);
  }
  return value;
}
