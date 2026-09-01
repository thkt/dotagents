/** @file Outcome: Controller-supplied shell commands preserve every argument as literal data. */

export const SHELL_CONTROL = /(?:\r|\n|&&|\|\||[;&|`<>]|\$\()/u;

export function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function shellCommand(executable: string, args: string[]): string {
  return [executable, ...args.map(shellArgument)].join(' ');
}

export function shellSafeText(value: string): string {
  return value.replace(new RegExp(SHELL_CONTROL.source, 'gu'), ' ').replace(/\s+/gu, ' ').trim();
}
