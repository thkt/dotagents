/** @file Outcome: Workflow CLIs parse strict inputs and emit stable results and errors. */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { FlowError, UsageError, errorMessage, usageError, errorCode } from '../shared/errors.ts';
import { normalizeRepoPath } from '../shared/repository.ts';

export type CliResult<Report = unknown> =
  | { report: Report; exitCode?: number }
  | { output: string; exitCode?: number };

export interface ParsedCommand {
  command: string;
  flags: Record<string, string>;
}

/** Parses one command followed by name/value flags without accepting duplicates. */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const [command, ...args] = argv;
  if (!command) throw new FlowError('command is required');
  if (args.length % 2) throw new FlowError(`missing value for ${args.at(-1)}`);
  const flags: Record<string, string> = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1]!;
    if (!/^--[a-z-]+$/u.test(flag) || !value) throw new FlowError(`invalid argument: ${flag}`);
    if (Object.hasOwn(flags, flag)) throw new FlowError(`${flag} may be provided only once`);
    flags[flag] = value;
  }
  return { command, flags };
}

/** Rejects missing and unrecognized flags for one closed CLI command. */
export function requireExactFlags(
  flags: Record<string, string>,
  expected: readonly string[],
): void {
  const actual = Object.keys(flags);
  const invalid = actual.filter((flag) => !expected.includes(flag));
  const missing = expected.filter((flag) => !flags[flag]);
  if (invalid.length) throw new FlowError(`unsupported flag: ${invalid.join(', ')}`);
  if (missing.length) throw new FlowError(`${missing.join(', ')} is required`);
}

export function parseSingletonArgs(
  argv: readonly string[],
  allowed: ReadonlySet<string>,
): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag) throw usageError('argument name is required');
    if (!allowed.has(flag)) throw usageError(`unknown argument: ${flag}`);
    if (value === undefined || value === '') throw usageError(`missing value for ${flag}`);
    if (Object.hasOwn(options, flag)) throw usageError(`${flag} may be provided only once`);
    options[flag] = value;
    index += 1;
  }
  return options;
}

export function absoluteExistingPath(
  value: string | undefined,
  flag: string,
  kind: 'file' | 'directory',
): string {
  if (!value) throw usageError(`${flag} is required`);
  if (!path.isAbsolute(value)) throw usageError(`${flag} must be absolute`);
  let stat;
  try {
    stat = fs.statSync(value);
  } catch {
    throw usageError(`${flag} does not exist`);
  }
  if (kind === 'file' && !stat.isFile()) throw usageError(`${flag} must be a file`);
  if (kind === 'directory' && !stat.isDirectory()) throw usageError(`${flag} must be a directory`);
  return value;
}

export function readJsonFile(value: string | undefined, flag = '--input'): unknown {
  const input = absoluteExistingPath(value, flag, 'file');
  try {
    return JSON.parse(fs.readFileSync(input, 'utf8'));
  } catch (error) {
    throw usageError(`${flag} must contain valid JSON: ${errorMessage(error)}`);
  }
}

export function safeRepoPath(value: unknown): value is string {
  return normalizeRepoPath(value) !== null;
}

export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  encoding: null,
): SpawnSyncReturns<Buffer>;
export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  encoding?: BufferEncoding,
): SpawnSyncReturns<string>;
export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  encoding: BufferEncoding | null = 'utf8',
): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const options = { cwd, maxBuffer: 64 * 1024 * 1024, env: process.env };
  return encoding === null
    ? spawnSync(command, [...args], { ...options, encoding: null })
    : spawnSync(command, [...args], { ...options, encoding });
}

function blockedReport(protocol: string, error: unknown) {
  const usage = error instanceof UsageError;
  return {
    protocol,
    verdict: 'blocked' as const,
    classification: usage ? 'usage_error' : 'execution_error',
    reason_codes: [usage ? 'usage_error' : 'execution_error'],
    failure_route: 'blocked' as const,
    error: errorMessage(error),
  };
}

export function cli(main: () => CliResult, protocol: string): void {
  try {
    const result = main();
    process.stdout.write(
      'output' in result ? result.output : `${JSON.stringify(result.report, null, 2)}\n`,
    );
    process.exitCode = result.exitCode ?? 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(blockedReport(protocol, error), null, 2)}\n`);
    process.exitCode = 2;
  }
}

export function readAbsoluteJson(file: string, label: string): unknown {
  if (!path.isAbsolute(file)) throw new FlowError(`${label} must be absolute`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new FlowError(`${label} is unreadable JSON: ${errorMessage(error)}`);
  }
}

export function writeCliResult(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
export function cliErrorResult(protocol: string, error: unknown): Record<string, unknown> {
  return {
    protocol,
    status: 'blocked',
    classification: errorCode(error) ?? 'execution_error',
    error: errorMessage(error),
  };
}
export function writeCliError(protocol: string, error: unknown): void {
  writeCliResult(cliErrorResult(protocol, error));
  process.exitCode = 2;
}

export function runCli(main: () => unknown, protocol: string): void {
  void Promise.resolve()
    .then(main)
    .then(writeCliResult)
    .catch((error: unknown) => writeCliError(protocol, error));
}
