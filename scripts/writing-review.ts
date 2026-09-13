import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, lstat, realpath, rename, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { WritingRunner } from './writing.ts';
import { reviewWriting, writingCommand, writingHash, writingHostTimeoutMs } from './writing.ts';
import { isRecord } from './input.ts';
import { command, withInterrupts } from './correction.ts';

async function git(cwd: string, dir: string, args: string[]) {
  return writingCommand(['git', ...args], cwd, '', join(dir, 'git'));
}

async function optionalFile(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
async function cachedReview(
  dir: string,
  key: string,
  facts: string,
  input: { name: string; body: string }[],
) {
  const text = await optionalFile(join(dir, `done-${key}.json`));
  if (text === undefined) {
    return false;
  }
  const record: unknown = JSON.parse(text);
  assert(
    isRecord(record) && typeof record.review === 'string' && /^[0-9a-f]{64}$/.test(record.review),
    'Invalid writing receipt',
  );
  if (record.status === 'skipped') {
    const skipped: unknown = JSON.parse(
      await readFile(join(dir, record.review, 'skipped.json'), 'utf8'),
    );
    assert(
      isRecord(skipped) &&
        skipped.status === 'skipped' &&
        skipped.inputHash === key &&
        typeof skipped.reason === 'string',
      'Invalid writing skip',
    );
    console.error(
      `Gemini確認: 未実施 (${skipped.reason}); 同じ入力のスキップ記録: ${dir}/${record.review}/skipped.json`,
    );
    return true;
  }
  const accepted: unknown = JSON.parse(
    await readFile(join(dir, record.review, 'accepted.json'), 'utf8'),
  );
  const original: unknown = JSON.parse(
    await readFile(join(dir, record.review, 'input.json'), 'utf8'),
  );
  assert(
    isRecord(accepted) &&
      accepted.outputHash === writingHash(JSON.stringify(input)) &&
      isRecord(original) &&
      original.facts === facts,
    'Stale writing receipt',
  );
  return true;
}

export async function reviewDocuments(
  cwd: string,
  facts: string,
  dir: string,
  runner?: WritingRunner,
  currentFacts: () => Promise<string> = async () => facts,
) {
  const active = join(dir, 'active.json');
  assert(
    (await optionalFile(active)) === undefined,
    'Interrupted writing adoption requires reconciliation',
  );
  const paths = new Set(
    (
      (await git(cwd, dir, ['diff', '--name-only', '-z', '--diff-filter=AMRC', 'HEAD'])) +
      (await git(cwd, dir, ['ls-files', '--others', '--exclude-standard', '-z']))
    )
      .split('\0')
      .filter((name) => name.endsWith('.md')),
  );
  const input = [];
  for (const name of paths) {
    const path = resolve(cwd, name);
    assert(
      (await lstat(path)).isFile() && (await realpath(path)) === path,
      `Writing target must be a regular file: ${name}`,
    );
    input.push({ name, body: await readFile(path, 'utf8') });
  }
  if (!input.length) {
    return;
  }
  input.sort((a, b) => a.name.localeCompare(b.name));
  const key = writingHash(JSON.stringify({ facts, documents: input }));
  if (await cachedReview(dir, key, facts, input)) {
    return;
  }
  await writeFile(active, JSON.stringify({ key, phase: 'reviewing' }), { flag: 'wx' });
  const result = await reviewWriting(input, facts, join(dir, key), runner);
  assert((await currentFacts()) === facts, 'Writing facts changed during review');
  for (const doc of input) {
    const path = resolve(cwd, doc.name);
    assert(
      (await lstat(path)).isFile() && (await realpath(path)) === path,
      'Writing target type changed',
    );
    assert(
      (await readFile(resolve(cwd, doc.name), 'utf8')) === doc.body,
      'Writing target changed during review',
    );
  }
  if ((await optionalFile(join(dir, key, 'skipped.json'))) !== undefined) {
    await writeFile(
      join(dir, `done-${key}.json`),
      JSON.stringify({ review: key, status: 'skipped' }),
    );
    await rm(active);
    return;
  }
  await writeFile(active, JSON.stringify({ key, phase: 'adopting' }));
  for (const doc of result) {
    const path = resolve(cwd, doc.name);
    const temporary = `${path}.writing-${key}.tmp`;
    await writeFile(temporary, doc.body, { flag: 'wx', mode: (await lstat(path)).mode });
    await rename(temporary, path);
  }
  const outputKey = writingHash(JSON.stringify({ facts, documents: result }));
  await writeFile(join(dir, `done-${outputKey}.json`), JSON.stringify({ review: key }));
  await rm(active);
}

export async function writingMain(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      input: { type: 'string' },
      facts: { type: 'string' },
      output: { type: 'string' },
      'run-dir': { type: 'string' },
    },
  });
  assert(
    positionals.length === 1 &&
      ['file', 'documents'].includes(positionals[0] ?? '') &&
      values.facts &&
      values['run-dir'],
    'Usage: writing-review.ts file|documents --facts FILE --run-dir DIR [--input FILE --output FILE]',
  );
  const cwd = await realpath(process.cwd());
  const dir = resolve(values['run-dir']);
  await mkdir(dir, { recursive: true });
  const relation = relative(cwd, await realpath(dir));
  assert(
    relation.startsWith('../') || relation === '..',
    'Writing evidence must be outside checkout',
  );
  const facts = await readFile(values.facts, 'utf8');
  if (positionals[0] === 'documents') {
    await reviewDocuments(cwd, facts, dir, undefined, () => readFile(values.facts ?? '', 'utf8'));
    return;
  }
  assert(
    values.input && values.output && resolve(values.input) !== resolve(values.output),
    'Use separate input and output files',
  );
  const input = await readFile(values.input, 'utf8');
  const result = await reviewWriting([{ name: 'body', body: input }], facts, join(dir, 'review'));
  assert(
    (await readFile(values.input, 'utf8')) === input &&
      (await readFile(values.facts, 'utf8')) === facts,
    'Writing inputs changed',
  );
  assert(result[0]);
  await writeFile(values.output, result[0].body, { flag: 'wx' });
}

if (import.meta.main) {
  try {
    if (process.argv[2] === '--worker') {
      await writingMain(process.argv.slice(3));
    } else {
      const result = await withInterrupts(() =>
        command(
          [process.execPath, import.meta.path, '--worker', ...process.argv.slice(2)],
          process.cwd(),
          '',
          writingHostTimeoutMs,
        ),
      );
      assert(result.code === 0 && !result.timedOut, result.stderr || 'Writing review stopped');
      if (result.stderr.trim()) {
        console.error(result.stderr.trim());
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
