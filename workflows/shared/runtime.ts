/** @file Outcome: Workflow runners share strict input loading and stable CLI JSON reporting. */

import * as fs from 'node:fs';
import path from 'node:path';
import { errorCode, errorMessage, FlowError } from './errors.ts';

export function readAbsoluteJson(file: string, label: string): unknown {
  if (!path.isAbsolute(file)) throw new FlowError('--input must be absolute');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new FlowError(`${label} input is unreadable: ${errorMessage(error)}`);
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
