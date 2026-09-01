/** @file Outcome: Build CLIs share strict input, path, process, and result handling. */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import { UsageError, errorMessage, usageError } from '../../shared/errors.ts';
import { normalizeRepoPath } from '../../shared/repository.ts';

export { isObject, type JsonObject } from '../../shared/schema.ts';
export { usageError } from '../../shared/errors.ts';

export type CliResult<Report = unknown> =
  | { report: Report; exitCode?: number }
  | { output: string; exitCode?: number };

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

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

export function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
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

export function blockedReport(protocol: string, error: unknown) {
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
