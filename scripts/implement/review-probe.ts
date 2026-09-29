// Host-only live-model probe. Kept separate from simulated control tests and common check.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { reviewOnce, snapshot } from './correction.ts';
import { command, withInterrupts } from '../shared/process.ts';
import { isRecord } from '../shared/values.ts';
import { reviewModel } from './review.ts';
import { prepareTestReview } from './review-probe-fixture.ts';

const requirements = {
  title: 'Add array pagination',
  state: 'OPEN',
  updatedAt: '2026-09-15T00:00:00Z',
  body: 'Export page(items, offset, limit) returning at most limit items starting at offset, without mutating the input. Offset and limit must be nonnegative safe integers; otherwise throw RangeError. Empty or exhausted input returns []. Include meaningful tests and a short usage README. No media or publication is required.',
};
const source = (
  broken: boolean,
) => `export function page<T>(items: readonly T[], offset: number, limit: number): T[] {
 if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid page bounds');
 return items.slice(offset, ${broken ? 'limit' : 'offset + limit'});
}
`;
const tests = (broken: boolean) => `import {test,expect} from 'bun:test';
import {page} from './page.ts';
test('pagination contract',()=>{
 const input=[10,20,30,40];
 expect(page(input,0,2)).toEqual([10,20]);
 ${broken ? '' : 'expect(page(input,2,2)).toEqual([30,40]);'}
 expect(page(input,4,3)).toEqual([]);
 expect(page(input,2,0)).toEqual([]);
 expect(page([],0,2)).toEqual([]);
 expect(input).toEqual([10,20,30,40]);
 for(const value of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
  expect(()=>page(input,value,1)).toThrow(RangeError);
  expect(()=>page(input,0,value)).toThrow(RangeError);
 }
});`;

async function checked(argv: string[], cwd: string) {
  const result = await command(argv, cwd, '', 30000);
  assert(result.code === 0 && !result.timedOut, result.stderr);
  return result.stdout.trim();
}

export async function readReviewerUsage(dir: string) {
  const totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let turns = 0;
  for (const entry of await readdir(dir)) {
    if (!entry.startsWith('review-codex-')) {
      continue;
    }
    const lines = (await readFile(join(dir, entry, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event) || event.type !== 'turn.completed' || !isRecord(event.usage)) {
        continue;
      }
      for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const) {
        const count: unknown = event.usage[key];
        assert(
          typeof count === 'number' &&
            Number.isSafeInteger(count) &&
            count >= 0 &&
            Number.isSafeInteger(totals[key] + count),
          'Incomplete model usage',
        );
        totals[key] += count;
      }
      turns++;
    }
  }
  return {
    totals: turns ? totals : null,
    completedTurns: turns,
    scope:
      'Reviewer CLI completed-turn usage; host has no model usage. Any delegated model usage requires separate reconciliation from retained events before claiming a parent/child total.',
  };
}

async function preparePagination(cwd: string, broken: boolean) {
  await writeFile(join(cwd, 'page.ts'), '// Pagination will be implemented here.\n');
  await checked(['git', 'add', '.'], cwd);
  await checked(['git', 'commit', '-qm', 'fixture base'], cwd);
  const baseCommit = await checked(['git', 'rev-parse', 'HEAD'], cwd);
  await writeFile(join(cwd, 'page.ts'), source(broken));
  await writeFile(join(cwd, 'page.test.ts'), tests(broken));
  await writeFile(
    join(cwd, 'README.md'),
    '# Array pagination\n\n`page(items, offset, limit)` returns up to `limit` items starting at `offset`. The input stays unchanged. Bounds must be nonnegative safe integers or a RangeError is thrown. Run `bun test`.\n',
  );
  return { baseCommit, body: requirements.body, reviewTimeMs: 1200000 };
}

async function prepare(root: string, id: string, name: string) {
  const broken = name === 'defective';
  const dir = join(root, id),
    cwd = join(dir, 'checkout');
  await mkdir(cwd, { recursive: true });
  await checked(['git', 'init', '-q'], cwd);
  await checked(['git', 'config', 'user.name', 'Review fixture'], cwd);
  await checked(['git', 'config', 'user.email', 'fixture@example.com'], cwd);
  const fixture =
    name === 'defective' || name === 'correct'
      ? await preparePagination(cwd, broken)
      : await prepareTestReview(cwd, join(root, 'host', id), name, source(false));
  const { baseCommit } = fixture;
  await writeFile(join(dir, 'issue.json'), JSON.stringify({ ...requirements, body: fixture.body }));
  await writeFile(
    join(dir, 'issue.ts'),
    `console.log(await Bun.file(${JSON.stringify(join(dir, 'issue.json'))}).text());`,
  );
  const config = {
    cwd,
    runDir: join(dir, 'verification'),
    baseCommit,
    reviewModel,
    issue: [process.execPath, join(dir, 'issue.ts')],
    check: [process.execPath, 'test'],
    review: [process.execPath, resolve(import.meta.dir, 'codex-actor.ts'), 'review', dir],
    reviewTimeMs: fixture.reviewTimeMs,
    checkTimeMs: 540000,
  };
  await writeFile(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return { id, name, dir, cwd, baseCommit, config, fixture };
}

async function probe(root: string, prepared: Awaited<ReturnType<typeof prepare>>) {
  const { id, name, dir, cwd, baseCommit, config, fixture } = prepared;
  const broken = name === 'defective';
  const started = performance.now();
  const state = await reviewOnce(config);
  const elapsedMs = performance.now() - started;
  // Independent oracle is deliberately outside the reviewed checkout/check. It diagnoses
  // the known defect after review, without coaching the model about the missing condition.
  const hostDir = join(root, 'host', id);
  await mkdir(hostDir, { recursive: true });
  const oracle = join(hostDir, 'oracle.ts');
  await writeFile(
    oracle,
    `import {page} from ${JSON.stringify(join(cwd, 'page.ts'))}; console.log(JSON.stringify(page([10,20,30,40],2,2)));`,
  );
  const actual = await checked([process.execPath, oracle], cwd);
  assert(
    actual === (broken ? '[]' : '[30,40]'),
    'Fixture no longer matches the independently defined oracle',
  );
  const review = state.reviewHistory.at(-1);
  const reproduced: unknown = JSON.parse(actual);
  const result = {
    id,
    name,
    baseCommit,
    fixture,
    elapsedMs,
    modelMs: state.modelMs,
    stop: state.result,
    review: review ?? null,
    usage: await readReviewerUsage(dir),
    reproduction: {
      input: { items: [10, 20, 30, 40], offset: 2, limit: 2 },
      expected: [30, 40],
      actual: reproduced,
      oracle,
      source: join(cwd, 'page.ts'),
    },
    adjudication: {
      status: 'pending_host_adjudication',
      knownDefect: broken
        ? 'slice uses limit as end index; nonzero offset can return too few items'
        : null,
      missedKnownDefect: null,
      expectedTestGap:
        name === 'weak'
          ? '07-offset duplicates the start boundary and misses a nonzero-offset regression'
          : null,
      inputIntegrity: 'unconfirmed',
      verificationClaims: 'unconfirmed',
      findings:
        review?.items.map((item) => ({
          id: item.id,
          verdict: 'unconfirmed',
          reproduction: null,
          reason: null,
        })) ?? [],
      instruction:
        'Adjudicate every finding from code and a reproduction input. Record demonstrated, false_positive, or unconfirmed, missed known defects, and any model delegation usage. Review status alone is not a detection verdict. Check verification claims against retained command outputs; missing evidence remains unconfirmed. Inspect tool traces for access to host answers, oracles or other trials and separate contaminated trials from ordinary results. Normal target records and check logs are permitted.',
    },
    limitations: [
      'One synthetic run per artifact; no detection-rate or speed claim.',
      'No GitHub publication, browser, concurrent review or full repository audit.',
    ],
  };
  await writeFile(join(hostDir, 'result.json'), JSON.stringify(result, null, 2));
  return { id, result: join(hostDir, 'result.json'), stop: state.result };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  assert(
    args.length === 0 ||
      (args.length === 2 && args[0] === '--scenario' && args[1] === 'test-review'),
    'Usage: bun scripts/implement/review-probe.ts [--scenario test-review]',
  );
  const testReview = args.length > 0;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-live-')));
  console.error(`Live review evidence retained at ${root}`);
  try {
    await withInterrupts(async () => {
      // Random names and order have no fixed relationship to the answer. Retain the
      // mapping before launch so an interrupted run is still identifiable by the host.
      // Nothing in host/ is referenced by the default reviewer input; this is not a
      // filesystem security boundary against deliberate surrounding-file exploration.
      const hostDir = join(root, 'host');
      await mkdir(hostDir, { recursive: true });
      const names = testReview ? ['weak', 'sound', 'unchanged'] : ['correct', 'defective'];
      for (let i = names.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        const left = names[i],
          right = names[j];
        assert(left !== undefined && right !== undefined);
        [names[i], names[j]] = [right, left];
      }
      const cases = [];
      for (const name of names) {
        const id = basename(await mkdtemp(join(root, 'case-')));
        cases.push({ id, name });
      }
      await writeFile(join(hostDir, 'cases.json'), JSON.stringify(cases, null, 2));
      const environment = {
        scenario: testReview ? 'test-review' : 'pagination',
        model: reviewModel,
        bun: Bun.version,
        codex: await checked(['codex', '--version'], root),
        harnessSource: await snapshot(resolve(import.meta.dir, '../..')),
        harnessCommit: await checked(['git', 'rev-parse', 'HEAD'], import.meta.dir),
        harnessDiff: await checked(['git', 'diff', '--binary', 'HEAD'], import.meta.dir),
      };
      await writeFile(join(hostDir, 'environment.json'), JSON.stringify(environment, null, 2));
      // Validate every fixture before spending any model budget.
      const prepared = [];
      for (const { id, name } of cases) {
        prepared.push(await prepare(root, id, name));
      }
      const results = [];
      for (const entry of prepared) {
        results.push(await probe(root, entry));
      }
      console.log(
        JSON.stringify(
          {
            root,
            results,
            remaining: 'Host adjudication of findings and usage; publish only sanitized evidence.',
          },
          null,
          2,
        ),
      );
    });
  } catch (error) {
    await writeFile(join(root, 'stopped.txt'), String(error));
    throw error;
  }
}
