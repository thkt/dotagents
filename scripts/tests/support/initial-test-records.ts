import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 固定baselineのcodex-actor.tsが保存する形式。旧schemaには対象IDの生成制約がない。
const text = { type: 'string', minLength: 1, pattern: '\\S' };
const legacySchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    targetId: text,
    status: { type: 'string', enum: ['prepared', 'unnecessary', 'needs_human', 'needs_host'] },
    findings: text,
    files: { type: 'array', items: text },
  },
  required: ['targetId', 'status', 'findings', 'files'],
  additionalProperties: false,
};

export async function oldTestActor(run: string, response: string) {
  const dir = join(run, 'test-codex-fixture');
  await mkdir(dir);
  const unknown = { value: null, reason: '模擬旧実行では観測しない' };
  const actor = {
    recordFormat: 2,
    invocationId: randomUUID(),
    role: 'test',
    hostPrefix: 'test-1',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'medium',
    sandbox: 'workspace-write',
    ignoreUserConfig: true,
    runtime: {
      cli: {
        entry: { value: '/fixture/codex', reason: null },
        realpath: { value: '/fixture/codex', reason: null },
        version: { value: 'codex-cli fixture', reason: null },
      },
      harness: {
        commit: unknown,
        trackedDirty: unknown,
        codeHash: unknown,
        scope:
          'implement/shared direct *.ts + package.json + bun.lock; sorted path/mode/content SHA-256; regular files only',
      },
    },
  };
  const events = [
    { type: 'thread.started', thread_id: randomUUID() },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: response } },
    {
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
    },
  ];
  await writeFile(join(dir, 'actor.json'), JSON.stringify(actor));
  await writeFile(join(dir, 'schema.json'), JSON.stringify(legacySchema));
  await writeFile(join(dir, 'final.json'), response);
  await writeFile(
    join(dir, 'events.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  await writeFile(join(dir, 'stderr.log'), '');
  // 付属actorはfinalをconsole.logするため、ホスト原応答には末尾改行が付く。
  return { dir, stdout: (await readFile(join(dir, 'final.json'), 'utf8')) + '\n' };
}
