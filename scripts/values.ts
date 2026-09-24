import { isAbsolute, relative, sep } from 'node:path';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// Callers validate the executable name; this guard checks only the argv shape.
export function isCommandArray(value: unknown): value is [string, ...string[]] {
  return (
    isArray(value) &&
    typeof value[0] === 'string' &&
    value.every((part) => typeof part === 'string')
  );
}

export function outside(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

export function relativeDirectory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !isAbsolute(value) &&
    value.split('/').every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part)) &&
    !value.split('/').some((part) => part === '.git' || part === 'node_modules')
  );
}
