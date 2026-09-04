/** @file Outcome: Accepted implementation work has one deterministic receipt bound to its source. */

import crypto from 'node:crypto';

import { FlowError } from '../shared/errors.ts';
import type { ActorBinding, ActorReceipt, ActorResult } from './contracts.ts';
import { isObject, rejectUnknownKeys } from '../shared/schema.ts';

export const ACTOR_RESULT_PROTOCOL = 'codex-flow-actor-result' as const;
const ACTOR_RECEIPT_PROTOCOL = 'codex-flow-actor-receipt' as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(domain: string, value: unknown): string {
  return crypto.createHash('sha256').update(`${domain}\0`).update(canonical(value)).digest('hex');
}

function actorReceiptDigest(receipt: Omit<ActorReceipt, 'digest'>): string {
  return digest('codex-flow-actor-receipt', receipt);
}

export function createActorReceipt(
  binding: ActorBinding,
  result: ActorResult,
  sourceAfter: string,
  scopeDigest: string,
): ActorReceipt {
  const body: Omit<ActorReceipt, 'digest'> = {
    protocol: ACTOR_RECEIPT_PROTOCOL,
    binding,
    source_after_digest: sourceAfter,
    scope_digest: scopeDigest,
    summary: result.summary,
  };
  return { ...body, digest: actorReceiptDigest(body) };
}

export function validateReceipt(receipt: ActorReceipt): void {
  if (!isObject(receipt) || !isObject(receipt.binding)) {
    throw new FlowError('actor receipt has an invalid shape', 'state_error');
  }
  rejectUnknownKeys(
    receipt,
    ['protocol', 'binding', 'source_after_digest', 'scope_digest', 'summary', 'digest'],
    'actor receipt',
    'state_error',
  );
  rejectUnknownKeys(
    receipt.binding,
    ['run_id', 'workflow', 'step_id', 'attempt', 'input_source_digest'],
    'actor receipt binding',
    'state_error',
  );
  const { digest: actual, ...body } = receipt;
  if (
    receipt.protocol !== ACTOR_RECEIPT_PROTOCOL ||
    !/^[0-9a-f]{64}$/u.test(actual) ||
    !/^[0-9a-f]{64}$/u.test(receipt.source_after_digest) ||
    !/^[0-9a-f]{64}$/u.test(receipt.scope_digest) ||
    typeof receipt.summary !== 'string' ||
    !receipt.summary.trim() ||
    typeof receipt.binding.run_id !== 'string' ||
    receipt.binding.step_id !== 'implementation' ||
    (receipt.binding.workflow !== 'build' && receipt.binding.workflow !== 'code') ||
    !Number.isInteger(receipt.binding.attempt) ||
    receipt.binding.attempt < 1 ||
    !/^[0-9a-f]{64}$/u.test(receipt.binding.input_source_digest) ||
    actorReceiptDigest(body) !== actual
  ) {
    throw new FlowError('actor receipt is malformed or has an invalid digest', 'state_error');
  }
}

export function sameActorBinding(left: ActorBinding, right: ActorBinding): boolean {
  return canonical(left) === canonical(right);
}
