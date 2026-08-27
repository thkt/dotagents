#!/usr/bin/env node

// Shared command-level gate authority for controlled workflows.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  GATE_PROTOCOL,
  type GateCheck,
  type GateOptions,
  type GateReport,
  type GateVerdict,
} from './contracts.ts';

export const PROTOCOL = GATE_PROTOCOL;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_TAIL_BYTES = 12_000;
const SINGLE_FLAGS = new Set([
  '--gate-id',
  '--failure-route',
  '--cwd',
  '--expect',
  '--command',
  '--timeout-ms',
  '--tail-bytes',
]);
const REPEATABLE_FLAGS = new Set(['--require-output', '--forbid-output']);
const ROUTE_PATTERN = /^(?:blocked|triage|(?:red|green|direct):[A-Za-z0-9][A-Za-z0-9._-]*|cleanup:[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const GATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

class UsageError extends Error {
  readonly code = 'USAGE';
}

function usageError(message: string): UsageError {
  return new UsageError(message);
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function existingDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function parseArgs(argv: string[]): GateOptions {
  const options: Partial<GateOptions> & Pick<GateOptions, 'timeoutMs' | 'tailBytes' | 'requiredOutput' | 'forbiddenOutput'> = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    tailBytes: DEFAULT_TAIL_BYTES,
    requiredOutput: [],
    forbiddenOutput: [],
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (!SINGLE_FLAGS.has(flag) && !REPEATABLE_FLAGS.has(flag)) {
      throw usageError(`unknown argument: ${flag}`);
    }
    if (value === undefined) throw usageError(`missing value for ${flag}`);
    if (SINGLE_FLAGS.has(flag) && seen.has(flag)) {
      throw usageError(`${flag} may be provided only once`);
    }
    if (!value.length) throw usageError(`${flag} must not be empty`);

    if (flag === '--gate-id') options.gateId = value;
    if (flag === '--failure-route') options.failureRoute = value;
    if (flag === '--cwd') options.cwd = value;
    if (flag === '--expect') options.expect = value as GateOptions['expect'];
    if (flag === '--command') options.command = value;
    if (flag === '--timeout-ms') options.timeoutMs = parsePositiveInteger(value, flag);
    if (flag === '--tail-bytes') options.tailBytes = parsePositiveInteger(value, flag);
    if (flag === '--require-output') options.requiredOutput.push(value);
    if (flag === '--forbid-output') options.forbiddenOutput.push(value);

    if (SINGLE_FLAGS.has(flag)) seen.add(flag);
    index += 1;
  }

  if (!options.gateId) throw usageError('--gate-id is required');
  const gateId = options.gateId;
  if (!GATE_ID_PATTERN.test(gateId) || gateId.length > 128) {
    throw usageError('--gate-id has an invalid shape');
  }
  if (!options.failureRoute) throw usageError('--failure-route is required');
  if (!ROUTE_PATTERN.test(options.failureRoute)) {
    throw usageError('--failure-route must be blocked, triage, red:<unit>, green:<unit>, direct:<unit>, or cleanup:<name>');
  }
  if (!options.cwd) throw usageError('--cwd is required');
  if (!path.isAbsolute(options.cwd)) throw usageError('--cwd must be absolute');
  if (!existingDirectory(options.cwd)) throw usageError('--cwd must be an existing directory');
  if (options.expect !== 'pass' && options.expect !== 'fail') {
    throw usageError('--expect must be pass or fail');
  }
  if (!options.command || !options.command.trim()) throw usageError('--command is required');
  if (options.expect === 'fail' && !options.requiredOutput.length) {
    throw usageError('--expect fail requires at least one --require-output anchor');
  }

  return options as GateOptions;
}

export function tail(buffer: Uint8Array | string | null | undefined, maxBytes: number): string {
  const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  return value.subarray(Math.max(0, value.length - maxBytes)).toString('utf8');
}

export function runVerification(options: GateOptions): { processExitCode: number; report: GateReport } {
  const startedAt = Date.now();
  const result = spawnSync('/bin/zsh', ['-c', options.command], {
    cwd: options.cwd,
    encoding: null,
    timeout: options.timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '');
  const combinedOutput = `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`;
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = spawnError?.code === 'ETIMEDOUT';
  const executionError = spawnError && !timedOut ? spawnError.message : null;
  const interrupted = Boolean(result.signal) && !timedOut;
  const commandPassed = result.status === 0 && !result.signal && !result.error;
  const commandFailed = Number.isInteger(result.status) && result.status !== 0 && !result.signal && !result.error;
  const expectedExitMatched = options.expect === 'pass' ? commandPassed : commandFailed;

  const checks: GateCheck[] = [
    {
      kind: 'exit',
      expected: options.expect,
      actual: result.status,
      signal: result.signal,
      passed: expectedExitMatched,
    },
    ...options.requiredOutput.map((value) => ({
      kind: 'output_includes' as const,
      value,
      passed: combinedOutput.includes(value),
    })),
    ...options.forbiddenOutput.map((value) => ({
      kind: 'output_excludes' as const,
      value,
      passed: !combinedOutput.includes(value),
    })),
  ];

  const reasonCodes: string[] = [];
  let verdict: GateVerdict;
  let processExitCode: number;
  if (timedOut) {
    verdict = 'blocked';
    processExitCode = 124;
    reasonCodes.push('timeout');
  } else if (executionError) {
    verdict = 'blocked';
    processExitCode = 2;
    reasonCodes.push('execution_error');
  } else if (interrupted) {
    verdict = 'blocked';
    processExitCode = 2;
    reasonCodes.push('signal');
  } else {
    if (!expectedExitMatched) {
      reasonCodes.push(options.expect === 'fail' ? 'unexpected_pass' : 'unexpected_failure');
    }
    if (checks.some((check) => check.kind === 'output_includes' && !check.passed)) {
      reasonCodes.push('missing_required_output');
    }
    if (checks.some((check) => check.kind === 'output_excludes' && !check.passed)) {
      reasonCodes.push('forbidden_output');
    }
    verdict = reasonCodes.length ? 'fail' : 'pass';
    processExitCode = verdict === 'pass' ? 0 : 1;
  }

  const classification =
    reasonCodes[0] || (options.expect === 'fail' ? 'expected_failure' : 'pass');
  return {
    processExitCode,
    report: {
      protocol: PROTOCOL,
      gate_id: options.gateId,
      verdict,
      classification,
      reason_codes: reasonCodes,
      failure_route: verdict === 'pass' ? null : verdict === 'blocked' ? 'blocked' : options.failureRoute,
      configured_failure_route: options.failureRoute,
      command: options.command,
      cwd: options.cwd,
      expected: options.expect,
      checks,
      matches_expected_exit: expectedExitMatched,
      exit_code: result.status,
      signal: result.signal,
      timed_out: timedOut,
      execution_error: executionError,
      duration_ms: durationMs,
      stdout_tail: tail(stdout, options.tailBytes),
      stderr_tail: tail(stderr, options.tailBytes),
    },
  };
}

interface BlockedGateReport {
  protocol: typeof GATE_PROTOCOL;
  gate_id: null;
  verdict: 'blocked';
  classification: 'usage_error' | 'execution_error';
  reason_codes: Array<'usage_error' | 'execution_error'>;
  failure_route: 'blocked';
  configured_failure_route: null;
  error: string;
}

export function blockedReport(error: unknown): BlockedGateReport {
  const usage = error instanceof UsageError;
  return {
    protocol: PROTOCOL,
    gate_id: null,
    verdict: 'blocked',
    classification: usage ? 'usage_error' : 'execution_error',
    reason_codes: [usage ? 'usage_error' : 'execution_error'],
    failure_route: 'blocked',
    configured_failure_route: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { processExitCode, report } = runVerification(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = processExitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(blockedReport(error), null, 2)}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
