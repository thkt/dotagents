#!/usr/bin/env bun
/** @file Outcome: Each shell condition yields bounded, deterministic evidence and a declared failure route. */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GATE_PROTOCOL,
  SAFE_ID,
  type CalibrationCandidate,
  type GateCheck,
  type GateOptions,
  type GateReport,
  type GateVerdict,
} from './contracts.ts';
import { isMainModule } from '../shared/environment.ts';
import { UsageError, errorMessage, usageError } from '../shared/errors.ts';
import { withoutGitHubCredentials } from '../shared/github.ts';

const PROTOCOL = GATE_PROTOCOL;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_TAIL_BYTES = 12_000;
const MAX_CALIBRATION_CANDIDATES = 128;
const MAX_CALIBRATION_LINE_LENGTH = 2000;
const FAILURE_MARKER =
  /(?:^\s*not ok\b|^\s*(?:FAIL(?:ED|URE)?\b|ERROR\b|\(fail\)|[✖✕×✗❌●])|^\s*\d+\)\s+|\bFAILED\b|\bFAILURE\b)/iu;
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
const ROUTE_PATTERN =
  /^(?:blocked|triage|(?:red|green|direct):[A-Za-z0-9][A-Za-z0-9._-]*|cleanup:[A-Za-z0-9][A-Za-z0-9._-]*)$/;

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

/** Parses the closed shell-gate CLI contract into typed verifier options. */
export function parseArgs(argv: string[]): GateOptions {
  const options: Partial<GateOptions> &
    Pick<GateOptions, 'timeoutMs' | 'tailBytes' | 'requiredOutput' | 'forbiddenOutput'> = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    tailBytes: DEFAULT_TAIL_BYTES,
    requiredOutput: [],
    forbiddenOutput: [],
  };
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (!flag) throw usageError('argument name is required');
    if (!SINGLE_FLAGS.has(flag) && !REPEATABLE_FLAGS.has(flag)) {
      throw usageError(`unknown argument: ${flag}`);
    }
    if (value === undefined) throw usageError(`missing value for ${flag}`);
    if (SINGLE_FLAGS.has(flag) && seen.has(flag)) {
      throw usageError(`${flag} may be provided only once`);
    }
    if (!value.length) throw usageError(`${flag} must not be empty`);

    switch (flag) {
      case '--gate-id':
        options.gateId = value;
        break;
      case '--failure-route':
        options.failureRoute = value;
        break;
      case '--cwd':
        options.cwd = value;
        break;
      case '--expect':
        options.expect = value as GateOptions['expect'];
        break;
      case '--command':
        options.command = value;
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInteger(value, flag);
        break;
      case '--tail-bytes':
        options.tailBytes = parsePositiveInteger(value, flag);
        break;
      case '--require-output':
        options.requiredOutput.push(value);
        break;
      case '--forbid-output':
        options.forbiddenOutput.push(value);
        break;
    }

    if (SINGLE_FLAGS.has(flag)) seen.add(flag);
    index += 1;
  }

  if (!options.gateId) throw usageError('--gate-id is required');
  const gateId = options.gateId;
  if (!SAFE_ID.test(gateId)) {
    throw usageError('--gate-id has an invalid shape');
  }
  if (!options.failureRoute) throw usageError('--failure-route is required');
  if (!ROUTE_PATTERN.test(options.failureRoute)) {
    throw usageError(
      '--failure-route must be blocked, triage, red:<unit>, green:<unit>, direct:<unit>, or cleanup:<name>',
    );
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

  return {
    gateId,
    failureRoute: options.failureRoute,
    cwd: options.cwd,
    expect: options.expect,
    command: options.command,
    timeoutMs: options.timeoutMs,
    tailBytes: options.tailBytes,
    requiredOutput: options.requiredOutput,
    forbiddenOutput: options.forbiddenOutput,
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

/** Checks that evidence is one complete line observed in stdout or stderr. */
export function hasExactOutputLine(stdout: string, stderr: string, evidence: string): boolean {
  if (!evidence || /[\r\n]/u.test(evidence)) return false;
  const anchor = stableEvidenceLine(evidence);
  return [stdout, stderr].some((output) =>
    output.split(/\r\n?|\n/u).some((line) => stableEvidenceLine(line) === anchor),
  );
}

function stableEvidenceLine(text: string): string {
  return text.replace(/\s+\(\d+(?:\.\d+)?ms\)$/u, '');
}

interface PlannedFailure {
  id: string;
  name: string;
}

interface OutputLine {
  id: string;
  text: string;
}

function outputLines(stream: 'stdout' | 'stderr', output: string): OutputLine[] {
  return output.split(/\r\n?|\n/u).flatMap((text, index) => {
    if (!text.trim() || text.length > MAX_CALIBRATION_LINE_LENGTH) return [];
    return [{ id: `${stream}:L${index + 1}`, text }];
  });
}

function namesPlannedFailure(line: string, test: PlannedFailure): boolean {
  const nameAt = line.indexOf(test.name);
  if (nameAt < 0) return false;
  const context = `${line.slice(0, nameAt)}${line.slice(nameAt + test.name.length)}`;
  return FAILURE_MARKER.test(context);
}

/** Extracts bounded exact lines that can identify a failed planned scenario. */
export function calibrationCandidates(
  stdout: string,
  stderr: string,
  plannedTests: readonly PlannedFailure[] | null,
): CalibrationCandidate[] {
  const lines = [...outputLines('stdout', stdout), ...outputLines('stderr', stderr)];
  if (plannedTests === null) {
    const marked = lines.filter((line) => FAILURE_MARKER.test(line.text));
    return (marked.length ? marked : lines)
      .slice(-MAX_CALIBRATION_CANDIDATES)
      .map((line) => ({ ...line, text: stableEvidenceLine(line.text) }));
  }
  const candidates: CalibrationCandidate[] = [];
  const seen = new Set<string>();
  for (const test of plannedTests) {
    for (const line of lines) {
      if (
        candidates.length >= MAX_CALIBRATION_CANDIDATES ||
        !namesPlannedFailure(line.text, test)
      ) {
        continue;
      }
      const text = stableEvidenceLine(line.text);
      const key = `${test.id}\u0000${text}`;
      if (seen.has(key)) continue;
      candidates.push({ ...line, text, test_id: test.id });
      seen.add(key);
    }
  }
  return candidates;
}

/** Executes one command and reports bounded exit/output evidence deterministically. */
export function runShellVerification(
  options: GateOptions,
  plannedTests?: readonly PlannedFailure[] | null,
): {
  processExitCode: number;
  report: GateReport;
  candidates: CalibrationCandidate[];
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
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '');
  const stdoutText = stdout.toString('utf8');
  const stderrText = stderr.toString('utf8');
  const combinedOutput = `${stdoutText}\n${stderrText}`;
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = spawnError?.code === 'ETIMEDOUT';
  const executionError = spawnError && !timedOut ? spawnError.message : null;
  const interrupted = Boolean(result.signal) && !timedOut;
  const commandPassed = result.status === 0 && !result.signal && !result.error;
  const commandFailed =
    Number.isInteger(result.status) && result.status !== 0 && !result.signal && !result.error;
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
      passed: hasExactOutputLine(stdoutText, stderrText, value),
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
  const stdoutTail = tail(stdout, options.tailBytes);
  const stderrTail = tail(stderr, options.tailBytes);
  return {
    processExitCode,
    candidates:
      plannedTests === undefined ? [] : calibrationCandidates(stdoutText, stderrText, plannedTests),
    report: {
      protocol: PROTOCOL,
      gate_id: options.gateId,
      verdict,
      classification,
      reason_codes: reasonCodes,
      failure_route:
        verdict === 'pass' ? null : verdict === 'blocked' ? 'blocked' : options.failureRoute,
      configured_failure_route: options.failureRoute,
      command: options.command,
      cwd: options.cwd,
      expected: options.expect,
      duration_ms: durationMs,
      evidence: {
        kind: 'shell',
        checks,
        matches_expected_exit: expectedExitMatched,
        exit_code: result.status,
        signal: result.signal,
        timed_out: timedOut,
        execution_error: executionError,
        stdout_tail: stdoutTail,
        stderr_tail: stderrTail,
      },
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

function blockedReport(error: unknown): BlockedGateReport {
  const usage = error instanceof UsageError;
  return {
    protocol: PROTOCOL,
    gate_id: null,
    verdict: 'blocked',
    classification: usage ? 'usage_error' : 'execution_error',
    reason_codes: [usage ? 'usage_error' : 'execution_error'],
    failure_route: 'blocked',
    configured_failure_route: null,
    error: errorMessage(error),
  };
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { processExitCode, report } = runShellVerification(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = processExitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(blockedReport(error), null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (isMainModule(import.meta.url)) main();
