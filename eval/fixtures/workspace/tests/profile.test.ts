import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { loadProfile } from '../src/load-profile.js';
test('保存済みの旧形式を読み込む', async () => {
  expect(loadProfile(await readFile(new URL('../data/profile.json', import.meta.url), 'utf8'))).toEqual({ directory: '/documents/archive' });
  expect(loadProfile('{}')).toEqual({ directory: '/documents' });
});
