import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import { fixture, entry, baseEnv, recordFile, header } from '../../support/runner-affected.ts';

const qualityA = 'scripts/tests/quality/a.test.ts';
const qualityB = 'scripts/tests/quality/b.test.ts';
const assurance = 'scripts/tests/assurance/recovery.test.ts';
const target = 'scripts/lib/value.ts';

// 期待する候補範囲はIssueの契約から決め、実際のpackage scriptを小さなrepoへ接続する。
for (const scenario of [
  'related',
  'missing',
  'unreadable',
  'invalid-json',
  'invalid-shape',
  'fixed-input',
  'unknown-document',
  'assurance-change',
  'direct-assurance',
  'all-control',
] as const) {
  test(`品質の関連実行と安心の直接実行をpackage入口で区別する: ${scenario}`, async () => {
    const manifest: unknown = JSON.parse(
      await readFile(new URL('../../../../package.json', import.meta.url), 'utf8'),
    );
    assert(isRecord(manifest) && isRecord(manifest.scripts));
    const scripts: Record<string, string> = {};
    for (const name of ['test:affected', 'test:control']) {
      const script: unknown = manifest.scripts[name];
      assert(typeof script === 'string');
      scripts[name] = script.replace('scripts/test-runtime/runner.ts', entry);
    }
    const control = scenario === 'direct-assurance' || scenario === 'all-control';
    const single = ['related', 'direct-assurance'].includes(scenario);
    const count = scenario === 'all-control' ? 3 : single ? 1 : 2;
    const args = [
      'run',
      control ? 'test:control' : 'test:affected',
      ...(scenario === 'direct-assurance' ? [assurance] : []),
    ];
    const changes: Record<string, [string, string]> = {
      'fixed-input': ['package.json', JSON.stringify({ scripts }, null, 2)],
      'unknown-document': ['README.md', '# changed\n'],
      'assurance-change': [
        assurance,
        header + "test('changed', () => console.log('ASSURANCE_RAN'));\n",
      ],
    };
    const [changed, changedBody] = changes[scenario] ?? [target, 'export const value = 2;\n'];
    const invalidRecords: Record<string, string> = {
      'invalid-json': '{broken',
      'invalid-shape': JSON.stringify({ invalid: 1 }),
    };
    await fixture(
      {
        'package.json': JSON.stringify({ scripts }),
        [target]: 'export const value = 1;\n',
        [qualityA]:
          header +
          "test('quality a', async () => { expect((await import('../../lib/value.ts')).value).toBeGreaterThan(0); console.log('QUALITY_A_RAN'); });\n",
        [qualityB]: header + "test('quality b', () => console.log('QUALITY_B_RAN'));\n",
        [assurance]: header + "test('assurance', () => console.log('ASSURANCE_RAN'));\n",
      },
      async (f) => {
        const path = recordFile(f.repo);
        await mkdir(dirname(path), { recursive: true });
        const records = {
          [join(f.repo, qualityA)]: [join(f.repo, qualityA), join(f.repo, target)],
          [join(f.repo, qualityB)]: [join(f.repo, qualityB)],
          [join(f.repo, assurance)]: [join(f.repo, assurance), join(f.repo, target)],
        };
        if (scenario === 'unreadable') {
          await mkdir(path);
        } else if (scenario !== 'missing') {
          await writeFile(path, invalidRecords[scenario] ?? JSON.stringify(records));
        }
        await writeFile(join(f.repo, changed), changedBody);
        const result = spawnSync(process.execPath, args, {
          cwd: f.repo,
          encoding: 'utf8',
          timeout: 30000,
          env: baseEnv(f),
        });
        const output = result.stdout + result.stderr;
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        // 読取り不能の対照は保存先もdirectoryなので、後続の保存成功は要求しない。
        if (scenario !== 'unreadable') {
          expect(result.status, output).toBe(0);
        }
        expect(output.includes('QUALITY_A_RAN'), output).toBe(scenario !== 'direct-assurance');
        expect(output.includes('QUALITY_B_RAN'), output).toBe(
          !['related', 'direct-assurance'].includes(scenario),
        );
        expect(output.includes('ASSURANCE_RAN'), output).toBe(control);
        expect(output).toMatch(new RegExp(`Ran ${count} tests? across ${count} files?`));
        if (!control) {
          expect(result.stdout).toMatch(/品質|quality/i);
          expect(result.stdout).toMatch(/(?:候補|candidates?)\D{0,20}2\b/i);
          expect(output).toMatch(/全体\s*check\D{0,10}ではありません/);
          expect(output).not.toContain('All tests executed.');
          if (scenario !== 'related') {
            expect(output).toMatch(/理由|記録.*(?:なし|不正|読め)|初回|未記録/);
          }
        }
      },
    );
  }, 60000);
}
