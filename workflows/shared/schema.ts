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

export function requiredString(value: unknown, label: string, code = 'usage_error'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FlowError(`${label} must be a non-empty string`, code);
  }
  return value.trim();
}

export function nullableString(value: unknown, label: string, code = 'usage_error'): string | null {
  return value === null ? null : requiredString(value, label, code);
}

export function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
  code = 'usage_error',
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new FlowError(`${label} must be ${values.join(', ')}`, code);
  }
  return value as T;
}

export function objectArray(value: unknown, label: string, code = 'execution_error'): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    throw new FlowError(`${label} must be an array of objects`, code);
  }
  return value;
}
