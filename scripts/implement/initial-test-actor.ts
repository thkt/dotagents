import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyRuntimeActor } from './runtime-records.ts';
import { testReplySchema } from './test-author.ts';
import { isRecord } from '../shared/values.ts';

async function recordText(path: string) {
  assert((await lstat(path)).isFile(), `原記録が通常ファイルではありません: ${path}`);
  return readFile(path, 'utf8');
}

export async function verifyInitialTestActor(dir: string, stdout: string) {
  const names = await readdir(dir);
  const actors = names.filter((name) => name.startsWith('test-codex-'));
  assert(actors.length === 1, '付属actor原記録を一意に照合できません');
  const name = actors[0];
  assert(name, 'actor原記録がありません');
  const actor = join(dir, name);
  assert(
    (await lstat(actor)).isDirectory() && (await realpath(actor)) === actor,
    'actor原記録の場所を照合できません',
  );
  const path = join(actor, 'actor.json');
  const raw: unknown = JSON.parse(await recordText(path));
  verifyRuntimeActor(raw, 'test', name);
  assert(
    isRecord(raw) && raw.hostPrefix === 'test-1' && raw.ignoreUserConfig === true,
    'actorの呼出し・prefix・runtime対応を照合できません',
  );
  assert(
    JSON.stringify(JSON.parse(await recordText(join(actor, 'schema.json')))) ===
      JSON.stringify(testReplySchema),
    'actor応答schemaが一致しません',
  );
  const final = await recordText(join(actor, 'final.json'));
  const events = (await recordText(join(actor, 'events.jsonl')))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  assert(
    !events.some(
      (event) => isRecord(event) && ['error', 'turn.failed'].includes(String(event.type)),
    ),
    'actor実行失敗の原記録があります',
  );
  const replies = events.filter(
    (event) =>
      isRecord(event) &&
      event.type === 'item.completed' &&
      isRecord(event.item) &&
      event.item.type === 'agent_message',
  );
  const last = replies.at(-1);
  assert(
    isRecord(last) && isRecord(last.item) && last.item.text === final,
    'actor原応答とeventsの応答が不一致です',
  );
  assert(
    events.some((event) => isRecord(event) && event.type === 'turn.completed'),
    'actor応答の終了を照合できません',
  );
  await recordText(join(actor, 'stderr.log'));
  assert(stdout === final || stdout === `${final}\n`, 'ホスト応答とactor原応答が不一致です');
}
