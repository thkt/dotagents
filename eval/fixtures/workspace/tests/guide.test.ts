import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
test('保存操作は現在の参照先へ案内する', async () => {
  const readme = new URL('../README.md', import.meta.url);
  const text = await readFile(readme, 'utf8');
  const targets = Array.from(text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g), (match) => new URL(match[1]!, readme).href);
  const current = new URL('../docs/current-guide.md', import.meta.url);
  expect(targets).toContain(current.href);
  expect(targets).not.toContain(new URL('../docs/old-guide.md', import.meta.url).href);
  expect(await readFile(current, 'utf8')).toContain('保存');
});
