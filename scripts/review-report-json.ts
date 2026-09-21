// Tokenize JSON without reserializing its values. Tokens retain number spelling,
// duplicate keys, key order and string escapes; only inter-token whitespace changes.
function tokens(raw: string) {
  return raw.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g) ?? [];
}

export function prettyJson(raw: string): string {
  try {
    JSON.parse(raw);
  } catch {
    return raw;
  }
  return prettyValidatedJson(raw);
}

// Accept only JSON validated at the input boundary, including extracted members.
export function prettyValidatedJson(raw: string): string {
  const parts = tokens(raw);
  let depth = 0;
  let output = '';
  const newline = () => '\n' + '  '.repeat(depth);
  for (const [index, token] of parts.entries()) {
    switch (token) {
      case '{':
      case '[':
        depth++;
        output += token + (['}', ']'].includes(parts[index + 1] ?? '') ? '' : newline());
        break;
      case '}':
      case ']':
        depth--;
        output += (['{', '['].includes(parts[index - 1] ?? '') ? '' : newline()) + token;
        break;
      case ',':
        output += token + newline();
        break;
      case ':':
        output += ': ';
        break;
      default:
        output += token;
    }
  }
  return output;
}

// Accept only JSON validated at the input boundary (or an absent member).
// Extract immediate members once, retaining lexical values. Duplicate keys stay
// present with undefined values so callers can distinguish them from absence.
export function validatedJsonMembers(raw: string | undefined): Map<string, string | undefined> {
  const parts = tokens(raw ?? '');
  const members = new Map<string, string | undefined>();
  if (parts[0] !== '{') {
    return members;
  }
  for (let index = 1; index < parts.length - 1; index++) {
    const token = parts[index];
    if (!token || parts[index + 1] !== ':') {
      continue;
    }
    const name: unknown = JSON.parse(token);
    const start = index + 2;
    index = valueEnd(parts, start);
    if (typeof name === 'string') {
      members.set(name, members.has(name) ? undefined : parts.slice(start, index).join(''));
    }
  }
  return members;
}

function valueEnd(parts: string[], start: number) {
  let depth = 0;
  let index = start;
  do {
    const part = parts[index++];
    if (part === '{' || part === '[') {
      depth++;
    } else if (part === '}' || part === ']') {
      depth--;
    }
  } while (depth > 0);
  return index;
}
