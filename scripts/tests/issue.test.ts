import { test, expect } from 'bun:test';
import { assertNoLegacyKnowledge } from '../issue.ts';

test('legacy selection stops for Markdown fences and JSON Issue bodies, including malformed selections', () => {
  const body = '[{"path":"model.json","blob":"' + 'a'.repeat(40) + '","ids":["rule"]}]';
  for (const block of [
    '```dotagents-knowledge\n' + body + '\n```',
    ' ~~~dotagents-knowledge\n[]\n ~~~',
    '````dotagents-knowledge\ninvalid',
    '```dotagents-knowledge\n```',
  ]) {
    for (const issue of [block, JSON.stringify({ title: 'Issue', body: block })]) {
      expect(() => assertNoLegacyKnowledge(issue)).toThrow('Legacy dotagents-knowledge');
    }
  }
});

test('ordinary Issues and quoted legacy examples are not active selections', () => {
  const block = '```dotagents-knowledge\n[]\n```';
  for (const body of [
    'Remove the `dotagents-knowledge` mechanism.\n\n| Rule | Scope |\n| --- | --- |\n| preserve | work |',
    '````markdown\n' + block + '\n````',
    '<!--\n' + block + '\n-->',
    block
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n'),
    block
      .split('\n')
      .map((line) => '    ' + line)
      .join('\n'),
    block
      .split('\n')
      .map((line, index) => (index === 0 ? '- ' : '  ') + line)
      .join('\n'),
  ]) {
    expect(() => assertNoLegacyKnowledge(body)).not.toThrow();
    expect(() => assertNoLegacyKnowledge(body + '\n\n' + block)).toThrow(
      'Legacy dotagents-knowledge',
    );
  }
});
