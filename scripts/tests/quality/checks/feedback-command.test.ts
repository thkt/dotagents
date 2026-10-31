import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isRecord } from '../../../shared/values.ts';

const repo = resolve(import.meta.dir, '../../../..');
const manifest: unknown = await Bun.file(join(repo, 'package.json')).json();
assert(isRecord(manifest) && isRecord(manifest.scripts));
const packageScripts = manifest.scripts;

function steps(name: string) {
  const command = packageScripts[name];
  assert(typeof command === 'string', name);
  return command.split(' && ').map((step) => {
    const script = /^bun run (\S+)$/.exec(step)?.[1];
    assert(script, step);
    return script;
  });
}

test('check:feedbackは全体checkの静的検査をすべて含み、テストだけを品質候補の関連実行に替える', async () => {
  const fullSuites = ['test:control', 'test:eval'];
  expect(steps('check:feedback')).toEqual([
    ...steps('check').filter((step) => !fullSuites.includes(step)),
    'test:affected',
  ]);
  const settings: unknown = await Bun.file(join(repo, '.dotagents.json')).json();
  assert(isRecord(settings));
  expect(settings.feedbackCheck).toBe('bun run check:feedback');
});

test('check:feedbackはどの工程の失敗も非0終了と診断で返し、後続の工程を実行しない', async () => {
  const names = steps('check:feedback');
  const cwd = await mkdtemp(join(tmpdir(), 'feedback-command-'));
  try {
    for (const failing of names) {
      const scripts: Record<string, string> = {
        'check:feedback': String(packageScripts['check:feedback']),
      };
      for (const name of names) {
        const code = name === failing ? 1 : 0;
        scripts[name] =
          `${process.execPath} -e 'console.log("RAN:${name}"); process.exit(${code})'`;
      }
      await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts }));
      const result = spawnSync(process.execPath, ['run', 'check:feedback'], {
        cwd,
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(result.error).toBeUndefined();
      const output = result.stdout + result.stderr;
      expect(result.status, output).not.toBe(0);
      const index = names.indexOf(failing);
      for (const name of names.slice(0, index + 1)) {
        expect(output).toContain(`RAN:${name}`);
      }
      for (const name of names.slice(index + 1)) {
        expect(output).not.toContain(`RAN:${name}`);
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
