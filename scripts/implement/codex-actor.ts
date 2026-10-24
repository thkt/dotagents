import { testReplySchema } from './test-author.ts';
import { observeRuntime } from './actor-runtime.ts';
import { reviewSchema, reviewModel } from './review.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

// Logs stay outside the actor's worktree. The parent owns limits and process termination.
const [role, evidenceDir] = process.argv.slice(2);
if ((role !== 'repair' && role !== 'review' && role !== 'test') || !evidenceDir) {
  throw Error('Usage: bun scripts/implement/codex-actor.ts repair|review|test EVIDENCE_DIR');
}
const model = role !== 'review' ? { ...reviewModel, reasoningEffort: 'medium' } : reviewModel;
const dir = await mkdtemp(join(evidenceDir, `${role}-codex-`));
const hostPrefix = process.env.DOTAGENTS_ACTOR_PREFIX;
// Consume host context; tools or nested actors must not inherit this association.
delete process.env.DOTAGENTS_ACTOR_PREFIX;
const cwd = process.cwd();
const env = { ...process.env };
const runtime = await observeRuntime(cwd, env);
await writeFile(
  join(dir, 'actor.json'),
  JSON.stringify({
    recordFormat: 2,
    runtime,
    invocationId: randomUUID(),
    role,
    hostPrefix: hostPrefix ? relative(evidenceDir, hostPrefix) : null,
    model: model.model,
    reasoningEffort: model.reasoningEffort,
    sandbox: role !== 'review' ? 'workspace-write' : 'read-only',
    ignoreUserConfig: true,
  }),
  { flag: 'wx' },
);
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  assert(typeof chunk === 'string' || chunk instanceof Uint8Array, 'actor入力が不正です');
  chunks.push(Buffer.from(chunk));
}
const prompt = Buffer.concat(chunks).toString('utf8');
let responseSchema = role === 'test' ? testReplySchema : reviewSchema;
if (role === 'test') {
  const line = prompt.split('\n').find((value) => value.startsWith('入力: '));
  assert(line, '独立テストのホスト入力がありません');
  const input: unknown = JSON.parse(line.slice('入力: '.length));
  assert(
    typeof input === 'object' &&
      input !== null &&
      'targetId' in input &&
      typeof input.targetId === 'string' &&
      /^[a-f0-9]{64}$/.test(input.targetId),
    '独立テストの入力IDが不正です',
  );
  responseSchema = {
    ...testReplySchema,
    properties: {
      ...testReplySchema.properties,
      targetId: { type: 'string', enum: [input.targetId] },
    },
  };
}
const final = join(dir, 'final.json');
const schema = join(dir, 'schema.json');
await writeFile(
  schema,
  JSON.stringify(
    role === 'review' || role === 'test'
      ? responseSchema
      : {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'findings'],
          properties: {
            status: {
              type: 'string',
              enum: ['repaired', 'needs_host', 'needs_human'],
            },
            findings: { type: 'string' },
          },
        },
  ),
);
const args = [
  'exec',
  '--ignore-user-config',
  '-m',
  model.model,
  '-c',
  `model_reasoning_effort="${model.reasoningEffort}"`,
  '--sandbox',
  role === 'review' ? 'read-only' : 'workspace-write',
  '--json',
  '--output-schema',
  schema,
  '-o',
  final,
  '-',
];
if (runtime.cli.entry.value === null) {
  throw Error('Codex launch entry unavailable');
}
const child = spawn(runtime.cli.entry.value, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.end(prompt);
child.stdin.on('error', () => {});
const [code] = await Promise.all([
  new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }),
  pipeline(child.stdout, createWriteStream(join(dir, 'events.jsonl'))),
  pipeline(child.stderr, createWriteStream(join(dir, 'stderr.log'))),
]).catch((error: unknown) => {
  child.kill();
  throw error;
});
if (code !== 0) {
  console.error(`Codex failed; evidence: ${dir}`);
  process.exit(1);
}
console.log(await readFile(final, 'utf8'));
