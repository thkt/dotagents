import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const mode of ['normal', 'nonzero', 'missing', 'write_error'] as const) {
  test(`Codex actor logs: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'actor-stream-'));
    try {
      const bytes = mode === 'nonzero' ? 64 : 2 * 1024 * 1024;
      if (mode !== 'missing') {
        await writeFile(
          join(root, 'codex'),
          `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({status:'accepted', findings:''}));
process.stdout.write('x'.repeat(${bytes}) + 'stdout-end');
process.stderr.write('y'.repeat(${bytes}) + 'stderr-end');
process.exitCode = ${mode === 'nonzero' ? 7 : 0};
`,
          { mode: 0o755 },
        );
      }
      // Limit only the child process; ignore SIGXFSZ so writes report EFBIG.
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          mode === 'write_error' ? 'ulimit -f 1; trap "" XFSZ; exec "$@"' : 'exec "$@"',
          'actor-test',
          process.execPath,
          resolve('scripts/codex-actor.ts'),
          'review',
          root,
        ],
        {
          env: { ...process.env, PATH: root },
          input: 'Review fixture',
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(mode === 'normal' ? 0 : 1);
      if (mode === 'normal') {
        expect(JSON.parse(result.stdout)).toEqual({ status: 'accepted', findings: '' });
      } else {
        expect(result.stdout).toBe('');
      }
      const entries = await readdir(root);
      const dir = entries.find((entry) => entry.startsWith('review-codex-'));
      expect(dir).toBeDefined();
      if (dir && (mode === 'normal' || mode === 'nonzero')) {
        expect(await readFile(join(root, dir, 'events.jsonl'), 'utf8')).toBe(
          'x'.repeat(bytes) + 'stdout-end',
        );
        expect(await readFile(join(root, dir, 'stderr.log'), 'utf8')).toBe(
          'y'.repeat(bytes) + 'stderr-end',
        );
      }
      if (dir && mode === 'write_error') {
        expect(result.stderr).toContain('EFBIG');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
