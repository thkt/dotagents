/** @file Outcome: Structured prompt data remains inert and bounded by nonce markers. */

import crypto from 'node:crypto';

export function inertJsonBlock(label: string, value: unknown): string {
  const nonce = crypto.randomUUID();
  return [
    `----- BEGIN ${label} ${nonce} -----`,
    JSON.stringify(value),
    `----- END ${label} ${nonce} -----`,
  ].join('\n');
}
