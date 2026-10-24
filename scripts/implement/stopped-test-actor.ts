import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { codeHash, runtimeShape } from './actor-runtime.ts';
import { testPrompt, testReplySchema } from './test-author.ts';
import type { Config } from './input.ts';
import { isRecord } from '../shared/values.ts';
import { reviewModel } from './review.ts';

async function text(path: string) {
  assert((await lstat(path)).isFile(), `担当の原記録は通常ファイルに限ります: ${path}`);
  return readFile(path, 'utf8');
}

const actorShape = z.object({
  recordFormat: z.literal(2),
  invocationId: z.string().min(1),
  role: z.literal('test'),
  hostPrefix: z.string(),
  sandbox: z.literal('workspace-write'),
  ignoreUserConfig: z.literal(true),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  runtime: runtimeShape,
});

async function nativeActor(dir: string, targetId: string) {
  const matches = [];
  for (const name of await readdir(dir)) {
    if (!name.startsWith('test-codex-')) {
      continue;
    }
    const path = join(dir, name);
    assert((await lstat(path)).isDirectory(), '付属テスト担当の保存先が不正です');
    const contents: unknown = JSON.parse(await text(join(path, 'actor.json')));
    const raw = z.object({ hostPrefix: z.string().nullable() }).parse(contents);
    if (raw.hostPrefix !== null && resolve(dir, raw.hostPrefix) === join(dir, 'test-1')) {
      matches.push({
        path,
        actor: actorShape.parse(contents),
      });
    }
  }
  assert(matches.length === 1, '判断待ちに対応する付属テスト担当を一意に照合できません');
  const matched = matches[0];
  assert(matched);
  const schema: unknown = JSON.parse(await text(join(matched.path, 'schema.json')));
  const fixedSchema = {
    ...testReplySchema,
    properties: {
      ...testReplySchema.properties,
      targetId: { type: 'string', enum: [targetId] },
    },
  };
  // 旧生成器の汎用schemaと、#425で対象IDを固定したschemaを区別して照合する。
  if (JSON.stringify(schema) !== JSON.stringify(testReplySchema)) {
    assert.deepStrictEqual(schema, fixedSchema, '付属テスト担当の応答schemaが一致しません');
  }
  assert(
    `${await text(join(matched.path, 'final.json'))}\n` ===
      (await text(join(dir, 'test-1.stdout'))),
    '付属担当の原finalとstdoutが一致しません',
  );
  await text(join(matched.path, 'events.jsonl'));
  await text(join(matched.path, 'stderr.log'));
  return matched.actor;
}

export async function verifyStoppedTestActor(
  dir: string,
  config: Config,
  input: Parameters<typeof testPrompt>[0],
  targetId: string,
  prompt: string,
) {
  const script = config.test?.[1];
  if (!script || basename(script) !== 'codex-actor.ts') {
    assert(prompt === testPrompt(input, targetId), '保存テスト指示と入力全体が一致しません');
    return;
  }
  assert(config.test?.length === 4, '付属テスト担当の起動契約を照合できません');
  const actor = await nativeActor(dir, targetId);
  const root = resolve(dirname(script), '../..');
  assert(
    actor.model === reviewModel.model && actor.reasoningEffort === 'medium',
    '付属テスト担当のモデル・推論設定が生成契約と一致しません',
  );
  const sealed = await lstat(join(dir, 'human-decision-stop.json')).catch((error: unknown) => {
    assert(isRecord(error) && error.code === 'ENOENT', '停止時の保全記録を照合できません');
    return undefined;
  });
  if (sealed) {
    assert(sealed.isFile(), '停止時の保全記録は通常ファイルに限ります');
    // 呼出元が保存時の全記録へ照合する。新しいsourceのhashで旧担当を置き換えない。
    assert(prompt === testPrompt(input, targetId, root), '保存指示と入力全体が一致しません');
    return;
  }
  const observed = await codeHash(root);
  assert(
    observed.value !== null && observed.value === actor.runtime.harness.codeHash.value,
    '付属担当の生成版を現在のsourceへ照合できません。過去の版を推測しません',
  );
  // 受理済み#430の保存契約。過去に無いprompt hashやcwd観測値は補作しない。
  const legacy =
    observed.value === 'ad74122959a9d199a51f34c1b2040c22cf63396aea7ae0a7cb2113c29b2b632a';
  const current = await codeHash(resolve(import.meta.dir, '../..'));
  assert(legacy || observed.value === current.value, '付属担当の生成契約が未対応です');
  assert(prompt === testPrompt(input, targetId, root, legacy), '原指示と生成契約が一致しません');
}
