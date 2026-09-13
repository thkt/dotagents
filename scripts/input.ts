import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';

export function relativeDirectory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !isAbsolute(value) &&
    value.split('/').every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part)) &&
    !value.split('/').some((part) => part === '.git' || part === 'node_modules')
  );
}

export type ActorRole = 'repair' | 'review';
const stopReasons = [
  'writing_failed',
  'execution_limit',
  'repair_failed',
  'review_failed',
  'requirements_changed',
  'source_changed',
  'check_unavailable',
  'capture_unavailable',
  'capture_timeout',
  'invalid_review',
  'invalid_repair',
  'human_decision_required',
  'ready_for_human_review',
  'target_changed_after_stop',
] as const;
export type StopReason = (typeof stopReasons)[number];
export interface Config {
  cwd: string;
  runDir: string;
  issue: string[];
  check: string[];
  capture?: string[];
  captureDestination?: string;
  captureRequired?: boolean;
  writing?: string[];
  repair: string[];
  review: string[];
  repairLimit: number;
  reviewLimit: number;
  modelTimeMs: number;
  checkTimeMs: number;
}
interface Event {
  role: ActorRole | 'check' | 'capture' | 'writing';
  source?: string;
  code: number | null;
  timedOut: boolean;
  ms?: number;
  prefix: string;
}
export interface State {
  configHash: string;
  issueHash: string;
  repair: number;
  review: number;
  checks: number;
  modelMs: number;
  active: { role: ActorRole | 'check' | 'capture' | 'writing'; prefix: string } | null;
  events: Event[];
  source?: string;
  captureSource?: string;
  result?: StopReason | null;
  findings?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => nonnegative(value) && Number.isInteger(value);
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
const role = (value: unknown) =>
  value === 'writing' ||
  value === 'check' ||
  value === 'repair' ||
  value === 'review' ||
  value === 'capture';
const command = (value: unknown) =>
  isArray(value) &&
  typeof value[0] === 'string' &&
  value[0].length > 0 &&
  value.every((v) => typeof v === 'string');

export function assertConfig(value: unknown): asserts value is Config {
  assert(isRecord(value), 'Invalid configuration object');
  for (const key of ['cwd', 'runDir']) {
    assert(typeof value[key] === 'string' && value[key].length > 0, `Invalid ${key}`);
  }
  for (const key of ['issue', 'check', 'repair', 'review']) {
    assert(command(value[key]), `Invalid ${key} command`);
  }
  assert(value.writing === undefined || command(value.writing), 'Invalid writing command');
  assert(value.capture === undefined || command(value.capture), 'Invalid capture command');
  assert(
    value.captureRequired !== true || command(value.capture),
    'Required capture command missing',
  );
  if (value.capture) {
    assert(relativeDirectory(value.captureDestination), 'Invalid capture destination');
    assert(typeof value.captureRequired === 'boolean', 'Explicit capture requirement required');
  }
  for (const key of ['repairLimit', 'reviewLimit']) {
    const limit: unknown = value[key];
    assert(count(limit) && limit > 0, `Invalid ${key}`);
  }
  for (const key of ['modelTimeMs', 'checkTimeMs']) {
    const limit: unknown = value[key];
    assert(nonnegative(limit) && limit > 0, `Invalid ${key}`);
  }
}
function isEvent(value: unknown): value is Event {
  if (!isRecord(value)) {
    return false;
  }
  return (
    role(value.role) &&
    optionalString(value.source) &&
    (value.code === null || count(value.code)) &&
    typeof value.timedOut === 'boolean' &&
    (value.ms === undefined || nonnegative(value.ms)) &&
    typeof value.prefix === 'string'
  );
}
function validResult(value: unknown) {
  return value === undefined || value === null || stopReasons.some((reason) => reason === value);
}
export function assertState(value: unknown): asserts value is State {
  assert(isRecord(value), 'Invalid saved state');
  assert(
    typeof value.configHash === 'string' && typeof value.issueHash === 'string',
    'Invalid saved hashes',
  );
  assert(
    ['repair', 'review', 'checks'].every((key) => count(value[key])) && nonnegative(value.modelMs),
    'Invalid saved usage',
  );
  assert(
    value.active === null ||
      (isRecord(value.active) &&
        role(value.active.role) &&
        typeof value.active.prefix === 'string'),
    'Invalid active reservation',
  );
  assert(isArray(value.events) && value.events.every(isEvent), 'Invalid saved events');
  assert(optionalString(value.findings), 'Invalid saved findings');
  assert(optionalString(value.captureSource), 'Invalid saved capture source');
  assert(optionalString(value.source) && validResult(value.result), 'Invalid saved result');
}
