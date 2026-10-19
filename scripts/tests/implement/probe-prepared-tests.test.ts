import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertConfig, assertProbeConfig } from '../../implement/input.ts';
import { hash } from '../../implement/host-records.ts';
import {
  authorTests,
  prepareTestBaseline,
  readPreparedTestRecord,
  verifyTestArtifacts,
} from '../../implement/test-author.ts';
import { command } from '../../shared/process.ts';
import { correctionFixture, object, reviewReplySource } from '../support/correction.ts';

// #406の保証3・6・7と独立評価への接続。preparedTestsは入力で指定された接続名であり、
// 期待値は固定Issue・原記録の保全・現在資産の照合から定める。実モデルは使わない。
const { trial, cleanup } = correctionFixture();
afterEach(cleanup);
const issue = '合意したsourceと独立テストを照合してから評価し、記録を保全する。';
const asset = 'source.test.js';
const source =
  "import {readFileSync} from 'node:fs'; process.exit(readFileSync('source.txt','utf8')==='correct'?0:1);\n";

async function fixture(status: 'prepared' | 'unnecessary' = 'prepared', boundary = '') {
  const t = await trial('normal');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  const executions = join(t.root, 'executions.jsonl');
  await writeFile(executions, '');
  const external = join(t.root, 'independent');
  await mkdir(external);
  const prefix = join(external, 'test-1');
  await writeFile(
    join(t.root, 'helper.js'),
    `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
appendFileSync(${JSON.stringify(executions)},JSON.stringify(role)+'\\n');
if(role==='issue') process.stdout.write(${JSON.stringify(issue)});
if(role==='check' || role==='review') {
 if(role===${JSON.stringify(boundary)}) {
  const file=${JSON.stringify(prefix)}+(role==='check'?'.json':'.prompt');
  writeFileSync(file,readFileSync(file,'utf8')+'\\n');
 }
 if(role==='check') process.exit(readFileSync('source.txt','utf8')==='correct'?0:1);
 console.log(JSON.stringify(reviewReply('accepted','模擬評価。受入の証拠ではない。')));
}
if(role==='repair') throw Error('修正担当は起動しない');
`,
  );
  const baseline = join(t.root, 'baseline');
  await prepareTestBaseline(t.config.cwd, baseline);
  const prepared = await authorTests(
    {
      cwd: t.config.cwd,
      baseline,
      prefix,
      issue,
      baseCommit: '固定した修正前版',
      check: t.config.check,
      actor: ['independent-fixture'],
      previous: [],
      stage: 'host_return',
    },
    async (argv, cwd, prompt, timeout, output) => {
      if (argv[0] !== 'independent-fixture') {
        return command(argv, cwd, prompt, timeout, output);
      }
      const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
      if (status === 'prepared') {
        await writeFile(join(cwd, asset), source, { mode: 0o755 });
      }
      const stdout = JSON.stringify({
        targetId: input.targetId,
        status,
        findings: '固定要求に従う独立記録。模擬工程。',
        files: status === 'prepared' ? [asset] : [],
      });
      assert(output);
      await writeFile(`${output}.stdout`, stdout);
      return { code: 0, stdout, stderr: '', timedOut: false, ms: 1 };
    },
  );
  assert(prepared.record);
  const path = `${prefix}.json`;
  const original = await readFile(path, 'utf8');
  // 接続テストの前提を既存の独立記録境界で確認する。JSONを手作りして由来を省略しない。
  const issueOutput = await command(t.config.issue, t.config.cwd, '', 10000);
  expect(issueOutput.code).toBe(0);
  expect(issueOutput.stdout).toBe(issue);
  expect(await readPreparedTestRecord(original, issueOutput.stdout, t.config.cwd)).toEqual(
    prepared.record,
  );
  const ref = { path, sha256: hash(original) };
  const { repair: _repair, ...review } = t.config;
  const config = { ...review, reviewTimeMs: 10000, preparedTests: [ref] };
  const run = async (include = true) => {
    const { preparedTests: _tests, ...without } = config;
    await writeFile(t.configFile, JSON.stringify(include ? config : without));
    return t.execute('review');
  };
  const roles = async () =>
    (await readFile(executions, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const role: unknown = JSON.parse(line);
        assert(typeof role === 'string');
        return role;
      });
  return { ...t, prefix, ref, original, config, run, roles, record: prepared.record };
}

test('準備記録を省略した既存の1回評価はcheckと評価へ到達する', async () => {
  const t = await fixture('unnecessary');
  const result = await t.run(false);
  expect(result.status, result.stderr).toBe(0);
  expect(await t.state()).toMatchObject({
    result: 'review_completed',
    checks: 1,
    review: 1,
    repair: 0,
  });
  expect((await t.roles()).filter((role) => role !== 'issue')).toEqual(['check', 'review']);
});

for (const status of ['prepared', 'unnecessary'] as const) {
  test(`1回評価は準備済み独立記録を対象へ接続して原hashを保つ: ${status}`, async () => {
    const t = await fixture(status);
    const result = await t.run();
    expect(result.status, result.stderr).toBe(0);
    const state = await t.state();
    expect(state).toMatchObject({ result: 'review_completed', checks: 1, review: 1, repair: 0 });
    const target = object(await Bun.file(join(t.config.runDir, 'review-1.target.json')).json());
    expect(target.tests).toEqual([t.record]);
    expect(state.testRecords).toEqual([t.record]);
    expect((await t.roles()).filter((role) => role !== 'issue')).toEqual(['check', 'review']);
    expect(await readFile(t.ref.path, 'utf8')).toBe(t.original);
    if (status === 'prepared') {
      expect(await readFile(join(t.config.cwd, asset), 'utf8')).toBe(source);
      expect((await stat(join(t.config.cwd, asset))).mode & 0o777).toBe(0o755);
    }
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const failures: { name: string; reason: RegExp; change: (t: Fixture) => Promise<unknown> }[] = [
  { name: '原記録欠落', reason: /ENOENT|missing|欠落/i, change: (t) => rm(t.ref.path) },
  {
    name: 'checkout内の参照',
    reason: /outside|checkout|作業場所|外/i,
    change: async (t) => {
      t.ref.path = join(t.config.cwd, 'prepared-record.json');
      await writeFile(t.ref.path, t.original);
    },
  },
  {
    name: '参照hash違い',
    reason: /hash|変更|一致|evidence changed/i,
    change: async (t) => {
      t.ref.sha256 = '0'.repeat(64);
    },
  },
  {
    name: '固定Issue違い',
    reason: /issue|要求/i,
    change: (t) => writeFile(join(t.root, 'helper.js'), `console.log('別の合意済み要求');`),
  },
  {
    name: '現在資産の内容違い',
    reason: /成果物|artifact|テスト.*変更/i,
    change: (t) => writeFile(join(t.config.cwd, asset), 'process.exit(0);\n'),
  },
  {
    name: '現在資産のmode違い',
    reason: /成果物|artifact|mode|変更/i,
    change: (t) => chmod(join(t.config.cwd, asset), 0o644),
  },
  ...(['stdout', 'target.json', 'prompt'] as const).map((suffix) => ({
    name: `原${suffix}変更`,
    reason:
      suffix === 'stdout'
        ? /応答|stdout|response/i
        : suffix === 'prompt'
          ? /指示|prompt/i
          : /入力|input|target/i,
    change: (t: Fixture) => writeFile(`${t.prefix}.${suffix}`, '変更された原記録'),
  })),
];

for (const failure of failures) {
  test(`1回評価は不正な準備記録で後続評価を抑止する: ${failure.name}`, async () => {
    const t = await fixture();
    await failure.change(t);
    const result = await t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/Unknown configuration field|SyntaxError|TypeError/);
    expect(result.stderr + result.stdout).toMatch(failure.reason);
    expect((await t.roles()).filter((role) => role !== 'issue')).toEqual([]);
    expect(await Bun.file(join(t.config.runDir, 'review-1.json')).exists()).toBe(false);
  });
}

for (const boundary of ['check', 'review']) {
  test(`1回評価は${boundary}中の独立記録変更を現在の成功にしない`, async () => {
    const t = await fixture('prepared', boundary);
    const result = await t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('Unknown configuration field');
    expect(result.stderr + result.stdout).toMatch(
      boundary === 'check' ? /evidence|記録|変更/i : /指示|prompt/i,
    );
    const roles = (await t.roles()).filter((role) => role !== 'issue');
    expect(roles).toEqual(boundary === 'check' ? ['check'] : ['check', 'review']);
    expect(await Bun.file(join(t.config.runDir, 'review-1.json')).exists()).toBe(false);
    expect(await readFile(t.ref.path, 'utf8')).toBe(
      boundary === 'check' ? t.original + '\n' : t.original,
    );
  });
}

test('同じ観測の共有でも各記録の期待hashと古い保護対象を省略しない', async () => {
  const t = await fixture();
  for (const key of ['stdoutHash', 'inputHash', 'promptHash'] as const) {
    await verifyTestArtifacts(t.config.cwd, [t.record, t.record]);
    await assert.rejects(
      verifyTestArtifacts(t.config.cwd, [t.record, { ...t.record, [key]: '0'.repeat(64) }]),
      /応答|入力|指示/,
    );
  }
  // 後の記録のfilesが空でも、前の独立資産を保護対象から落とさない。
  const later = { ...t.record, files: {} };
  await verifyTestArtifacts(t.config.cwd, [t.record, later]);
  await writeFile(join(t.config.cwd, asset), 'process.exit(0);\n');
  await assert.rejects(verifyTestArtifacts(t.config.cwd, [t.record, later]), /テスト成果物が変更/);
});

test('preparedTestsは通常設定へ持ち込まず参照形式も検査する', async () => {
  const t = await fixture();
  const { reviewTimeMs: _time, preparedTests: _refs, ...review } = t.config;
  const normal = { ...review, repair: ['unused-repair'] };
  expect(() => assertConfig(normal)).not.toThrow();
  expect(() => assertConfig({ ...normal, preparedTests: [t.ref] })).toThrow(
    'Unknown configuration field',
  );
  expect(() => assertProbeConfig(t.config)).not.toThrow();
  for (const ref of [
    { path: 'relative.json', sha256: t.ref.sha256 },
    { path: t.ref.path, sha256: 'bad' },
  ]) {
    expect(() => assertProbeConfig({ ...t.config, preparedTests: [ref] })).toThrow();
  }
});
