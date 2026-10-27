import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, expect } from 'bun:test';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshot } from '../../../implement/correction.ts';
import { object } from '../../support/correction.ts';
import { git } from '../../support/target.ts';
import { formalTree } from '../../support/formal-host-return.ts';
import { localPublicationFixture } from '../../support/local-publication.ts';

type Fixture = Awaited<ReturnType<typeof localPublicationFixture>>;
function scenario(
  name: string,
  run: (f: Fixture) => Promise<void>,
  publicBranch?: string,
  interruptedHistory = false,
) {
  test(`単独公開採用 ${name}`, async () => {
    const f = await localPublicationFixture(publicBranch, interruptedHistory);
    try {
      await run(f);
    } finally {
      await f.dispose();
    }
  }, 60000);
}
async function saved(f: Fixture, path: string) {
  return object(JSON.parse(await readFile(join(f.prior, path), 'utf8')));
}
async function change(f: Fixture, path: string, values: Record<string, unknown>) {
  await writeFile(join(f.prior, path), JSON.stringify({ ...(await saved(f, path)), ...values }));
}
async function unchanged(f: Fixture) {
  return { records: await formalTree(f.prior, true), source: await artifacts(f.checkout) };
}
async function artifacts(cwd: string) {
  const names = (await readdir(cwd)).filter((name) => name !== '.git').sort();
  return Promise.all(names.map(async (name) => [name, await formalTree(join(cwd, name))]));
}
async function jsonRecords(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const texts = await Promise.all(
    entries
      .filter((entry) => entry.name !== '.git')
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          return jsonRecords(path);
        }
        return entry.isFile() && entry.name.endsWith('.json') ? readFile(path, 'utf8') : '';
      }),
  );
  return texts.join('\n');
}
async function rejected(f: Fixture, reason: RegExp) {
  const before = await unchanged(f);
  const source = await artifacts(f.published);
  const result = await f.cli(f.args);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, reason);
  // 構文未接続や環境障害を個別の拒否条件の検出と取り違えない。
  assert.doesNotMatch(
    result.stderr,
    /Unknown option|Cannot find|ENOENT|SyntaxError|ReferenceError/,
  );
  expect((await f.observations()).filter((call) => call.role !== 'github')).toEqual([]);
  expect(
    (await f.observations()).some(
      (call) =>
        Array.isArray(call.argv) && ['create', 'edit', 'ready'].includes(String(call.argv[2])),
    ),
  ).toBe(false);
  expect(await unchanged(f)).toEqual(before);
  expect(await artifacts(f.published)).toEqual(source);
}

scenario(
  '異なる公開branchのfixtureは旧runを保全し内容・全modeとcommit収録を満たす',
  async (f) => {
    const original = await saved(f, 'result.json');
    expect(original).toMatchObject({
      status: 'verified_local',
      terminal: true,
      localOnly: true,
      publication: 'not_attempted',
    });
    const originalBranch = git(f.checkout, 'branch', '--show-current');
    expect(original.branch).toBe(originalBranch);
    expect(originalBranch).not.toBe(f.pr.headRefName);
    expect(git(f.published, 'branch', '--show-current')).toBe(f.pr.headRefName);
    expect(git(f.published, 'rev-parse', 'HEAD')).toBe(f.pr.headRefOid);
    expect(await artifacts(f.published)).toEqual(await artifacts(f.checkout));
    expect(git(f.published, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(f.published, 'show', 'HEAD:deliverable.txt')).toBe('accepted deliverable');
    expect(await saved(f, 'verification/state.json')).toMatchObject({
      checks: 1,
      review: 1,
      active: null,
      result: 'ready_for_human_review',
    });
    expect(await f.observations()).toEqual([]);
  },
  'codex/standalone-publication',
);

scenario('真正なローカル受入と単独公開treeを生成する正常対照', async (f) => {
  expect(await saved(f, 'result.json')).toMatchObject({
    status: 'verified_local',
    terminal: true,
    localOnly: true,
    publication: 'not_attempted',
  });
  expect(await saved(f, 'verification/state.json')).toMatchObject({
    checks: 1,
    review: 1,
    active: null,
    result: 'ready_for_human_review',
  });
  expect(git(f.published, 'show', 'HEAD:deliverable.txt')).toBe('accepted deliverable');
  expect(await artifacts(f.published)).toEqual(await artifacts(f.checkout));
  const before = await unchanged(f);
  const result = await f.cli([
    '99',
    '--repo',
    f.checkout,
    '--previous-run',
    f.prior,
    '--request-file',
    f.request,
    '--run-dir',
    f.dir,
    '--no-publish',
  ]);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /Previous publication is incomplete or unconfirmed/);
  expect(await unchanged(f)).toEqual(before);
});

async function acceptedPublication(f: Fixture) {
  const originalBranch = git(f.checkout, 'branch', '--show-current');
  expect(git(f.published, 'branch', '--show-current')).toBe(f.pr.headRefName);
  expect(await artifacts(f.published)).toEqual(await artifacts(f.checkout));
  const before = await unchanged(f);
  const result = await f.cli(f.args);
  assert.equal(result.code, 0, result.stderr);
  expect(object(JSON.parse(result.stdout))).toMatchObject({
    status: 'published_draft',
    publication: 'published',
    url: f.pr.url,
    branch: f.pr.headRefName,
  });
  const calls = await f.observations();
  const actors = calls.filter((call) => ['test', 'repair', 'review'].includes(String(call.role)));
  expect(actors.map((call) => call.role)).toEqual(['test', 'repair', 'review']);
  const independent = actors.find((call) => call.role === 'test');
  const testInput = object(
    JSON.parse(String(independent?.prompt).split('入力: ')[1]?.split('\n')[0] ?? ''),
  );
  expect(testInput.stage).toBe('revision');
  expect(calls.some((call) => call.role === 'check')).toBe(true);
  const repair = actors.find((call) => call.role === 'repair');
  expect(repair?.cwd).toBe(f.published);
  expect(String(repair?.prompt)).toContain(await readFile(f.request, 'utf8'));
  expect(await readFile(join(f.published, 'revision.txt'), 'utf8')).toBe('new correction');
  expect(calls.filter((call) => call.role === 'push')).toHaveLength(1);
  const push = calls.find((call) => call.role === 'push');
  assert(Array.isArray(push?.argv));
  expect(push.argv.at(-1)).toBe(
    `${git(f.published, 'rev-parse', 'HEAD')}:refs/heads/${f.pr.headRefName}`,
  );
  expect(calls.findIndex((call) => call.role === 'push')).toBeGreaterThan(
    calls.findIndex((call) => call.role === 'review'),
  );
  const mutations = calls.filter(
    (call) =>
      Array.isArray(call.argv) &&
      call.argv[0] === 'gh' &&
      ['create', 'edit', 'ready'].includes(String(call.argv[2])),
  );
  expect(mutations.length).toBeGreaterThan(0);
  for (const call of mutations) {
    expect(call.argv).toContain('edit');
    expect(call.argv).toContain(f.pr.url);
    expect(calls.indexOf(call)).toBeGreaterThan(
      calls.findIndex((entry) => entry.role === 'review'),
    );
  }
  // 新来歴の形式名は固定しない。両checkoutと原本の内容hashへの参照を観測する。
  const config = await readFile(join(f.dir, 'verification-config.json'), 'utf8');
  expect(config).toContain(f.prior);
  expect(config).toContain(f.checkout);
  expect(config).toContain(f.published);
  expect(config).toContain(f.pr.url);
  const configuration = object(JSON.parse(config));
  expect(configuration.baseCommit).toBe(f.base);
  expect(configuration.reports).toEqual([{ path: f.report, blob: f.blob }]);
  expect(git(f.published, 'rev-parse', `HEAD:${f.report}`)).not.toBe(f.blob);
  const provenance = await jsonRecords(f.dir);
  for (const path of ['result.json', 'verification/state.json']) {
    expect(provenance).toContain(
      createHash('sha256')
        .update(await readFile(join(f.prior, path)))
        .digest('hex'),
    );
  }
  expect(await unchanged(f)).toEqual(before);
  expect(git(f.checkout, 'branch', '--show-current')).toBe(originalBranch);
  expect(git(f.published, 'branch', '--show-current')).toBe(f.pr.headRefName);
}

scenario('新しい修正・独立テスト・check・評価を経て同じdraft PRを更新する', acceptedPublication);
scenario(
  '旧branchと異なる公開branchを新しい修正と公開で維持する',
  async (f) => {
    expect(git(f.checkout, 'branch', '--show-current')).not.toBe(f.pr.headRefName);
    await acceptedPublication(f);
  },
  'codex/standalone-publication',
);
scenario(
  '旧branchと公開branchが異なっても公開checkoutとPRのbranch不一致は拒否する',
  async (f) => {
    const originalBranch = git(f.checkout, 'branch', '--show-current');
    expect(originalBranch).not.toBe(f.pr.headRefName);
    git(f.published, 'checkout', '-b', 'codex/unrelated-publication');
    expect(await artifacts(f.published)).toEqual(await artifacts(f.checkout));
    await rejected(f, /branch|identity|対象/i);
    expect(git(f.checkout, 'branch', '--show-current')).toBe(originalBranch);
    expect(git(f.published, 'branch', '--show-current')).toBe('codex/unrelated-publication');
  },
  'codex/standalone-publication',
);

async function retainedHistory(f: Fixture) {
  const original = await readFile(join(f.initial, 'verification/state.json'), 'utf8');
  expect(object(JSON.parse(original))).toMatchObject({
    result: 'interrupted',
    review: 1,
    reviewHistory: [],
    active: { role: 'review' },
  });
  const config = await saved(f, 'verification-config.json');
  const interruption = object(object(config.reviewReturn).interruption);
  expect(interruption.state).toBe(original);
  expect(interruption.unknown).toBe('中断区間の時間・usageは未記録。累計は記録済み量の下限');
  const origin = object(JSON.parse(await readFile(join(f.initial, 'result.json'), 'utf8')));
  const accepted = await saved(f, 'result.json');
  const branch = git(f.checkout, 'branch', '--show-current');
  expect(origin.branch).toBe(branch);
  expect(accepted.branch).toBe(branch);
  expect(branch).not.toBe(f.pr.headRefName);
  expect(git(f.published, 'branch', '--show-current')).toBe(f.pr.headRefName);
  expect(await artifacts(f.published)).toEqual(await artifacts(f.checkout));
  expect(git(f.published, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(git(f.published, 'show', 'HEAD:deliverable.txt')).toBe('accepted deliverable');
  return formalTree(f.initial, true);
}

function historyScenario(name: string, run: (f: Fixture) => Promise<void>) {
  scenario(
    `中断復帰履歴と異なる公開branch ${name}`,
    async (f) => {
      const before = await retainedHistory(f);
      await run(f);
      expect(await formalTree(f.initial, true)).toEqual(before);
    },
    'codex/standalone-publication',
    true,
  );
}

historyScenario('fixtureの予約・不明量と両branchの対応を確認する', async (f) => {
  expect(await saved(f, 'result.json')).toMatchObject({
    status: 'verified_local',
    terminal: true,
    localOnly: true,
    publication: 'not_attempted',
  });
  expect(await f.observations()).toEqual([]);
});

historyScenario('旧履歴を変えず新しい修正・検証と同じPRの更新へ進む', acceptedPublication);

historyScenario('公開checkoutとPRのbranch不一致は拒否する', async (f) => {
  git(f.published, 'checkout', '-b', 'codex/unrelated-publication');
  await rejected(f, /branch|identity|対象/i);
  expect(git(f.published, 'branch', '--show-current')).toBe('codex/unrelated-publication');
});

historyScenario('旧checkoutのbranch不一致も公開先の一致で代用しない', async (f) => {
  git(f.checkout, 'checkout', '-b', 'codex/unrelated-origin');
  expect(await artifacts(f.published)).toEqual(await artifacts(f.checkout));
  await rejected(f, /branch|identity|source|対象|履歴/i);
  expect(git(f.checkout, 'branch', '--show-current')).toBe('codex/unrelated-origin');
});

for (const [name, path, values, reason] of [
  ['非終端', 'result.json', { terminal: false }, /terminal|終端/i],
  [
    '受入未了',
    'verification/state.json',
    { result: 'needs_changes' },
    /verification|受入|検証|accepted/i,
  ],
  ['check未実行', 'verification/state.json', { checks: 0 }, /check|検証/i],
  [
    'active予約',
    'verification/state.json',
    { active: { role: 'review', prefix: 'verification/review-2' } },
    /active|予約|unfinished|実行/i,
  ],
  ['設定原文', 'target.json', { text: '{}' }, /config|設定|target|対象/i],
  ['旧主体', 'target.json', { actor: 'another' }, /actor|主体|対象/i],
  ['公開済み偽装', 'result.json', { publication: 'published' }, /publication|公開|local|ローカル/i],
] as const) {
  scenario(`${name}の不一致では後続を起動しない`, async (f) => {
    await change(f, path, values);
    await rejected(f, reason);
  });
}

for (const [name, values, reason] of [
  ['作者', { author: { login: 'another' } }, /author|actor|作者|主体|identity/i],
  ['head', { headRefOid: 'a'.repeat(40) }, /head|commit|identity|対象/i],
  ['branch', { headRefName: 'other-branch' }, /branch|identity|対象/i],
  ['base', { baseRefName: 'other-base' }, /base|identity|対象/i],
  ['repo', { headRepositoryOwner: { login: 'another' } }, /repo|identity|対象/i],
  ['Issue', { body: 'Closes #98' }, /Issue|要求/i],
  ['CLOSED', { state: 'CLOSED' }, /open|state|PR|対象/i],
  ['ready', { isDraft: false }, /draft/i],
] as const) {
  scenario(`PRの${name}不一致では後続を起動しない`, async (f) => {
    await f.changeControl({ pr: { ...f.pr, ...values } });
    await rejected(f, reason);
  });
}

for (const [name, values, reason] of [
  ['remote ref', { remote: 'b'.repeat(40) }, /remote|ref|head|公開/i],
  ['実効主体', { actor: 'another' }, /actor|主体|対象|identity/i],
  ['書込権限', { denied: true }, /push|permission|権限/i],
  ['稼働プロセス', { live: true }, /process|プロセス|実行/i],
  ['プロセス観測不能', { unavailable: true }, /process|観測|observation|ps/i],
] as const) {
  scenario(`${name}は不一致・不明で停止する`, async (f) => {
    await f.changeControl(values);
    await rejected(f, reason);
  });
}

scenario('管理lockを取り除かずに停止する', async (f) => {
  await mkdir(join(f.prior, 'verification/lock'));
  await rejected(f, /lock|ロック/i);
});
scenario('成果物内容の変更を受入へ流用しない', async (f) => {
  await writeFile(join(f.published, 'deliverable.txt'), 'changed');
  await rejected(f, /source|artifact|成果物|内容|差分|変更|dirty/i);
});
scenario('Gitの実行bit以外のmode差も拒否する', async (f) => {
  await chmod(join(f.published, 'deliverable.txt'), 0o600);
  await rejected(f, /mode|source|artifact|成果物|モード|不一致|変更/i);
});
scenario('同じ未追跡成果物が両checkoutにあってもcommit収録なしは拒否する', async (f) => {
  git(f.published, 'rm', '--cached', 'deliverable.txt');
  git(f.published, 'commit', '-m', '合成公開treeから成果物を欠落させる');
  await f.changeControl({ pr: { ...f.pr, headRefOid: git(f.published, 'rev-parse', 'HEAD') } });
  expect(await artifacts(f.published)).toEqual(await artifacts(f.checkout));
  await rejected(f, /source|commit|tree|追跡|収録|成果物|変更/i);
});
scenario('公開許可を単独公開の事実から推測しない', async (f) => {
  f.args.splice(f.args.indexOf('--allow-publish'), 1);
  await rejected(f, /permission|authoriz|許可|権限/i);
});

scenario('独立評価acceptedの欠落は旧check成功で代用しない', async (f) => {
  await change(f, 'verification/state.json', { reviewHistory: [] });
  await rejected(f, /review|accepted|評価|受入/i);
});

scenario('原応答の改変は旧成功で代用しない', async (f) => {
  await writeFile(
    join(f.prior, 'implementation.stdout'),
    '{"status":"repaired","findings":"changed"}',
  );
  await rejected(f, /hash|原|record|actor|変更|不一致/i);
});

scenario('採用後の正式ホスト停止と復帰にも来歴を保持する', async (f) => {
  const before = await unchanged(f);
  await f.changeControl({ host: true });
  const stopped = await f.cli(f.args);
  assert.equal(stopped.code, 1, stopped.stderr);
  assert.match(stopped.stderr, /Host verification required|ホスト検証/i);
  const state = object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
  expect(state).toMatchObject({ terminal: true, publication: 'not_attempted' });
  expect(await unchanged(f)).toEqual(before);
  const stoppedRecords = await formalTree(f.dir);
  const previousCalls = await f.observations();
  const evidence = join(f.root, 'host.json');
  const log = join(f.root, 'host.stdout');
  const content = '合成ホスト検証の証拠。実サービスの受入ではありません。';
  await writeFile(log, content);
  await writeFile(
    evidence,
    JSON.stringify({
      status: 'passed',
      source: await snapshot(f.published),
      findings: '固定入力のホスト検証。',
      logs: [{ path: log, sha256: createHash('sha256').update(content).digest('hex') }],
    }),
  );
  await f.changeControl({ host: false });
  const next = join(f.root, 'host-return');
  const resumed = await f.cli([
    '99',
    '--repo',
    f.published,
    '--host-run',
    f.dir,
    '--host-evidence',
    evidence,
    '--run-dir',
    next,
    '--no-publish',
  ]);
  assert.equal(resumed.code, 0, resumed.stderr);
  const roles = (await f.observations())
    .slice(previousCalls.length)
    .filter((call) => call.role !== 'github')
    .map((call) => call.role);
  expect(roles).toEqual(['test', 'check', 'review']);
  expect(await readFile(join(next, 'verification-config.json'), 'utf8')).toContain(f.prior);
  expect(await unchanged(f)).toEqual(before);
  expect(await formalTree(f.dir)).toEqual(stoppedRecords);
});

scenario('採用拒否後に別名の通常起動で修正を開始しない', async (f) => {
  await f.changeControl({ pr: { ...f.pr, isDraft: false } });
  await rejected(f, /draft/i);
  const result = await f.cli(['99', '--repo', f.published, '--run-dir', join(f.root, 'bypass')]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /PR|停止|照合|既存|previous|publication/i);
  expect((await f.observations()).filter((call) => call.role !== 'github')).toEqual([]);
});
