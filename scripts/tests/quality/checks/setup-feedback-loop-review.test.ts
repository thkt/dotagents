import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import {
  type Fixture,
  config as baseConfig,
  files as baseFiles,
  fixture,
  header,
  run,
  setup,
} from '../../support/feedback-loop-batch.ts';
import { git } from '../../support/runner-affected.ts';

// docs/wiki/setup-feedback-loop-contract.mdの「分類の確認記録」と、
// check:classification・--completeの公開入口だけを期待値の根拠にする。
const reviewPath = '.feedback-loop-review.json';
const config = {
  ...baseConfig,
  assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放の確認' }],
};
const files = {
  ...baseFiles,
  '.feedback-loop.json': JSON.stringify(config),
  'test/a.test.ts':
    header +
    "import { value } from '../src/input.ts'; test('a', () => { console.log('QUALITY_A'); expect(value).toBeGreaterThan(0); });\n",
  'test/b.test.ts': header + "test('b', () => { console.log('QUALITY_B'); expect(1).toBe(1); });\n",
  'test/assurance.test.ts':
    header + "test('cleanup', () => { console.log('ASSURANCE_RAN'); expect(1).toBe(1); });\n",
};
const collected = ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'];
// 実行時の分類は.feedback-loop.jsonのassurance指定だけで決まる。
const classOf = (path: string) => (path === 'test/assurance.test.ts' ? 'assurance' : 'quality');

type ReviewEntry = { path: string; class: string; sha256: string; reason?: string };

async function sha256(f: Fixture, path: string) {
  return createHash('sha256')
    .update(await readFile(join(f.repo, path)))
    .digest('hex');
}

// 現在の内容から、全収集ファイルの確認済み記録を作る。
async function reviewedEntries(f: Fixture, paths = collected): Promise<ReviewEntry[]> {
  return Promise.all(
    paths.map(async (path) => {
      const entry: ReviewEntry = {
        path,
        class: classOf(path),
        sha256: await sha256(f, path),
      };
      if (entry.class === 'quality') {
        entry.reason = `${path}の公開した入出力を確認する`;
      }
      return entry;
    }),
  );
}

async function writeReview(f: Fixture, review: unknown) {
  await writeFile(
    join(f.repo, reviewPath),
    typeof review === 'string' ? review : JSON.stringify(review),
  );
}

function apply(f: Fixture) {
  const applied = run(f, [
    setup,
    'apply',
    '--repo',
    f.repo,
    '--feedback-command',
    'bun run test:affected',
  ]);
  expect(applied.code, applied.output).toBe(0);
}

function classify(f: Fixture, complete = false) {
  return run(f, ['run', 'check:classification', ...(complete ? ['--', '--complete'] : [])]);
}

type ReviewFile = { path: string; class: unknown; sha256: unknown; status: unknown };

function reviewOf(stdout: string) {
  const parsed: unknown = JSON.parse(stdout);
  assert(isRecord(parsed), stdout);
  const review = parsed.review;
  assert(isRecord(review), `reviewがありません: ${stdout}`);
  assert(Array.isArray(review.files), stdout);
  const byPath = new Map<string, ReviewFile>();
  for (const file of review.files) {
    assert(isRecord(file) && typeof file.path === 'string', stdout);
    expect(byPath.has(file.path), `review.filesのpath重複: ${file.path}`).toBe(false);
    byPath.set(file.path, {
      path: file.path,
      class: file.class,
      sha256: file.sha256,
      status: file.status,
    });
  }
  // orphansの要素の形は公開仕様で固定されていないため、pathの文字列か{path}を受け付ける。
  assert(Array.isArray(review.orphans), `review.orphansがありません: ${stdout}`);
  const orphans = review.orphans.map((orphan: unknown) => {
    const path = isRecord(orphan) ? orphan.path : orphan;
    assert(typeof path === 'string', stdout);
    return path;
  });
  return { parsed, complete: review.complete, files: byPath, orphans };
}

function sorted(value: unknown) {
  assert(Array.isArray(value) && value.every((item) => typeof item === 'string'), String(value));
  return value.toSorted((x, y) => x.localeCompare(y));
}

async function expectStatuses(
  f: Fixture,
  stdout: string,
  statuses: Record<string, string>,
  orphans: string[] = [],
) {
  const review = reviewOf(stdout);
  const paths = sorted(Object.keys(statuses));
  // 従来のall・quality・assuranceも同じJSONに残る。
  expect(sorted(review.parsed.all)).toEqual(paths);
  expect(sorted(review.parsed.quality)).toEqual(paths.filter((p) => classOf(p) === 'quality'));
  expect(sorted(review.parsed.assurance)).toEqual(paths.filter((p) => classOf(p) === 'assurance'));
  expect(sorted([...review.files.keys()])).toEqual(paths);
  for (const [path, status] of Object.entries(statuses)) {
    expect(review.files.get(path), path).toEqual({
      path,
      // mismatchの行で記録側と実行側のどちらのclassを出すかは仕様で固定されていない。
      class: status === 'mismatch' ? review.files.get(path)?.class : classOf(path),
      sha256: await sha256(f, path),
      status,
    });
  }
  expect(sorted(review.orphans)).toEqual(sorted(orphans));
  expect(review.complete).toBe(
    orphans.length === 0 && Object.values(statuses).every((status) => status === 'reviewed'),
  );
}

test('全収集ファイルに現在の版の記録があれば、日常と--completeの両方で確認完了を返す', async () => {
  await fixture(files, async (f) => {
    apply(f);
    await writeReview(f, { version: 1, files: await reviewedEntries(f) });
    const expected = Object.fromEntries(collected.map((path) => [path, 'reviewed']));
    for (const complete of [false, true]) {
      const result = classify(f, complete);
      expect(result.code, result.output).toBe(0);
      await expectStatuses(f, result.stdout, expected);
      expect(reviewOf(result.stdout).complete).toBe(true);
    }
  });
});

test('記録ファイルがなければ日常は全件をunreviewedとして通し、--completeは完了扱いしない', async () => {
  await fixture(files, async (f) => {
    apply(f);
    const expected = Object.fromEntries(collected.map((path) => [path, 'unreviewed']));
    const daily = classify(f);
    expect(daily.code, daily.output).toBe(0);
    await expectStatuses(f, daily.stdout, expected);
    for (const path of collected) {
      expect(daily.stderr).toContain(path);
    }
    const complete = classify(f, true);
    expect(complete.code, complete.output).not.toBe(0);
    await expectStatuses(f, complete.stdout, expected);
    for (const path of collected) {
      expect(complete.stderr).toContain(path);
    }
    // 検査自身が記録を作り、未確認を確認済みへ変えることはしない。
    expect(existsSync(join(f.repo, reviewPath))).toBe(false);
    const again = classify(f, true);
    expect(again.code, again.output).not.toBe(0);
  });
});

for (const scenario of ['stale-quality', 'stale-assurance', 'unreviewed', 'new-test'] as const) {
  test(`${scenario}が1件でも残れば日常は通し、--completeはそのpathを示して拒否する`, async () => {
    await fixture(files, async (f) => {
      apply(f);
      const entries = await reviewedEntries(f);
      const expected = Object.fromEntries(collected.map((path) => [path, 'reviewed']));
      let pending: string;
      if (scenario === 'unreviewed') {
        pending = 'test/b.test.ts';
        await writeReview(f, { version: 1, files: entries.filter((e) => e.path !== pending) });
        expected[pending] = 'unreviewed';
      } else if (scenario === 'new-test') {
        await writeReview(f, { version: 1, files: entries });
        pending = 'test/c.test.ts';
        await writeFile(
          join(f.repo, pending),
          header + "test('c', () => { console.log('QUALITY_C'); expect(1).toBe(1); });\n",
        );
        expected[pending] = 'unreviewed';
      } else {
        // 記録後にテスト本体を変更し、古い確認結果を新しい版の確認済みへ読み替えない。
        await writeReview(f, { version: 1, files: entries });
        const stale = scenario === 'stale-quality' ? 'test/a.test.ts' : 'test/assurance.test.ts';
        pending = stale;
        await writeFile(join(f.repo, stale), `${files[stale]}// 確認後の変更\n`);
        expected[pending] = 'stale';
      }
      const daily = classify(f);
      expect(daily.code, daily.output).toBe(0);
      await expectStatuses(f, daily.stdout, expected);
      expect(daily.stderr).toContain(pending);
      const complete = classify(f, true);
      expect(complete.code, complete.output).not.toBe(0);
      await expectStatuses(f, complete.stdout, expected);
      expect(complete.stderr).toContain(pending);
    });
  });
}

// 記録ファイル自体の誤り。期待する診断は、ファイル名と原因を区別できる語。
const structural: Record<string, { cause: RegExp; mutate: (entries: ReviewEntry[]) => unknown }> = {
  'invalid-json': { cause: /JSON/, mutate: () => '{"version":1,"files":[' },
  'files-not-array': { cause: /files/, mutate: () => ({ version: 1, files: {} }) },
  'unsupported-version': {
    cause: /version/,
    mutate: (entries) => ({ version: 2, files: entries }),
  },
  'duplicate-path': {
    cause: /重複|duplicate/i,
    mutate: (entries) => ({ version: 1, files: [...entries, entries[0]] }),
  },
  'empty-quality-reason': {
    cause: /reason/,
    mutate: (entries) => ({
      version: 1,
      files: entries.map((e) => (e.path === 'test/a.test.ts' ? { ...e, reason: '' } : e)),
    }),
  },
  'missing-quality-reason': {
    cause: /reason/,
    mutate: (entries) => ({
      version: 1,
      files: entries.map((e) => {
        if (e.path !== 'test/a.test.ts') {
          return e;
        }
        const { reason: _omitted, ...rest } = e;
        return rest;
      }),
    }),
  },
  'assurance-reason': {
    cause: /reason/,
    mutate: (entries) => ({
      version: 1,
      files: entries.map((e) =>
        e.path === 'test/assurance.test.ts' ? { ...e, reason: '資源解放の確認' } : e,
      ),
    }),
  },
  'uppercase-sha256': {
    cause: /sha256/,
    mutate: (entries) => ({
      version: 1,
      files: entries.map((e) =>
        e.path === 'test/a.test.ts' ? { ...e, sha256: e.sha256.toUpperCase() } : e,
      ),
    }),
  },
  'short-sha256': {
    cause: /sha256/,
    mutate: (entries) => ({
      version: 1,
      files: entries.map((e) => (e.path === 'test/a.test.ts' ? { ...e, sha256: 'abc123' } : e)),
    }),
  },
  'unknown-class': {
    cause: /class/,
    mutate: (entries) => ({
      version: 1,
      files: entries.map((e) => (e.path === 'test/a.test.ts' ? { ...e, class: 'unit' } : e)),
    }),
  },
};

for (const [scenario, { cause, mutate }] of Object.entries(structural)) {
  test(`確認記録の${scenario}は確認の完了に関係なく日常の分類検査でも原因を示して拒否する`, async () => {
    await fixture(files, async (f) => {
      apply(f);
      const entries = await reviewedEntries(f);
      await writeReview(f, { version: 1, files: entries });
      const control = classify(f);
      expect(control.code, control.output).toBe(0);
      expect(reviewOf(control.stdout).complete).toBe(true);
      await writeReview(f, mutate(entries));
      const before = await readFile(join(f.repo, reviewPath), 'utf8');
      const result = classify(f);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(reviewPath);
      expect(result.output).toMatch(cause);
      expect(await readFile(join(f.repo, reviewPath), 'utf8')).toBe(before);
    });
  });
}

// 集合外の記録はorphans、assurance指定と食い違うclassはmismatch。
// どちらも日常は通し、--completeでは完了扱いしない。
const leftovers: Record<
  string,
  {
    pending: string;
    orphans: string[];
    statuses: Record<string, string>;
    mutate: (entries: ReviewEntry[]) => unknown;
  }
> = {
  'outside-existing': {
    pending: 'src/input.ts',
    orphans: ['src/input.ts'],
    statuses: {},
    mutate: (entries) => ({
      version: 1,
      files: [
        ...entries,
        { path: 'src/input.ts', class: 'quality', sha256: entries[0]?.sha256, reason: '範囲外' },
      ],
    }),
  },
  'outside-missing': {
    pending: 'test/missing.test.ts',
    orphans: ['test/missing.test.ts'],
    statuses: {},
    mutate: (entries) => ({
      version: 1,
      files: [
        ...entries,
        { path: 'test/missing.test.ts', class: 'quality', sha256: '0'.repeat(64), reason: '不在' },
      ],
    }),
  },
  'quality-recorded-as-assurance': {
    pending: 'test/b.test.ts',
    orphans: [],
    statuses: { 'test/b.test.ts': 'mismatch' },
    mutate: (entries) => ({
      version: 1,
      files: entries.map((e) => {
        if (e.path !== 'test/b.test.ts') {
          return e;
        }
        const { reason: _omitted, ...rest } = e;
        return { ...rest, class: 'assurance' };
      }),
    }),
  },
  'assurance-recorded-as-quality': {
    pending: 'test/assurance.test.ts',
    orphans: [],
    statuses: { 'test/assurance.test.ts': 'mismatch' },
    mutate: (entries) => ({
      version: 1,
      files: entries.map((e) =>
        e.path === 'test/assurance.test.ts'
          ? { ...e, class: 'quality', reason: '資源解放の確認' }
          : e,
      ),
    }),
  },
};

for (const [scenario, { pending, orphans, statuses, mutate }] of Object.entries(leftovers)) {
  test(`確認記録の${scenario}は日常は通し、--completeはそのpathを示して拒否する`, async () => {
    await fixture(files, async (f) => {
      apply(f);
      await writeReview(f, mutate(await reviewedEntries(f)));
      const expected = {
        ...Object.fromEntries(collected.map((path) => [path, 'reviewed'])),
        ...statuses,
      };
      const daily = classify(f);
      expect(daily.code, daily.output).toBe(0);
      await expectStatuses(f, daily.stdout, expected, orphans);
      expect(daily.stderr).toContain(pending);
      const complete = classify(f, true);
      expect(complete.code, complete.output).not.toBe(0);
      await expectStatuses(f, complete.stdout, expected, orphans);
      expect(complete.stderr).toContain(pending);
    });
  });
}

test('staleとunreviewedのqualityは実行され続け、staleなassuranceは除外され続ける', async () => {
  await fixture(files, async (f) => {
    apply(f);
    // aとassuranceだけを記録し、bは未確認のままcommitする。
    const entries = await reviewedEntries(f, ['test/a.test.ts', 'test/assurance.test.ts']);
    await writeReview(f, { version: 1, files: entries });
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-m', 'partial review');
    for (const path of ['test/a.test.ts', 'test/assurance.test.ts'] as const) {
      await writeFile(join(f.repo, path), `${files[path]}// 確認後の変更\n`);
    }
    const changed = run(f, ['run', 'test:affected']);
    expect(changed.code, changed.output).toBe(0);
    expect(changed.output).toContain('QUALITY_A');
    expect(changed.output).not.toContain('ASSURANCE_RAN');

    await writeFile(join(f.repo, 'unknown.txt'), 'unmapped input');
    const widened = run(f, ['run', 'test:affected']);
    expect(widened.code, widened.output).toBe(0);
    expect(widened.output).toContain('QUALITY_A');
    expect(widened.output).toContain('QUALITY_B');
    expect(widened.output).not.toContain('ASSURANCE_RAN');

    const classified = classify(f);
    expect(classified.code, classified.output).toBe(0);
    await expectStatuses(f, classified.stdout, {
      'test/a.test.ts': 'stale',
      'test/assurance.test.ts': 'stale',
      'test/b.test.ts': 'unreviewed',
    });
  });
}, 60000);

test('確認記録の変更は関連選択の入力にならず、記録だけの変更は変更なしとしてテストを実行しない', async () => {
  await fixture(files, async (f) => {
    apply(f);
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-m', 'configured');
    // 公開入口の初回実行で依存記録を作る。
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const seeded = run(f, ['run', 'test:affected']);
    expect(seeded.code, seeded.output).toBe(0);

    const control = run(f, ['run', 'test:affected']);
    expect(control.code, control.output).toBe(0);
    expect(control.output).toContain('QUALITY_A');
    expect(control.output).not.toContain('QUALITY_B');
    expect(control.output).not.toContain('quality全件の理由:');

    await writeReview(f, { version: 1, files: await reviewedEntries(f) });
    expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toContain(reviewPath);
    const mixed = run(f, ['run', 'test:affected']);
    expect(mixed.code, mixed.output).toBe(0);
    expect(mixed.output).toContain('QUALITY_A');
    expect(mixed.output).not.toContain('QUALITY_B');
    expect(mixed.output).not.toContain('quality全件の理由:');
    expect(mixed.output).not.toContain('ASSURANCE_RAN');

    // 通常ソースを戻し、未追跡の記録だけが差分に残る状態と、追跡済み記録の変更だけの状態を確かめる。
    await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
    const unchanged = (await readFile(join(f.repo, reviewPath), 'utf8')).length;
    expect(unchanged).toBeGreaterThan(0);
    for (const stage of ['untracked', 'tracked-modified'] as const) {
      if (stage === 'tracked-modified') {
        git(f.repo, 'add', reviewPath);
        git(f.repo, 'commit', '-m', 'review record');
        const entries = await reviewedEntries(f);
        await writeReview(f, {
          version: 1,
          files: entries.map((e) =>
            e.path === 'test/b.test.ts' ? { ...e, reason: '確認理由を更新した' } : e,
          ),
        });
        expect(git(f.repo, 'diff', '--name-only')).toBe(reviewPath);
      } else {
        expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe(
          `?? ${reviewPath}`,
        );
      }
      const recordOnly = run(f, ['run', 'test:affected']);
      expect(recordOnly.code, `${stage}: ${recordOnly.output}`).not.toBe(0);
      expect(recordOnly.output).toContain('変更なし');
      for (const marker of ['QUALITY_A', 'QUALITY_B', 'ASSURANCE_RAN']) {
        expect(recordOnly.output, stage).not.toContain(marker);
      }
    }
  });
}, 60000);

test('applyは確認記録を作成・変更せず、記録の有無にかかわらず再applyが進む', async () => {
  await fixture(files, async (f) => {
    apply(f);
    expect(existsSync(join(f.repo, reviewPath))).toBe(false);
    // 未確認を含む構造上正しい記録を置いても、再applyはそれを書き換えない。
    const partial = JSON.stringify({
      version: 1,
      files: await reviewedEntries(f, ['test/a.test.ts']),
    });
    await writeReview(f, partial);
    apply(f);
    expect(await readFile(join(f.repo, reviewPath), 'utf8')).toBe(partial);
    const classified = classify(f);
    expect(classified.code, classified.output).toBe(0);
    expect(reviewOf(classified.stdout).complete).toBe(false);
  });
});

// 記録はcheck:classificationだけが読む。テストの削除・改名・分類変更で残った記録や、
// 不正な記録ファイルを理由にtest:affectedと再applyを止めない。
const operations = ['delete', 'rename', 'reclassify', 'invalid-json'] as const;

async function operate(f: Fixture, operation: (typeof operations)[number]) {
  if (operation === 'delete') {
    git(f.repo, 'rm', '-q', 'test/b.test.ts');
  } else if (operation === 'rename') {
    git(f.repo, 'mv', 'test/b.test.ts', 'test/renamed.test.ts');
  } else if (operation === 'reclassify') {
    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({
        ...config,
        assurance: [...config.assurance, { path: 'test/b.test.ts', reason: '分類を変更した対照' }],
      }),
    );
  } else {
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
  }
}

type Operation = (typeof operations)[number];

async function recordAndCommit(f: Fixture, operation: Operation, withRecord: boolean) {
  apply(f);
  if (withRecord) {
    await writeReview(
      f,
      operation === 'invalid-json'
        ? '{"version":1,"files":['
        : { version: 1, files: await reviewedEntries(f) },
    );
  }
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-m', 'configured with review record');
}

function expectAffected(operation: Operation, output: string) {
  expect(output).not.toContain('ASSURANCE_RAN');
  // reclassifyではbがassuranceへ移るため実行しない。他の操作では残ったqualityを実行する。
  if (operation === 'reclassify') {
    expect(output).not.toContain('QUALITY_B');
  } else {
    expect(output).toContain('QUALITY_A');
  }
  if (operation === 'rename') {
    expect(output).toContain('QUALITY_B');
  }
}

// 記録を読むcheck:classificationだけが、残った記録を表示または拒否する。
function expectClassifiedAfter(f: Fixture, operation: Operation) {
  const daily = classify(f);
  if (operation === 'invalid-json') {
    expect(daily.code, daily.output).not.toBe(0);
    expect(daily.output).toContain(reviewPath);
    return;
  }
  expect(daily.code, daily.output).toBe(0);
  const review = reviewOf(daily.stdout);
  if (operation === 'reclassify') {
    expect(review.files.get('test/b.test.ts')?.status).toBe('mismatch');
  } else {
    expect(review.orphans).toEqual(['test/b.test.ts']);
  }
  expect(daily.stderr).toContain('test/b.test.ts');
  expect(review.complete).toBe(false);
  const complete = classify(f, true);
  expect(complete.code, complete.output).not.toBe(0);
  expect(complete.stderr).toContain('test/b.test.ts');
}

for (const operation of operations) {
  test(`記録をcommitした後の${operation}でも、test:affectedと再applyは記録を理由に止まらない`, async () => {
    // 記録なしの対照でも同じ操作が終了0になることを先に確かめ、記録の有無だけを比べる。
    for (const withRecord of [false, true]) {
      await fixture(files, async (f) => {
        await recordAndCommit(f, operation, withRecord);
        await operate(f, operation);
        const label = withRecord ? '記録あり' : '記録なしの対照';
        const affected = run(f, ['run', 'test:affected']);
        expectAffected(operation, affected.output);
        expect(affected.code, `${label}: ${affected.output}`).toBe(0);
        const before = withRecord ? await readFile(join(f.repo, reviewPath), 'utf8') : '';
        const reapplied = run(f, [
          setup,
          'apply',
          '--repo',
          f.repo,
          '--feedback-command',
          'bun run test:affected',
        ]);
        expect(reapplied.code, `${label}: ${reapplied.output}`).toBe(0);
        if (withRecord) {
          expect(affected.output).not.toContain(reviewPath);
          expect(await readFile(join(f.repo, reviewPath), 'utf8')).toBe(before);
          expectClassifiedAfter(f, operation);
        }
      });
    }
  }, 60000);
}
