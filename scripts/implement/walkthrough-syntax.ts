import { extname } from 'node:path';
import hljs from 'highlight.js/lib/common';

const aliases = new Map([
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
]);

export function walkthroughSyntax(lines: readonly string[], path: string, start: number) {
  const extension = extname(path).slice(1).toLowerCase();
  const candidate = aliases.get(extension) ?? extension;
  const language = hljs.getLanguage(candidate) ? candidate : 'plaintext';
  const highlighted = hljs.highlight(lines.join('\n'), { language }).value;
  const spans: string[] = [];
  // 行ごとのカラムに収まるよう、複数行の構文spanを行境界で閉じ直します。
  const balanced = highlighted.replace(/<span\b[^>]*>|<\/span>|\n/g, (token) => {
    if (token === '\n') {
      return `${'</span>'.repeat(spans.length)}\n${spans.join('')}`;
    }
    if (token === '</span>') {
      spans.pop();
    } else {
      spans.push(token);
    }
    return token;
  });
  return balanced
    .split('\n')
    .map(
      (line, offset) =>
        `<span class="walk-code-line"><span class="walk-line-number">${start + offset}: </span><span class="walk-line-text">${line}</span></span>`,
    )
    .join('\n')
    .replace(/\r/g, '&#13;');
}
