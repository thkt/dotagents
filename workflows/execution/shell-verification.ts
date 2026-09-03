#!/usr/bin/env bun
/** @file Outcome: One repository test command yields bounded evidence and a declared correction route. */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GATE_PROTOCOL, SAFE_ID, type GateOptions, type GateReport } from './contracts.ts';
import { isMainModule } from '../shared/environment.ts';
import { UsageError, errorMessage, usageError } from '../shared/errors.ts';
import { withoutGitHubCredentials } from '../shared/github.ts';

const PROTOCOL = GATE_PROTOCOL;
export const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TAIL_BYTES = 12_000;
const FLAGS = new Set([
  '--gate-id',
  '--failure-route',
  '--cwd',
  '--expect',
  '--command',
  '--timeout-ms',
  '--tail-bytes',
]);
const ROUTE_PATTERN = /^(?:blocked|direct:implementation)$/u;

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`${flag} must be a positive integer`);
  }
  return parsed;
}

/** Parses the internal shell-gate invocation. Test commands only ever expect success. */
export function parseArgs(argv: string[]): GateOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !FLAGS.has(flag)) throw usageError(`unknown argument: ${flag ?? ''}`);
    if (value === undefined || !value.length) throw usageError(`missing value for ${flag}`);
    if (values.has(flag)) throw usageError(`${flag} may be provided only once`);
    values.set(flag, value);
  }
  const gateId = values.get('--gate-id');
  if (!gateId) throw usageError('--gate-id is required');
  if (!SAFE_ID.test(gateId)) throw usageError('--gate-id has an invalid shape');
  const failureRoute = values.get('--failure-route');
  if (!failureRoute) throw usageError('--failure-route is required');
  if (!ROUTE_PATTERN.test(failureRoute)) {
    throw usageError('--failure-route must be blocked or direct:implementation');
  }
  const cwd = values.get('--cwd');
  if (!cwd) throw usageError('--cwd is required');
  if (!path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw usageError('--cwd must be an existing absolute directory');
  }
  if (values.get('--expect') !== 'pass') throw usageError('--expect must be pass');
  const command = values.get('--command');
  if (!command?.trim()) throw usageError('--command is required');
  return {
    gateId,
    failureRoute,
    cwd,
    expect: 'pass',
    command,
    timeoutMs: values.has('--timeout-ms')
      ? positiveInteger(values.get('--timeout-ms')!, '--timeout-ms')
      : DEFAULT_TIMEOUT_MS,
    tailBytes: values.has('--tail-bytes')
      ? positiveInteger(values.get('--tail-bytes')!, '--tail-bytes')
      : DEFAULT_TAIL_BYTES,
  };
}

function tail(buffer: Uint8Array | string | null | undefined, maxBytes: number): string {
  const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  const start = Math.max(0, value.length - maxBytes);
  if (start === 0 || value[start - 1] === 0x0a || value[start - 1] === 0x0d) {
    return value.subarray(start).toString('utf8');
  }
  const lineFeed = value.indexOf(0x0a, start);
  const carriageReturn = value.indexOf(0x0d, start);
  let lineEnd = value.length;
  if (lineFeed >= 0) lineEnd = Math.min(lineEnd, lineFeed);
  if (carriageReturn >= 0) lineEnd = Math.min(lineEnd, carriageReturn);
  if (lineEnd === value.length) return '';
  const nextLine =
    value[lineEnd] === 0x0d && value[lineEnd + 1] === 0x0a ? lineEnd + 2 : lineEnd + 1;
  return value.subarray(nextLine).toString('utf8');
}

/** Executes one test command with isolated GitHub credentials and bounded output. */
export function runShellVerification(options: GateOptions): {
  processExitCode: number;
  report: GateReport;
} {
  const startedAt = Date.now();
  const githubConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shell-no-gh-auth-'));
  const result = (() => {
    try {
      return spawnSync('/bin/zsh', ['-c', options.command], {
        cwd: options.cwd,
        encoding: null,
        timeout: options.timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: 64 * 1024 * 1024,
        env: withoutGitHubCredentials(process.env, githubConfig),
      });
    } finally {
      fs.rmSync(githubConfig, { recursive: true, force: true });
    }
  })();
  const durationMs = Date.now() - startedAt;
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = spawnError?.code === 'ETIMEDOUT';
  const executionError = spawnError && !timedOut ? spawnError.message : null;
  const interrupted = Boolean(result.signal) && !timedOut;
  const passed = result.status === 0 && !result.signal && !result.error;
  const verdict = timedOut || executionError || interrupted ? 'blocked' : passed ? 'pass' : 'fail';
  const reason = timedOut
    ? 'timeout'
    : executionError
      ? 'execution_error'
      : interrupted
        ? 'signal'
        : passed
          ? null
          : 'test_failed';
  const report: GateReport = {
    protocol: PROTOCOL,
    gate_id: options.gateId,
    verdict,
    classification: reason ?? 'pass',
    reason_codes: reason ? [reason] : [],
    failure_route:
      verdict === 'pass' ? null : verdict === 'blocked' ? 'blocked' : options.failureRoute,
    configured_failure_route: options.failureRoute,
    command: options.command,
    cwd: options.cwd,
    expected: 'pass',
    duration_ms: durationMs,
    evidence: {
      kind: 'shell',
      checks: [
        {
          kind: 'exit',
          expected: 'pass',
          actual: result.status,
          signal: result.signal,
          passed,
        },
      ],
      matches_expected_exit: passed,
      exit_code: result.status,
      signal: result.signal,
      timed_out: timedOut,
      execution_error: executionError,
      stdout_tail: tail(result.stdout, options.tailBytes),
      stderr_tail: tail(result.stderr, options.tailBytes),
    },
  };
  return { processExitCode: verdict === 'pass' ? 0 : verdict === 'blocked' ? 2 : 1, report };
}

function blockedReport(error: unknown) {
  const usage = error instanceof UsageError;
  return {
    protocol: PROTOCOL,
    gate_id: null,
    verdict: 'blocked' as const,
    classification: usage ? 'usage_error' : 'execution_error',
    reason_codes: [usage ? 'usage_error' : 'execution_error'],
    failure_route: 'blocked' as const,
    configured_failure_route: null,
    error: errorMessage(error),
  };
}

function main(): void {
  try {
    const { processExitCode, report } = runShellVerification(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = processExitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(blockedReport(error), null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (isMainModule(import.meta.url)) main();
