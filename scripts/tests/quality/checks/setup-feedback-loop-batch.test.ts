import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  baseEnv,
  config,
  files,
  fixture,
  header,
  installed,
  run,
  setup,
  type Fixture,
} from '../../support/feedback-loop-batch.ts';

const names = ['a', 'b', 'c', 'd', 'e'];
const tests = Object.fromEntries(
  names.map((name, index) => [
    `test/${name}.test.ts`,
    `${header}import { state } from './state.ts';
${index < 2 ? "import { value } from '../src/input.ts';" : ''}
test('${name}', async () => {
  expect(state.used).toBe(false);
  state.used = true;
  expect(Reflect.has(globalThis, 'feedbackBatchOwner')).toBe(false);
  Reflect.set(globalThis, 'feedbackBatchOwner', '${name}');
  ${index < 2 ? 'expect(value).toBeGreaterThan(0);' : ''}
  if (process.env.BATCH_SERVER) {
    await fetch(process.env.BATCH_SERVER + '/start/${name}');
    await fetch(process.env.BATCH_SERVER + '/end/${name}');
  }
});\n`,
  ]),
);

async function affected(f: Fixture, url: string) {
  const child = Bun.spawn([process.execPath, 'run', 'test:affected'], {
    cwd: f.repo,
    env: { ...baseEnv(f), BATCH_SERVER: url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

for (const workers of [undefined, 1, 2]) {
  test(`Bun一括実行はworkers=${String(workers)}で分離・上限・標準と補完の和集合を保つ`, async () => {
    await fixture(
      {
        ...files,
        ...tests,
        'test/state.ts': 'export const state = { used: false };\n',
        'data/input.json': '{"value":1}\n',
        '.feedback-loop.json': JSON.stringify({
          ...config,
          bunWorkers: workers,
          dependencies: [
            { inputs: ['data/input.json'], tests: ['test/c.test.ts', 'test/d.test.ts'] },
          ],
        }),
      },
      async (f) => {
        installed(f);
        const expectedWorkers = workers ?? 4;
        const active = new Set<string>();
        const started: string[] = [];
        const pending: (() => void)[] = [];
        let peak = 0;
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(request) {
            const [, operation, name = ''] = new URL(request.url).pathname.split('/');
            if (operation === 'start') {
              active.add(name);
              started.push(name);
              peak = Math.max(peak, active.size);
              await new Promise<void>((done) => {
                const timeout = setTimeout(done, 300);
                pending.push(() => {
                  clearTimeout(timeout);
                  done();
                });
                if (active.size >= expectedWorkers) {
                  for (const release of pending.splice(0)) {
                    release();
                  }
                }
              });
            } else if (operation === 'end') {
              active.delete(name);
            }
            return new Response('ok');
          },
        });
        try {
          await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
          const initial = await affected(f, server.url.href);
          expect(initial.code, initial.output).toBe(0);
          expect(started.toSorted()).toEqual(names);
          expect(peak, initial.output).toBe(expectedWorkers);
          expect(active.size).toBe(0);
          const fallback = initial.output.split('\n').filter((line) => line.startsWith('実行: '));
          expect(fallback, initial.output).toHaveLength(1);
          expect(fallback[0]).toContain('--isolate');
          for (const name of names) {
            expect(fallback[0]).toContain(`./test/${name}.test.ts`);
          }

          started.length = 0;
          peak = 0;
          await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
          await writeFile(join(f.repo, 'data/input.json'), '{"value":2}\n');
          const selected = await affected(f, server.url.href);
          expect(selected.code, selected.output).toBe(0);
          expect(started.toSorted(), selected.output).toEqual(['a', 'b', 'c', 'd']);
          expect(peak, selected.output).toBe(Math.min(expectedWorkers, 2));
          expect(active.size).toBe(0);
          const commands = selected.output.split('\n').filter((line) => line.startsWith('実行: '));
          const native = commands.filter((line) => line.includes('--changed='));
          expect(native, selected.output).toHaveLength(1);
          expect(commands, selected.output).toHaveLength(2);
          for (const command of commands) {
            expect(command).toContain('--isolate');
          }
          for (const name of names) {
            expect(native[0]).toContain(`./test/${name}.test.ts`);
          }
          expect(selected.output).toContain('quality候補: 5');
          expect(selected.output).toContain('quality選択: 4');
          expect(selected.output).not.toContain('quality全件の理由:');
        } finally {
          for (const release of pending.splice(0)) {
            release();
          }
          await server.stop(true);
        }
      },
    );
  }, 30000);
}

test('bunWorkersと競合するCLI引数は配置前に拒否する', async () => {
  await fixture(files, async (f) => {
    const originalPackage = await readFile(join(f.repo, 'package.json'), 'utf8');
    const originalDotagents = await readFile(join(f.repo, '.dotagents.json'), 'utf8');
    const invalid = [
      ...[0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1].map((bunWorkers) => ({
        ...config,
        bunWorkers,
      })),
      { ...config, runner: 'vitest', bunArgs: [], bunWorkers: 2 },
      ...['bunArgs', 'testArgs'].flatMap((key) =>
        ['--isolate', '--no-isolate', '--parallel', '--parallel=2', '--no-parallel'].map(
          (flag) => ({
            ...config,
            [key]: [flag],
          }),
        ),
      ),
    ];
    for (const value of invalid) {
      await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(value));
      const rejected = run(f, [
        setup,
        'apply',
        '--repo',
        f.repo,
        '--feedback-command',
        'bun run test:affected',
      ]);
      expect(rejected.code, JSON.stringify(value) + '\n' + rejected.output).not.toBe(0);
      expect(rejected.output).toMatch(/bunWorkers|parallel|isolate|worker|並列|分離/i);
      expect(existsSync(join(f.repo, 'scripts/feedback-loop'))).toBe(false);
      expect(await readFile(join(f.repo, 'package.json'), 'utf8')).toBe(originalPackage);
      expect(await readFile(join(f.repo, '.dotagents.json'), 'utf8')).toBe(originalDotagents);
    }
  });
});
