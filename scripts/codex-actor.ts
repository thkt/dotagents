import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

// Logs stay outside the actor's worktree. The parent owns limits and process termination.
const [role, evidenceDir] = process.argv.slice(2);
if ((role !== 'repair' && role !== 'review' && role !== 'review-text') || !evidenceDir) {
  throw Error('Usage: bun scripts/codex-actor.ts repair|review|review-text EVIDENCE_DIR');
}
const dir = await mkdtemp(join(evidenceDir, `${role}-codex-`));
const final = join(dir, 'final.json');
const schema = join(dir, 'schema.json');
await writeFile(
  schema,
  JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'findings'],
    properties: {
      status: {
        type: 'string',
        enum: role !== 'repair' ? ['accepted', 'needs_changes'] : ['repaired', 'needs_human'],
      },
      findings: { type: 'string' },
    },
  }),
);
const args = [
  'exec',
  '--ignore-user-config',
  '-m',
  'gpt-6-astra',
  '-c',
  'model_reasoning_effort="high"',
  '--sandbox',
  role !== 'repair' ? 'read-only' : 'workspace-write',
  ...(role === 'review-text' ? ['--skip-git-repo-check'] : []),
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
