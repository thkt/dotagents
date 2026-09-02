/** @file Outcome: Controller-supplied shell commands preserve every argument as literal data. */

export const SHELL_CONTROL = /(?:\r|\n|&&|\|\||[;&|`<>]|\$\()/u;

export function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function shellCommand(executable: string, args: string[]): string {
  return [executable, ...args.map(shellArgument)].join(' ');
}

/** Tokenizes the literal command forms accepted by workflow hooks and Plan validation. */
export function shellWords(command: string): string[] {
  return [...command.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/gu)].map((match) => {
    const token = match[0];
    if (token.startsWith('"')) {
      try {
        return JSON.parse(token) as string;
      } catch {
        return token;
      }
    }
    return token.startsWith("'") ? token.slice(1, -1) : token;
  });
}

export function shellSafeText(value: string): string {
  return value.replace(new RegExp(SHELL_CONTROL.source, 'gu'), ' ').replace(/\s+/gu, ' ').trim();
}
