/** @file Outcome: Workflow CLIs accept only explicit commands and their exact singleton flags. */

import { FlowError } from './errors.ts';

export interface ParsedCommand {
  command: string;
  flags: Record<string, string>;
}

export interface ParsedRepeatableCommand {
  command: string;
  flags: Record<string, string | string[]>;
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

/** Parses a command allowing only the named flags to occur more than once. */
export function parseCommandWithRepeatable(
  argv: readonly string[],
  repeatable: readonly string[],
): ParsedRepeatableCommand {
  const [command, ...args] = argv;
  if (!command) throw new FlowError('command is required');
  if (args.length % 2) throw new FlowError(`missing value for ${args.at(-1)}`);
  const flags: Record<string, string | string[]> = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1]!;
    if (!/^--[a-z-]+$/u.test(flag) || !value) throw new FlowError(`invalid argument: ${flag}`);
    if (Object.hasOwn(flags, flag)) {
      if (!repeatable.includes(flag)) throw new FlowError(`${flag} may be provided only once`);
      const prior = flags[flag]!;
      flags[flag] = [...(Array.isArray(prior) ? prior : [prior]), value];
    } else flags[flag] = value;
  }
  return { command, flags };
}

/** Rejects missing and unrecognized flags for one closed CLI command. */
export function requireExactFlags(
  flags: Record<string, string | string[]>,
  expected: readonly string[],
): void {
  const actual = Object.keys(flags);
  const invalid = actual.filter((flag) => !expected.includes(flag));
  const missing = expected.filter((flag) => !flags[flag]);
  if (invalid.length) throw new FlowError(`unsupported flag: ${invalid.join(', ')}`);
  if (missing.length) throw new FlowError(`${missing.join(', ')} is required`);
}
