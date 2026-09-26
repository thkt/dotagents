type Token = { word: string } | { operator: string };

// This is a literal-operand recognizer, not a shell interpreter. Reject expansions
// before splitting commands so text inside unsupported syntax cannot become a read.
function literalWord(raw: string): string | undefined {
  let word = '';
  let quote = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i] ?? '';
    if (char === quote) {
      quote = '';
      continue;
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      word += escapedCharacter(raw[++i] ?? '', quote);
      continue;
    }
    if (dynamicCharacter(char, quote, word)) {
      return undefined;
    }
    word += char;
  }
  return word;
}

function escapedCharacter(next: string, quote: string) {
  return quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
}

function dynamicCharacter(char: string, quote: string, prefix: string) {
  if (quote === "'") {
    return false;
  }
  // zsh expands an unquoted leading '=' even after empty quotes. The saved
  // command may omit its shell, so reject it without resolving the executable.
  return /[$`]/.test(char) || (!quote && (/[()*?[\]{}~!]/.test(char) || (char === '=' && !prefix)));
}

function nextQuote(char: string, quote: string) {
  if (char === quote) {
    return '';
  }
  return !quote && (char === "'" || char === '"') ? char : quote;
}

// Remove continuations before deciding word/operator boundaries. Single quotes
// and comments keep their literal backslashes; escaped quotes do not change state.
function joinContinuations(command: string) {
  let result = '';
  let quote = '';
  let boundary = true;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? '';
    if (boundary && char === '#') {
      const comment = command.slice(i).match(/^[^\n]*/)?.[0] ?? '';
      result += comment;
      i += comment.length - 1;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      const next = command[++i] ?? '';
      if (next !== '\n') {
        result += char + next;
        boundary = false;
      }
      continue;
    }
    result += char;
    quote = nextQuote(char, quote);
    boundary = !quote && /[ \t\n;&|<>]/.test(char);
  }
  return result;
}

function tokenize(command: string): Token[] | undefined {
  if (command.includes('\r')) {
    return undefined;
  }
  const joined = joinContinuations(command);
  const pattern =
    /[ \t]+|\n|#[^\n]*|&&|\|\||[;|]|\d*(?:>>?\|?|<)|(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]|[^\s'"\\;&|<>])+/gy;
  const tokens: Token[] = [];
  let end = 0;
  for (const match of joined.matchAll(pattern)) {
    end = match.index + match[0].length;
    const raw = match[0];
    if (/^[ \t#]/.test(raw)) {
      continue;
    }
    if (/^(?:\n|&&|\|\||[;|]|\d*(?:>>?\|?|<))$/.test(raw)) {
      tokens.push({ operator: raw });
    } else {
      const word = literalWord(raw);
      if (word === undefined) {
        return undefined;
      }
      tokens.push({ word });
    }
  }
  return end === joined.length ? tokens : undefined;
}

function commandWords(tokens: Token[]): string[] | undefined {
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token && 'word' in token) {
      words.push(token.word);
    } else {
      // Redirect destinations are never operands. Here-docs and descriptor
      // duplication do not match this form and invalidate the command.
      const target = tokens[++i];
      if (!target || !('word' in target)) {
        return undefined;
      }
    }
  }
  return words;
}

function operands(args: string[], option: (arg: string, next: string) => number | undefined) {
  const paths: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      const consumed = option(arg, args[i + 1] ?? '');
      if (consumed === undefined) {
        return undefined;
      }
      i += consumed;
      continue;
    }
    if (arg && arg !== '-') {
      paths.push(arg);
    }
  }
  return paths;
}

function readOperands(words: string[]): string[] | undefined {
  const [name, ...args] = words;
  const executable = name?.replace(/^\/(?:usr\/)?bin\//, '');
  if (executable === 'cat') {
    return operands(args, (arg) => (/^-[AbeEnstTuv]+$/.test(arg) ? 0 : undefined));
  }
  if (executable === 'head' || executable === 'tail') {
    return operands(args, (arg, next) => {
      if (/^-[nc]$/.test(arg)) {
        return /^[+-]?\d+[bcwkMG]?$/.test(next) ? 1 : undefined;
      }
      return /^-(?:[qv]+|\d+|[nc][+-]?\d+[bcwkMG]?)$/.test(arg) ? 0 : undefined;
    });
  }
  if (executable === 'sed' && args[0] === '-n') {
    const scriptIndex = args[1] === '-e' ? 2 : 1;
    if (!/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[scriptIndex] ?? '')) {
      return undefined;
    }
    return operands(args.slice(scriptIndex + 1), () => undefined);
  }
  return undefined;
}

function commands(tokens: Token[]) {
  const groups: Token[][] = [[]];
  for (const token of tokens) {
    if ('operator' in token && /^(?:\n|;|&&|\|\||\|)$/.test(token.operator)) {
      groups.push([]);
    } else {
      groups.at(-1)?.push(token);
    }
  }
  return groups.filter((group) => group.length).map(commandWords);
}

function readCommand(words: string[], depth: number) {
  const [name, flag, script] = words;
  const shell = /^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh)$/.test(name ?? '');
  if (shell && /^-(?:l?c|cl)$/.test(flag ?? '') && words.length === 3) {
    return commandInputs(script ?? '', depth + 1);
  }
  const paths = readOperands(words);
  return { paths: paths ?? [], partial: !paths?.length };
}

export function commandInputs(command: string, depth = 0): { paths: string[]; partial: boolean } {
  const unknown = { paths: [], partial: true };
  const tokens = tokenize(command);
  if (
    !tokens ||
    depth > 2 ||
    tokens.some((token, index) => {
      const next = tokens[index + 1];
      return 'operator' in token && token.operator.endsWith('<') && next && 'operator' in next;
    })
  ) {
    return unknown;
  }
  const groups = commands(tokens);
  if (
    groups.some(
      (words) =>
        words &&
        /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select)$/.test(
          words[0] ?? '',
        ),
    )
  ) {
    return unknown;
  }
  const paths = new Set<string>();
  let partial = false;
  for (const words of groups) {
    if (!words) {
      partial = true;
      continue;
    }
    const result = readCommand(words, depth);
    partial ||= result.partial;
    for (const path of result.paths) {
      paths.add(path);
    }
  }
  return { paths: [...paths], partial };
}
