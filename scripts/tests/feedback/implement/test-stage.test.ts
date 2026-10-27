import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorTests,
  prepareTestBaseline,
  verifyTestArtifacts,
} from '../../../implement/test-author.ts';
import { command } from '../../../shared/process.ts';
import { gitOutput, ok } from '../../support/development.ts';
import { object } from '../../support/correction.ts';
import { expectTestStage } from '../../support/test-stage.ts';

const stages = ['initial', 'revision', 'correction', 'host_return'] as const;

test('段階だけが異なる入力を識別し、空診断でも初回限定条件と保存入力の改変拒否を保つ', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'test-stage-')));
  try {
    const cwd = join(root, 'checkout');
    await mkdir(cwd);
    await gitOutput(cwd, 'init', '-q');
    await writeFile(join(cwd, 'result.test.js'), '// 要求に基づく準備済み対照\nprocess.exit(1);\n');
    const baseline = join(root, 'baseline');
    await prepareTestBaseline(cwd, baseline);
    const original = await readFile(join(cwd, 'result.test.js'), 'utf8');
    const identities: string[] = [];
    const observed: { prefix: string; prompt: string; stage: string; source: string }[] = [];
    for (const stage of stages) {
      const prefix = join(root, stage);
      const input = {
        cwd,
        baseline,
        prefix,
        issue: '通常初回だけ弱い対照を適用し、修正・復帰では準備済みの要求対照を維持する。',
        baseCommit: '固定baseline',
        check: ['bun', 'test'],
        actor: ['模擬テスト担当'],
        previous: [],
        diagnostics: [],
        stage,
      };
      const prepared = await authorTests(input, async (argv, work, prompt, timeout, output) => {
        if (argv[0] !== '模擬テスト担当') {
          return command(argv, work, prompt, timeout, output);
        }
        assert(output);
        const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
        // 初回限定指示の模擬。段階不明の旧入力も初回と推定しない。
        const weak = input.stage === 'initial';
        if (weak) {
          await writeFile(join(work, 'result.test.js'), 'process.exit(0);\n');
        }
        const reply = ok(
          JSON.stringify({
            targetId: input.targetId,
            status: weak ? 'prepared' : 'unnecessary',
            findings: '初回限定の対照条件を段階で選び、その他は準備済み資産を保持する模擬担当。',
            files: weak ? ['result.test.js'] : [],
          }),
        );
        await writeFile(`${output}.stdout`, reply.stdout);
        return reply;
      });
      assert(prepared.record);
      identities.push(prepared.record.targetId);
      const prompt = await readFile(`${prefix}.prompt`, 'utf8');
      observed.push({
        prefix,
        prompt,
        stage,
        source: await readFile(join(cwd, 'result.test.js'), 'utf8'),
      });
      const target = object(JSON.parse(await readFile(`${prefix}.target.json`, 'utf8')));
      expect(target.diagnostics ?? []).toEqual([]);
      await verifyTestArtifacts(cwd, [prepared.record]);
      const saved = await readFile(`${prefix}.target.json`, 'utf8');
      await writeFile(
        `${prefix}.target.json`,
        JSON.stringify({ ...target, stage: '改変した段階' }),
      );
      await assert.rejects(verifyTestArtifacts(cwd, [prepared.record]), /保存テスト入力が変更/);
      await writeFile(`${prefix}.target.json`, saved);
      // 次の入力は段階以外を同じにする。前回テスト件数から段階を推測させない。
      await writeFile(join(cwd, 'result.test.js'), original);
    }
    expect(new Set(identities).size).toBe(stages.length);
    for (const observation of observed) {
      await expectTestStage(observation.prompt, observation.prefix, observation.stage);
      expect(observation.source).toBe(
        observation.stage === 'initial' ? 'process.exit(0);\n' : original,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
