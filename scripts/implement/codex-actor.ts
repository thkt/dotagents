import { reviewSchema, reviewModel } from './review.ts';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

// Logs stay outside the actor's worktree. The parent owns limits and process termination.
const [role, evidenceDir] = process.argv.slice(2);
if ((role !== 'repair' && role !== 'review') || !evidenceDir) {
  throw Error('Usage: bun scripts/implement/codex-actor.ts repair|review EVIDENCE_DIR');
}
const dir = await mkdtemp(join(evidenceDir, `${role}-codex-`));
const hostPrefix = process.env.DOTAGENTS_ACTOR_PREFIX;
// Consume host context; tools or nested actors must not inherit this association.
delete process.env.DOTAGENTS_ACTOR_PREFIX;
await writeFile(
  join(dir, 'actor.json'),
  JSON.stringify({
    recordFormat: 1,
    invocationId: randomUUID(),
    role,
    hostPrefix: hostPrefix ? relative(evidenceDir, hostPrefix) : null,
    model: reviewModel.model,
    reasoningEffort: reviewModel.reasoningEffort,
    sandbox: role === 'repair' ? 'workspace-write' : 'read-only',
    ignoreUserConfig: true,
  }),
  { flag: 'wx' },
);
const final = join(dir, 'final.json');
const schema = join(dir, 'schema.json');
await writeFile(
  schema,
  JSON.stringify(
    role === 'review'
      ? reviewSchema
      : {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'findings'],
          properties: {
            status: {
              type: 'string',
              enum: ['repaired', 'needs_human'],
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
  reviewModel.model,
  '-c',
  `model_reasoning_effort="${reviewModel.reasoningEffort}"`,
  '--sandbox',
  role !== 'repair' ? 'read-only' : 'workspace-write',
  '--json',
  '--output-schema',
  schema,
  '-o',
  final,
  '-',
];
const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
process.stdin.pipe(child.stdin);
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
