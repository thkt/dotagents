import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, lstat, realpath, rename, rm } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { WritingRunner } from './writing.ts';
import { reviewWriting, runWritingCommand, writingHash, writingHostTimeoutMs } from './writing.ts';
import { isRecord } from './input.ts';
import { command, withInterrupts } from './correction.ts';
import {
  excludedWritingPath,
  issueDraft,
  readWritingSelection,
  selectedDocument,
} from './writing-targets.ts';

async function git(cwd: string, dir: string, args: string[]) {
  return runWritingCommand(['git', ...args], cwd, '', join(dir, 'git'));
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
        skipped.inputHash === writingHash(JSON.stringify({ facts, documents: input })) &&
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

async function changedDocuments(cwd: string, dir: string) {
  const selection = await readWritingSelection(cwd);
  const paths = new Set(
    (
      (await git(cwd, dir, ['diff', '--name-only', '-z', '--diff-filter=AMRC', 'HEAD'])) +
      (await git(cwd, dir, ['ls-files', '--others', '--exclude-standard', '-z']))
    )
      .split('\0')
      .filter((name) => selectedDocument(name, selection)),
  );
  const input = [];
  for (const name of paths) {
    const path = resolve(cwd, name);
    assert(
      (await lstat(path)).isFile() && (await realpath(path)) === path,
      `Writing target must be a regular file: ${name}`,
    );
    const body = await readFile(path, 'utf8');
    if (!issueDraft(body)) {
      input.push({ name, body });
    }
  }
  return { selection, documents: input.sort((a, b) => a.name.localeCompare(b.name)) };
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
  const snapshot = await changedDocuments(cwd, dir);
  const input = snapshot.documents;
  if (!input.length) {
    console.error('Gemini確認: 対象外 (変更された人向けMarkdownなし)');
    return;
  }
  const key = writingHash(JSON.stringify({ facts, ...snapshot }));
  if (await cachedReview(dir, key, facts, input)) {
    return;
  }
  await writeFile(
    active,
    JSON.stringify({ key, selection: snapshot.selection, phase: 'reviewing' }),
    { flag: 'wx' },
  );
  const result = await reviewWriting(input, facts, join(dir, key), runner);
  assert((await currentFacts()) === facts, 'Writing facts changed during review');
  assert.deepEqual(
    await changedDocuments(cwd, dir),
    snapshot,
    'Writing target changed during review',
  );
  await writeFile(join(dir, key, 'selection.json'), JSON.stringify(snapshot.selection));
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
  const outputKey = writingHash(
    JSON.stringify({ facts, selection: snapshot.selection, documents: result }),
  );
  await writeFile(join(dir, `done-${outputKey}.json`), JSON.stringify({ review: key }));
  await rm(active);
}

async function writingFileName(path: string) {
  // A checkout has a .git directory or a .git file (linked worktrees/submodules).
  // Start at the input, so caller directories cannot hide instruction locations.
  for (let root = dirname(path); ; root = dirname(root)) {
    try {
      await lstat(join(root, '.git'));
      return relative(root, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (dirname(root) === root) {
      return path; // External drafts have no checkout boundary.
    }
  }
}

export async function reviewFile(
  inputPath: string,
  factsPath: string,
  outputPath: string,
  dir: string,
  runner?: WritingRunner,
) {
  const path = resolve(inputPath);
  assert(path !== resolve(outputPath), 'Use separate input and output files');
  assert(
    !excludedWritingPath(await writingFileName(path)),
    'Writing file must be human-facing Markdown or a PR body',
  );
  assert(
    (await lstat(path)).isFile() && (await realpath(path)) === path,
    'Writing target must be a regular file',
  );
  const input = await readFile(path, 'utf8');
  assert(!issueDraft(input), 'Issue drafts are outside writing review');
  const facts = await readFile(factsPath, 'utf8');
  const result = await reviewWriting(
    [{ name: 'body', body: input }],
    facts,
    join(dir, 'review'),
    runner,
  );
  assert(
    (await readFile(path, 'utf8')) === input && (await readFile(factsPath, 'utf8')) === facts,
    'Writing inputs changed',
  );
  assert(result[0]);
  await writeFile(outputPath, result[0].body, { flag: 'wx' });
}

async function writingMain(args: string[]) {
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
  if (positionals[0] === 'documents') {
    const facts = await readFile(values.facts, 'utf8');
    await reviewDocuments(cwd, facts, dir, undefined, () => readFile(values.facts ?? '', 'utf8'));
    return;
  }
  assert(
    values.input && values.output && resolve(values.input) !== resolve(values.output),
    'Use separate input and output files',
  );
  await reviewFile(values.input, values.facts, values.output, dir);
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
