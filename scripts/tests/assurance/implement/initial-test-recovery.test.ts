import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { command } from '../../../shared/process.ts';
import { develop } from '../../../implement/orchestrator.ts';
import { runtimeShape } from '../../../implement/actor-runtime.ts';
import { snapshot } from '../../../implement/correction.ts';
import { verifyInterruptedProcesses } from '../../../implement/interrupted-processes.ts';
import { gitOutput, issue, ok } from '../../support/development.ts';
import type { DevelopmentFixture } from '../../support/development.ts';
import { oldTestActor } from '../../support/initial-test-records.ts';
import { fixedHostGenerator } from '../../support/fixed-host-generator.ts';
import { nativeActorEnvironment } from '../../support/native-actor.ts';
import publicContract from '../../fixtures/human-decision-recovery/public-contract.json';
import { object, reviewReplySource } from '../../support/correction.ts';
import {
  recoveryCli,
  testReviewRecovery as testDevelopment,
} from '../../support/review-recovery.ts';

// 入力の合意済みIssue（2026-10-22T06:51:09Z）が期待値の根拠。
// 公開入口は--test-run。固定した旧形式の--test-interrupted-runとは区別する。
async function preserved(
  dir: string,
  excluded: string[] = [],
): Promise<Record<string, { mode: number; content: string }>> {
  const result: Record<string, { mode: number; content: string }> = {};
  for (const entry of await readdir(dir)) {
    if (excluded.includes(entry)) {
      continue;
    }
    const path = join(dir, entry);
    const info = await lstat(path);
    const content = info.isDirectory()
      ? ''
      : info.isSymbolicLink()
        ? await readlink(path)
        : createHash('sha256')
            .update(await readFile(path))
            .digest('hex');
    result[path] = { mode: info.mode, content };
    if (info.isDirectory()) {
      Object.assign(result, await preserved(path));
    }
  }
  return result;
}

async function actorRoles(path: string) {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((role) => role && !role.startsWith('observe-'));
}

async function fixture(f: DevelopmentFixture, stop = 'mismatch', nestedDependency = false) {
  // 旧停止の形を新しいconsumerの保存方法に依存させない。
  const generator = await fixedHostGenerator(dirname(f.dir));
  const { develop: generate } = z
    .object({ develop: z.custom<typeof develop>((value) => typeof value === 'function') })
    .parse(await import(join(generator, 'scripts/implement/orchestrator.ts')));
  f.args.push('--no-publish');
  const script = join(dirname(f.dir), 'initial-test-actors.js');
  const control = join(dirname(f.dir), 'initial-test-control.json');
  const executions = join(dirname(f.dir), 'initial-test-executions.txt');
  await writeFile(executions, '');
  await writeFile(control, JSON.stringify({ response: 'unnecessary' }));
  await writeFile(
    script,
    `import {readFileSync,writeFileSync,appendFileSync,existsSync,chmodSync} from 'node:fs';
const role=process.argv[2];
const actorPrompt=['test','repair','review'].includes(role)?readFileSync(0,'utf8'):'';
${reviewReplySource.replaceAll("readFileSync(0,'utf8')", 'actorPrompt')}
const control=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
appendFileSync(${JSON.stringify(executions)},role+'\\n');
function change() {
 if(control.changeRole && control.changeRole!==role) return;
 if(control.change) {
  if(control.change.mode!==undefined) chmodSync(control.change.path,control.change.mode);
  else writeFileSync(control.change.path,control.change.content);
 }
 if(control.activate) writeFileSync(${JSON.stringify(control)},JSON.stringify({...control,observation:'live'}));
}
if(['test','repair','review'].includes(role)) writeFileSync(${JSON.stringify(join(dirname(f.dir), 'initial-return-'))}+role+'.prompt',actorPrompt);
if(role==='test') {
 change();
 const prompt=actorPrompt;
 writeFileSync(${JSON.stringify(join(dirname(f.dir), 'fresh-test.prompt'))},prompt);
 const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);
 if(input.stage!=='host_return'||readFileSync('result.txt','utf8')!=='old'||existsSync('pending.test.js')) throw Error('固定した修正前入力・復帰段階が必要');
 if(control.response==='prepared') writeFileSync('fresh.test.js','process.exit(0);\\n');
 console.log(JSON.stringify({targetId:control.response==='mismatch'?input.targetId.slice(0,52):input.targetId,status:control.response==='prepared'?'prepared':control.response==='needs_host'?'needs_host':control.response==='needs_human'?'needs_human':'unnecessary',findings:'新しい独立判断',files:control.response==='prepared'?['fresh.test.js']:[]}));
}
if(role==='repair') {
 change();
 if(existsSync('pending.test.js')) throw Error('未採用成果物を転送できない');
 if(control.response==='prepared'&&!existsSync('fresh.test.js')) throw Error('新しい成果物の転送が必要');
 writeFileSync('result.txt','implemented');
 console.log(JSON.stringify({status:control.implementationHost?'needs_host':'repaired',findings:'合意したresult値を保存'}));
}
if(role==='check'&&(readFileSync('result.txt','utf8')!=='implemented'||readFileSync('setup.txt','utf8')!=='configured')) process.exit(1);
if(role==='review') console.log(JSON.stringify(reviewReply('accepted','模擬評価。実サービス未確認。')));
`,
  );
  f.settings.check = [process.execPath, script, 'check'];
  if (nestedDependency) {
    // #425の正常な依存物。停止後に追加せず、元の開始版と保存manifestへ含める。
    await mkdir(join(f.repo, 'evaluation'));
    await writeFile(
      join(f.repo, 'evaluation/pyproject.toml'),
      '[project]\nname = "recovery-fixture"\nversion = "0.1.0"\ndependencies = ["fixture-dependency==1.0.0"]\n',
    );
    await writeFile(
      join(f.repo, 'evaluation/uv.lock'),
      'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n\n[[package]]\nname = "fixture-dependency"\nversion = "1.0.0"\nsource = { registry = "https://example.invalid/simple" }\n',
    );
    await gitOutput(f.repo, 'add', 'evaluation');
  }
  await writeFile(join(f.repo, '.dotagents.json'), JSON.stringify(f.settings));
  await gitOutput(f.repo, 'add', '.dotagents.json');
  await gitOutput(f.repo, 'commit', '-m', '初回テスト停止の模擬契約');
  const pending = stop === 'needs_host' || stop === 'mismatch_artifact';
  const status = stop === 'needs_host' ? 'needs_host' : pending ? 'prepared' : 'unnecessary';
  const code = stop === 'command' ? 7 : 0;
  f.test = async (_argv, cwd, prompt, _timeout, prefix) => {
    const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
    assert(typeof input.targetId === 'string' && prefix);
    if (pending) {
      await writeFile(join(cwd, 'pending.test.js'), 'process.exit(1);\n', { mode: 0o755 });
    }
    const stdout =
      stop === 'json'
        ? '{broken'
        : JSON.stringify({
            targetId: stop.startsWith('mismatch') ? input.targetId.slice(0, 52) : input.targetId,
            status,
            findings: '旧担当の未採用判断',
            files: pending ? ['pending.test.js'] : [],
          });
    const raw = stop === 'json' ? { stdout } : await oldTestActor(f.dir, stdout);
    await writeFile(`${prefix}.stdout`, raw.stdout);
    await writeFile(`${prefix}.stderr`, '');
    return { ...ok(raw.stdout), code };
  };
  if (stop === 'valid_test') {
    f.implement = async () => {
      throw Error('fixture: 有効なテスト判断後の実装停止');
    };
  }
  await assert.rejects(
    () =>
      generate(f.args, {
        ...f.io,
        command: async (...args) => {
          const [argv, cwd, input, timeout, prefix] = args;
          if (
            argv[1] !== join(generator, 'scripts/implement/codex-actor.ts') ||
            argv[2] !== 'repair'
          ) {
            return f.io.command(argv, cwd, input, timeout, prefix);
          }
          expect(argv[0]).toBe(process.execPath);
          expect(timeout).toBeNull();
          expect(input).toContain('Show the requested result.');
          f.calls.implementations++;
          return f.implement(argv, cwd, input, timeout, prefix);
        },
      }),
    (error) => {
      if (stop === 'valid_test') {
        expect(String(error)).toMatch(/fixture: 有効なテスト判断後の実装停止/);
      }
      return true;
    },
  );
  if (stop.startsWith('mismatch')) {
    const saved = object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
    expect(saved.reason).toMatch(/テスト応答の入力が一致しません/);
    // 初回実装前の実際の停止には検証設定がまだない。旧runを補修しない。
    expect(await Bun.file(join(f.dir, 'verification-config.json')).exists()).toBe(false);
  }
  expect(f.calls.implementations).toBe(stop === 'valid_test' ? 1 : 0);
  expect(f.calls.verificationEntries).toBe(0);
  expect(f.calls.publications).toBe(0);
  const cwd = join(f.dir, 'checkout');
  const dir = join(dirname(f.dir), 'initial-test-return');
  const actors = {
    test: [process.execPath, script, 'test'],
    repair: [process.execPath, script, 'repair'],
    review: [process.execPath, script, 'review'],
    issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(issue)})`],
  };
  return {
    cwd,
    dir,
    args: ['99', '--repo', cwd, '--test-run', f.dir, '--run-dir', dir, '--no-publish'],
    script,
    control,
    executions,
    actors,
  };
}

async function invoke(f: DevelopmentFixture, t: Awaited<ReturnType<typeof fixture>>) {
  return recoveryCli(f, t, {}, { observe: true, allowImplementation: true });
}

// #432の採用済み受付条件は保存入力のstageと終端結果で決まり、hostReturn履歴を要求しない。
// #425の未実行実装は、新しい有効な独立判断の後にだけ実行する。
for (const scenario of ['normal', 'nested_dependency'] as const) {
  testDevelopment(
    `初回ID不一致の復帰で止まった判断待ちは補足合意から未実行の初回実装へ進む: ${scenario}`,
    async (f) => {
      const t = await fixture(f, 'mismatch', scenario === 'nested_dependency');
      const origin = await preserved(f.dir);
      const actorEnvironment = await nativeActorEnvironment(dirname(f.dir), t.actors);
      await writeFile(t.control, JSON.stringify({ response: 'needs_human' }));
      const stopped = await recoveryCli(
        f,
        t,
        {},
        {
          observe: true,
          allowImplementation: true,
          actorEnvironment,
        },
      );
      assert.equal(stopped.code, 1, stopped.stderr);
      expect(stopped.timedOut).toBe(false);
      expect(stopped.stderr).toMatch(/human_decision_required/);
      expect(await actorRoles(t.executions)).toEqual(['test']);
      const saved = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
      expect(saved).toMatchObject({
        terminal: true,
        reasonCode: 'human_decision_required',
        operation: 'independent test authoring',
        publication: 'not_attempted',
      });
      const input = object(JSON.parse(await readFile(join(t.dir, 'test-1.target.json'), 'utf8')));
      expect(input.stage).toBe('host_return');
      expect(
        object(JSON.parse(await readFile(join(t.dir, 'test-1.stdout'), 'utf8'))),
      ).toMatchObject({
        targetId: input.targetId,
        status: 'needs_human',
        files: [],
      });
      expect(
        object(JSON.parse(await readFile(join(t.dir, 'test-1.execution.json'), 'utf8'))),
      ).toMatchObject({ code: 0, timedOut: false });
      const config = object(
        JSON.parse(await readFile(join(t.dir, 'verification-config.json'), 'utf8')),
      );
      expect(config.initialTestReturn).toBeDefined();
      expect(config.hostReturn).toBeUndefined();
      assert(typeof saved.checkout === 'string');
      expect(await readFile(join(saved.checkout, 'result.txt'), 'utf8')).toBe('old');
      if (scenario === 'nested_dependency') {
        const dependency = await readFile(join(f.repo, 'evaluation/uv.lock'), 'utf8');
        for (const cwd of [saved.checkout, join(t.dir, 'test-1-workspace')]) {
          expect(await gitOutput(cwd, 'show', 'HEAD:evaluation/uv.lock')).toBe(dependency.trim());
          expect(await readFile(join(cwd, 'evaluation/uv.lock'), 'utf8')).toBe(dependency);
          expect((await lstat(join(cwd, 'evaluation/uv.lock'))).mode).toBe(
            (await lstat(join(f.repo, 'evaluation/uv.lock'))).mode,
          );
        }
      }
      const prior = await preserved(t.dir, ['checkout']);
      const file = join(dirname(f.dir), 'initial-return-supplement.json');
      const agreement = {
        format: 1,
        issue: `https://github.com/${f.settings.repository}/issues/99`,
        issueUpdatedAt: '1',
        issueSha256: createHash('sha256').update(issue).digest('hex'),
        source: '人が採用した模擬補足合意: initial-return-425',
        content: 'ADOPTED_INITIAL_RETURN: 固定baselineで新独立判断後、未実行の初回実装へ進む。',
        decision: '対象Issueの版1にこの模擬補足を適用する。',
      };
      expect(Object.keys(agreement).sort()).toEqual(
        Object.keys(publicContract.supplementWire).sort(),
      );
      await writeFile(file, JSON.stringify(agreement));
      const dir = join(dirname(f.dir), 'initial-human-return');
      const values: Record<string, string> = {
        ISSUE_NUMBER: '99',
        CURRENT_CHECKOUT: saved.checkout,
        LATEST_ELIGIBLE_STOP: t.dir,
        EXTERNAL_REGULAR_SUPPLEMENT_JSON: file,
        UNUSED_SIBLING_RUN: dir,
      };
      const args = publicContract.argvShape.slice(2).map((value) => values[value] ?? value);
      await writeFile(t.control, JSON.stringify({ response: 'unnecessary' }));
      const result = await recoveryCli(
        f,
        { ...t, cwd: saved.checkout, dir, args },
        {},
        {
          observe: true,
          allowImplementation: true,
          actorEnvironment,
        },
      );
      expect(result.timedOut).toBe(false);
      assert.equal(result.code, 0, result.stderr);
      expect(await actorRoles(t.executions)).toEqual(['test', 'test', 'repair', 'check', 'review']);
      for (const role of ['test', 'repair', 'review']) {
        const prompt = await readFile(
          join(dirname(f.dir), `initial-return-${role}.prompt`),
          'utf8',
        );
        for (const value of [agreement.content, agreement.source, agreement.decision]) {
          expect(prompt).toContain(value);
        }
        expect(prompt).not.toContain('旧担当の未採用判断');
      }
      const fresh = object(JSON.parse(await readFile(join(dir, 'test-1.target.json'), 'utf8')));
      expect(fresh).toMatchObject({ stage: 'host_return', baseCommit: input.baseCommit });
      const completed = object(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')));
      expect(completed).toMatchObject({
        status: 'verified_local',
        publication: 'not_attempted',
      });
      assert(typeof completed.checkout === 'string');
      expect(await readFile(join(completed.checkout, 'result.txt'), 'utf8')).toBe('implemented');
      expect(await preserved(t.dir, ['checkout'])).toEqual(prior);
      expect(await preserved(f.dir)).toEqual(origin);
    },
  );
}

// 復帰入口の成否とは別に、元の停止と依存物を保存できることを確認する正常対照。
testDevelopment(
  '有効な初回テスト判断の保存fixtureは実装に到達して指定した理由で停止する',
  async (f) => {
    await fixture(f, 'valid_test');
  },
);

testDevelopment(
  '初回ID不一致の保存fixtureは設定未作成と追跡済みの入れ子依存物を保つ',
  async (f) => {
    await fixture(f, 'mismatch', true);
    const content = await readFile(join(f.repo, 'evaluation/uv.lock'), 'utf8');
    for (const container of ['checkout', 'test-baseline', 'test-1-workspace']) {
      const cwd = join(f.dir, container);
      expect(await gitOutput(cwd, 'show', 'HEAD:evaluation/uv.lock')).toBe(content.trim());
      expect(await readFile(join(cwd, 'evaluation/uv.lock'), 'utf8')).toBe(content);
      expect((await lstat(join(cwd, 'evaluation/uv.lock'))).isFile()).toBe(true);
    }
  },
);

for (const scenario of ['unnecessary', 'prepared', 'nested_dependency'] as const) {
  testDevelopment(
    `初回テストID不一致から新しい判断と未実行実装へ進み旧runを保全する: ${scenario}`,
    async (f) => {
      const response = scenario === 'prepared' ? 'prepared' : 'unnecessary';
      const t = await fixture(
        f,
        response === 'prepared' ? 'mismatch_artifact' : 'mismatch',
        scenario === 'nested_dependency',
      );
      const original = await preserved(f.dir);
      const head = await gitOutput(t.cwd, 'rev-parse', 'HEAD');
      const branch = await gitOutput(t.cwd, 'branch', '--show-current');
      await writeFile(t.control, JSON.stringify({ response }));
      const result = await invoke(f, t);
      expect(result.timedOut).toBe(false);
      assert.equal(result.code, 0, result.stderr);
      expect(result.stderr).not.toMatch(/Unknown option|SyntaxError|TypeError|ReferenceError/);
      expect(
        (await readFile(t.executions, 'utf8'))
          .split('\n')
          .filter((role) => !role.startsWith('observe-') && role),
      ).toEqual(['test', 'repair', 'check', 'review']);
      const prompt = await readFile(join(dirname(f.dir), 'fresh-test.prompt'), 'utf8');
      expect(prompt).toContain('Show the requested result.');
      expect(prompt).not.toContain('旧担当の未採用判断');
      expect(prompt).not.toContain('旧担当の診断');
      const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
      expect(input).toMatchObject({ stage: 'host_return', baseCommit: head });
      expect(await preserved(f.dir)).toEqual(original);
      expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD')).toBe(head);
      expect(await gitOutput(t.cwd, 'branch', '--show-current')).toBe(branch);
      const saved = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
      expect(saved).toMatchObject({ status: 'verified_local', publication: 'not_attempted' });
      assert(typeof saved.checkout === 'string');
      expect(await readFile(join(saved.checkout, 'result.txt'), 'utf8')).toBe('implemented');
    },
  );
}

const defects = [
  'raw',
  'missing_raw',
  'execution',
  'prompt',
  'workspace_artifact',
  'input',
  'manifest',
  'baseline',
  'artifact',
  'mode',
  'head',
  'branch',
  'settings',
  'issue',
  'actor',
  'published',
  'uncertain',
  'lock',
  'process',
  'process_normal_host',
  'process_return_impostor',
  'process_unknown',
  'remote',
  'remote_unknown',
  'closed_pr',
  'github_unknown',
] as const;
for (const defect of defects) {
  testDevelopment(`初回テスト復帰は不一致・照合不能で後続を起動しない: ${defect}`, async (f) => {
    const t = await fixture(f);
    const patch = async (name: string, values: Record<string, unknown>) => {
      const path = join(f.dir, name);
      await writeFile(
        path,
        JSON.stringify({ ...object(JSON.parse(await readFile(path, 'utf8'))), ...values }),
      );
    };
    const operations: Record<typeof defect, () => Promise<unknown>> = {
      raw: () => writeFile(join(f.dir, 'test-1.stdout'), '{}'),
      missing_raw: () => rm(join(f.dir, 'test-1.stdout')),
      execution: () => patch('test-1.execution.json', { code: 7 }),
      prompt: () => writeFile(join(f.dir, 'test-1.prompt'), 'changed prompt'),
      workspace_artifact: () =>
        writeFile(join(f.dir, 'test-1-workspace/pending.test.js'), 'changed'),
      input: () => writeFile(join(f.dir, 'test-1.target.json'), '{}'),
      manifest: () => rm(join(f.dir, 'test-baseline.json')),
      baseline: () => writeFile(join(f.dir, 'test-baseline/result.txt'), 'changed'),
      artifact: () => writeFile(join(t.cwd, 'result.txt'), 'changed'),
      mode: () => chmod(join(t.cwd, 'result.txt'), 0o755),
      head: () => gitOutput(t.cwd, 'commit', '--allow-empty', '-m', 'changed HEAD'),
      branch: () => gitOutput(t.cwd, 'checkout', '-b', 'another-branch'),
      settings: () =>
        writeFile(
          join(t.cwd, '.dotagents.json'),
          JSON.stringify({ ...f.settings, remote: 'changed' }),
        ),
      issue: async () => {},
      actor: () => patch('target.json', { actor: 'another-operator' }),
      published: () => patch('result.json', { publication: 'published' }),
      uncertain: () => patch('result.json', { publication: 'unconfirmed' }),
      lock: () => mkdir(join(f.dir, 'verification/lock'), { recursive: true }),
      process: () => writeFile(t.control, JSON.stringify({ observation: 'live' })),
      process_normal_host: () =>
        writeFile(t.control, JSON.stringify({ observation: 'normal_host' })),
      process_return_impostor: () =>
        writeFile(t.control, JSON.stringify({ observation: 'return_impostor' })),
      process_unknown: () =>
        writeFile(t.control, JSON.stringify({ observation: 'process_failed' })),
      remote: () => writeFile(t.control, JSON.stringify({ observation: 'remote_present' })),
      remote_unknown: () => writeFile(t.control, JSON.stringify({ observation: 'remote_failed' })),
      closed_pr: () => writeFile(t.control, JSON.stringify({ observation: 'closed_pr' })),
      github_unknown: () => writeFile(t.control, JSON.stringify({ observation: 'github_failed' })),
    };
    await operations[defect]();
    const original = await preserved(f.dir);
    const result =
      defect === 'issue'
        ? await recoveryCli(
            f,
            t,
            { issue: JSON.stringify({ ...object(JSON.parse(issue)), body: 'Changed Issue' }) },
            { observe: true, allowImplementation: true },
          )
        : await invoke(f, t);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    // 入口未接続や実行時のバグを、照合による拒否の成功に数えない。
    expect(result.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(await preserved(f.dir)).toEqual(original);
    expect(
      (await readFile(t.executions, 'utf8'))
        .split('\n')
        .filter((role) => !role.startsWith('observe-') && role),
    ).toEqual([]);
  });
}

// CLI未実装による遮断と区別して、実際のpid/ppid/lstart/command入力境界へ到達する。
for (const observation of [
  'unrelated',
  'unrelated_actor',
  'self_return',
  'old_path',
  'normal_host',
  'return_impostor',
  'different_issue_quoted',
  'different_issue_host',
  'different_issue_review',
  'different_issue_old_path',
] as const) {
  testDevelopment(`プロセス観測の独立判定: ${observation}`, async (f) => {
    const t = await fixture(f);
    const differentIssue = observation.startsWith('different_issue_');
    const saved = object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
    assert(typeof saved.startedAt === 'string' && typeof saved.finishedAt === 'string');
    const start = new Date(
      observation === 'return_impostor' || observation === 'self_return'
        ? Date.parse(saved.finishedAt)
        : Date.parse(saved.startedAt) - 60000,
    );
    const parts = start.toString().split(' ');
    const lstart = `${parts[0]} ${parts[1]} ${parts[2]} ${parts[4]} ${parts[3]}`;
    const host = join(dirname(f.repo), 'shared-harness/scripts/implement/development.ts');
    const other = join(dirname(f.dir), 'unrelated run');
    if (differentIssue) {
      await mkdir(join(other, 'checkout'), { recursive: true });
      await gitOutput(join(other, 'checkout'), 'init');
    }
    const otherHost = [
      process.execPath,
      '--preload',
      join(other, 'preload.ts'),
      host,
      '99',
      '--repo',
      join(other, 'checkout'),
    ];
    const otherReturn = [
      ...otherHost,
      '--host-run',
      join(other, 'stopped'),
      '--host-evidence',
      join(other, 'evidence.json'),
      '--run-dir',
      join(other, 'return'),
      '--no-publish',
    ];
    const commands = {
      unrelated: ['/usr/bin/unrelated-fixture'],
      unrelated_actor: [process.execPath, '/unrelated-fixture/task.ts'],
      self_return: [process.execPath, host, ...t.args],
      old_path: [
        process.execPath,
        `${f.dir}/checkout/scripts/implement/development.ts`,
        '99',
        '--no-publish',
      ],
      normal_host: [process.execPath, host, '99', '--repo', f.repo, '--no-publish'],
      return_impostor: [process.execPath, host, ...t.args],
      different_issue_quoted: otherReturn,
      different_issue_host: otherReturn,
      different_issue_review: [
        ...otherHost,
        '--review-run',
        join(other, 'stopped'),
        '--run-dir',
        join(other, 'return'),
        '--no-publish',
      ],
      different_issue_old_path: [...otherReturn, '--test-interrupted-run', f.dir],
    };
    const input = {
      previousRun: f.dir,
      runDirectory: t.dir,
      review: [process.execPath, t.script, 'review', f.dir],
      entry: differentIssue ? ('--test-interrupted-run' as const) : ('--test-run' as const),
      host: {
        cwd: f.repo,
        common: await gitOutput(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
        repository: f.settings.repository,
        issue: differentIssue ? '54' : '99',
      },
      commonDirectory: (cwd: string) =>
        gitOutput(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    };
    const original = await preserved(f.dir);
    const pid = observation === 'self_return' ? process.pid : 424242;
    const ppid = observation === 'self_return' ? process.ppid : 1;
    const command = commands[observation]
      .map((arg) =>
        /\s/.test(arg) &&
        observation !== 'different_issue_host' &&
        observation !== 'different_issue_review'
          ? JSON.stringify(arg)
          : arg,
      )
      .join(' ');
    const observed = `${pid} ${ppid} ${differentIssue ? '' : `${lstart} `}${command}\n`;
    const verify = () => verifyInterruptedProcesses(observed, input);
    if (
      observation === 'unrelated' ||
      observation === 'unrelated_actor' ||
      observation === 'self_return' ||
      observation === 'different_issue_quoted' ||
      observation === 'different_issue_host' ||
      observation === 'different_issue_review'
    ) {
      await verify();
    } else {
      await assert.rejects(verify, /プロセス|process/i);
    }
    expect(await preserved(f.dir)).toEqual(original);
    expect(await actorRoles(t.executions)).toEqual([]);
  });
}

for (const stop of ['json', 'command', 'needs_host', 'valid_test']) {
  testDevelopment(`別の停止理由を初回ID不一致の復帰へ流用しない: ${stop}`, async (f) => {
    const t = await fixture(f, stop);
    const original = await preserved(f.dir);
    const result = await invoke(f, t);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(await preserved(f.dir)).toEqual(original);
    expect(await actorRoles(t.executions)).toEqual([]);
  });
}

for (const response of ['mismatch', 'needs_host']) {
  testDevelopment(
    `新しいテスト判断が有効になるまで初回実装を起動しない: ${response}`,
    async (f) => {
      const t = await fixture(f);
      const original = await preserved(f.dir);
      await writeFile(t.control, JSON.stringify({ response }));
      const result = await invoke(f, t);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toMatch(
        /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
      );
      const roles = (await readFile(t.executions, 'utf8'))
        .split('\n')
        .filter((role) => !role.startsWith('observe-') && role);
      expect(roles).toEqual(['test']);
      expect(await preserved(f.dir)).toEqual(original);
      const again = {
        ...t,
        args: t.args.map((value) =>
          value === f.dir ? t.dir : value === t.dir ? `${t.dir}-again` : value,
        ),
      };
      const repeated = await invoke(f, again);
      expect(repeated.code).toBe(1);
      expect(await readFile(t.executions, 'utf8')).not.toContain('repair');
    },
  );
}

async function hostReturn(
  f: DevelopmentFixture,
  t: Awaited<ReturnType<typeof fixture>>,
  previousRun: string,
  name: string,
) {
  const cwd = object(JSON.parse(await readFile(join(previousRun, 'result.json'), 'utf8'))).checkout;
  assert(typeof cwd === 'string');
  const dir = join(dirname(f.dir), name);
  const log = `${dir}.stdout`;
  await writeFile(log, '合意した範囲の模擬ホスト検証。実適用の証拠ではない。');
  const evidence = `${dir}.json`;
  await writeFile(
    evidence,
    JSON.stringify({
      status: 'passed',
      source: await snapshot(cwd),
      findings: '現在の模擬成果物に対するホスト検証。独立判断は未実行。',
      logs: [
        {
          path: log,
          sha256: createHash('sha256')
            .update(await readFile(log))
            .digest('hex'),
        },
      ],
    }),
  );
  return {
    ...t,
    cwd,
    dir,
    args: [
      '99',
      '--repo',
      cwd,
      '--host-run',
      previousRun,
      '--host-evidence',
      evidence,
      '--run-dir',
      dir,
      '--no-publish',
    ],
  };
}

// #432（2026-10-23T11:18:26Z）の採用済み全祖先照合と、公開された入口の接続。
// R0 → --test-run/R1 → --human-decision-run/R2 → --host-run/R3 に限定する。
const ancestorScenarios = [
  'normal',
  'human_intake_live',
  'host_intake_live',
  'host_test_live',
  'host_intake_unobservable',
  'host_intake_r1_passive_live',
] as const;
type AncestorScenario = (typeof ancestorScenarios)[number];

async function expectAncestorSequenceOutcome(
  scenario: AncestorScenario,
  result: Awaited<ReturnType<typeof recoveryCli>>,
  roles: string[],
  active: { cwd: string },
  currentBefore: Awaited<ReturnType<typeof preserved>>,
) {
  const humanLive = scenario === 'human_intake_live';
  if (scenario === 'normal') {
    assert.equal(result.code, 0, result.stderr);
    expect(object(JSON.parse(result.stdout))).toMatchObject({
      status: 'verified_local',
      publication: 'not_attempted',
    });
    expect(roles).toEqual(['test', 'test', 'test', 'repair', 'check', 'review']);
    expect(await readFile(join(active.cwd, 'result.txt'), 'utf8')).toBe('implemented');
  } else {
    assert.equal(result.code, 1, result.stdout + result.stderr);
    expect(result.stderr).toMatch(/プロセス|process|観測/i);
    expect(result.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|ENOENT|SyntaxError|TypeError|ReferenceError|列がありません|形式・暦/,
    );
    expect(roles).toEqual(
      humanLive
        ? ['test']
        : scenario === 'host_test_live'
          ? ['test', 'test', 'test']
          : ['test', 'test'],
    );
    expect(await preserved(active.cwd)).toEqual(currentBefore);
  }
}

async function expectAncestorProcessObservation(
  scenario: AncestorScenario,
  control: string,
  run: string,
  ancestorCommand: string,
) {
  const observations = (await readFile(control + '.process.jsonl', 'utf8'))
    .trim()
    .split('\n')
    .map((line) => object(JSON.parse(line)));
  const relevant = observations.filter((row) => row.run === run);
  expect(relevant.length).toBeGreaterThan(0);
  if (scenario !== 'normal') {
    const unsafe = relevant.filter(
      (row) =>
        row.observation === (scenario === 'host_intake_unobservable' ? 'process_failed' : 'live'),
    );
    expect(unsafe.length).toBeGreaterThan(0);
    for (const row of unsafe) {
      expect(row.code).toBe(scenario === 'host_intake_unobservable' ? 1 : 0);
      if (scenario !== 'host_intake_unobservable') {
        expect(String(row.stdout)).toContain(ancestorCommand + '\n');
      }
    }
  }
}

for (const scenario of ancestorScenarios) {
  testDevelopment(`入口切替後も元の初回停止のプロセスを照合する: ${scenario}`, async (f) => {
    const t = await fixture(f);
    const origin = await preserved(f.dir);
    const savedOrigin = object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
    const ancestorProcess = {
      startedAt: savedOrigin.startedAt,
      command: [
        process.execPath,
        new URL('../../../implement/development.ts', import.meta.url).pathname,
        ...f.args,
      ].join(' '),
    };
    const actorEnvironment = await nativeActorEnvironment(dirname(f.dir), t.actors);
    const invokeSequence = (active: typeof t) =>
      recoveryCli(f, active, {}, { observe: true, allowImplementation: true, actorEnvironment });
    await writeFile(t.control, JSON.stringify({ response: 'needs_human', ancestorProcess }));
    const first = await invokeSequence(t);
    assert.equal(first.code, 1, first.stderr);
    expect(first.timedOut).toBe(false);
    expect(first.stderr).toContain('human_decision_required');
    const saved = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
    expect(saved).toMatchObject({
      terminal: true,
      reasonCode: 'human_decision_required',
      operation: 'independent test authoring',
      publication: 'not_attempted',
    });
    const input = object(JSON.parse(await readFile(join(t.dir, 'test-1.target.json'), 'utf8')));
    expect(input.stage).toBe('host_return');
    expect(object(JSON.parse(await readFile(join(t.dir, 'test-1.stdout'), 'utf8')))).toMatchObject({
      targetId: input.targetId,
      status: 'needs_human',
      files: [],
    });
    assert(typeof saved.checkout === 'string');
    const firstRecords = await preserved(t.dir, ['checkout']);
    const firstCheckout = await preserved(saved.checkout);
    if (scenario === 'host_intake_r1_passive_live') {
      // 必要な祖先R1だけを参照する別PID。developmentの起動引数には依存しない。
      ancestorProcess.startedAt = saved.startedAt;
      ancestorProcess.command = ['/usr/bin/passive-helper', t.dir].join(' ');
    }
    const supplement = join(dirname(f.dir), 'ancestor-sequence-supplement.json');
    await writeFile(
      supplement,
      JSON.stringify({
        format: 1,
        issue: `https://github.com/${f.settings.repository}/issues/99`,
        issueUpdatedAt: '1',
        issueSha256: createHash('sha256').update(issue).digest('hex'),
        source: '人が採用した模擬補足合意: ancestor-sequence',
        content: '元の固定baselineと全祖先の保全を維持して新しい独立判断へ戻る。',
        decision: '対象Issueの版1だけに適用する。',
      }),
    );
    const dir = join(dirname(f.dir), 'ancestor-human-return');
    const second = {
      ...t,
      cwd: saved.checkout,
      dir,
      args: [
        '99',
        '--repo',
        saved.checkout,
        '--human-decision-run',
        t.dir,
        '--supplement-file',
        supplement,
        '--run-dir',
        dir,
        '--no-publish',
      ],
    };
    const humanLive = scenario === 'human_intake_live';
    await writeFile(
      t.control,
      JSON.stringify({
        response: 'needs_host',
        ancestorProcess,
        ...(humanLive ? { observation: 'live' } : {}),
      }),
    );
    const humanResult = await invokeSequence(second);
    let active = second;
    let result = humanResult;
    let currentBefore = firstCheckout;
    let secondRecords: Awaited<ReturnType<typeof preserved>> | undefined;
    if (!humanLive) {
      assert.equal(humanResult.code, 1, humanResult.stderr);
      expect(humanResult.timedOut).toBe(false);
      expect(humanResult.stderr).toContain('host_verification_required');
      expect(object(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')))).toMatchObject({
        terminal: true,
        reasonCode: 'host_verification_required',
        publication: 'not_attempted',
      });
      expect(await actorRoles(t.executions)).toEqual(['test', 'test']);
      secondRecords = await preserved(dir, ['checkout']);
      active = await hostReturn(f, t, dir, 'ancestor-host-return');
      currentBefore = await preserved(active.cwd);
      await writeFile(
        t.control,
        JSON.stringify({
          response: 'unnecessary',
          ancestorProcess,
          ...(['host_intake_live', 'host_intake_r1_passive_live'].includes(scenario)
            ? { observation: 'live' }
            : {}),
          ...(scenario === 'host_intake_unobservable' ? { observation: 'process_failed' } : {}),
          ...(scenario === 'host_test_live' ? { activate: true, changeRole: 'test' } : {}),
        }),
      );
      result = await invokeSequence(active);
    }
    expect(result.timedOut).toBe(false);
    const roles = await actorRoles(t.executions);
    await expectAncestorSequenceOutcome(scenario, result, roles, active, currentBefore);
    await expectAncestorProcessObservation(
      scenario,
      t.control,
      active.dir,
      ancestorProcess.command,
    );
    expect(await preserved(f.dir)).toEqual(origin);
    expect(await preserved(t.dir, ['checkout'])).toEqual(firstRecords);
    if (secondRecords) {
      expect(await preserved(dir, ['checkout'])).toEqual(secondRecords);
    }
  });
}

for (const response of ['unnecessary', 'needs_host']) {
  testDevelopment(`初回ID不一致の正式停止から新しい証拠で正規復帰する: ${response}`, async (f) => {
    const t = await fixture(f);
    const original = await preserved(f.dir);
    await writeFile(t.control, JSON.stringify({ response: 'needs_host' }));
    const first = await invoke(f, t);
    expect(first.timedOut).toBe(false);
    expect(first.code).toBe(1);
    expect(first.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(first.stderr).toMatch(/host_verification_required/);
    expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
      reasonCode: 'host_verification_required',
      publication: 'not_attempted',
    });
    expect(await actorRoles(t.executions)).toEqual(['test']);
    // 正規のhost復帰は同じcheckoutで実装する。保存記録と固定入力は別に保全する。
    const firstRecords = await preserved(t.dir, ['checkout']);
    const firstCheckout = await preserved(join(t.dir, 'checkout'));
    const second = await hostReturn(f, t, t.dir, 'first-host-return');
    await writeFile(t.control, JSON.stringify({ response }));
    const returned = await invoke(f, second);
    expect(returned.timedOut).toBe(false);
    expect(returned.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    const saved = object(JSON.parse(await readFile(join(second.dir, 'result.json'), 'utf8')));
    expect(saved.checkout).toBe(second.cwd);
    if (response === 'unnecessary') {
      expect(returned.code).toBe(0);
      expect(saved).toMatchObject({ status: 'verified_local', publication: 'not_attempted' });
      expect(await actorRoles(t.executions)).toEqual(['test', 'test', 'repair', 'check', 'review']);
      expect(await readFile(join(second.cwd, 'result.txt'), 'utf8')).toBe('implemented');
    } else {
      expect(returned.code).toBe(1);
      expect(saved).toMatchObject({
        reasonCode: 'host_verification_required',
        publication: 'not_attempted',
      });
      expect(await actorRoles(t.executions)).toEqual(['test', 'test']);
      expect(await preserved(second.cwd)).toEqual(firstCheckout);
      const secondRecords = await preserved(second.dir);
      // #430の追加合意により、直前の正式停止と新しい証拠を明示した兄弟runは許可する。
      // --test-runでの再試行とは区別し、未実行の初回実装だけを一度実行する。
      const third = await hostReturn(f, t, second.dir, 'formal-host-chain');
      await writeFile(t.control, JSON.stringify({ response: 'unnecessary' }));
      const resumed = await invoke(f, third);
      expect(resumed.timedOut).toBe(false);
      expect(resumed.code).toBe(0);
      expect(resumed.stderr).not.toMatch(
        /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
      );
      expect(await actorRoles(t.executions)).toEqual([
        'test',
        'test',
        'test',
        'repair',
        'check',
        'review',
      ]);
      expect(
        object(JSON.parse(await readFile(join(third.dir, 'result.json'), 'utf8'))),
      ).toMatchObject({
        status: 'verified_local',
        publication: 'not_attempted',
        checkout: third.cwd,
      });
      expect(await preserved(second.dir)).toEqual(secondRecords);
      expect(await readFile(join(third.cwd, 'result.txt'), 'utf8')).toBe('implemented');
    }
    expect(await preserved(f.dir)).toEqual(original);
    expect(await preserved(t.dir, ['checkout'])).toEqual(firstRecords);
  });
}

testDevelopment('旧停止runを指定しない別名の通常起動では迂回しない', async (f) => {
  const t = await fixture(f);
  t.args.splice(t.args.indexOf('--test-run'), 2);
  const original = await preserved(f.dir);
  const result = await invoke(f, t);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/branch.*exists|unfinished|active|停止|照合|reconciliation/i);
  expect(await preserved(f.dir)).toEqual(original);
  expect(await actorRoles(t.executions)).toEqual([]);
});

for (const explicit of [false, true]) {
  testDevelopment(`同じrunの再利用と保存先の省略を拒否する: ${explicit}`, async (f) => {
    const t = await fixture(f);
    if (explicit) {
      t.args[t.args.indexOf('--run-dir') + 1] = f.dir;
    } else {
      t.args.splice(t.args.indexOf('--run-dir'), 2);
    }
    const original = await preserved(f.dir);
    const result = await invoke(f, t);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
    );
    expect(await preserved(f.dir)).toEqual(original);
    expect(await actorRoles(t.executions)).toEqual([]);
  });
}

testDevelopment('有効なテスト判断・実装・評価済みのrunをID不一致復帰へ流用しない', async (f) => {
  f.args.push('--no-publish');
  const previous = await develop(f.args, f.io);
  expect(previous.status).toBe('verified_local');
  const original = await preserved(f.dir);
  const calls = { ...f.calls };
  await assert.rejects(
    () =>
      develop(
        [
          '99',
          '--repo',
          previous.checkout,
          '--test-run',
          f.dir,
          '--run-dir',
          join(dirname(f.dir), 'invalid-return'),
          '--no-publish',
        ],
        f.io,
      ),
    (error) => {
      expect(String(error)).not.toMatch(
        /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
      );
      return true;
    },
  );
  expect(f.calls).toEqual(calls);
  expect(await preserved(f.dir)).toEqual(original);
});

async function rejectedBeforeActors(f: DevelopmentFixture, t: Awaited<ReturnType<typeof fixture>>) {
  const original = await preserved(f.dir);
  const result = await invoke(f, t);
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(1);
  expect(result.stderr).not.toMatch(
    /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
  );
  expect(await actorRoles(t.executions)).toEqual([]);
  expect(await preserved(f.dir)).toEqual(original);
}

async function changeOldEvents(dir: string, failed: boolean) {
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => object(JSON.parse(line)));
  if (!failed) {
    assert(events[2]);
    events[2].item = { id: 'item_0', type: 'agent_message', text: '{}' };
  } else {
    events[events.length - 1] = { type: 'turn.failed', error: { message: 'fixture failure' } };
  }
  await writeFile(
    join(dir, 'events.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
}

// 同時注入では、どの原記録を照合したか識別できないため一条件ずつ変更する。
for (const defect of [
  'actor_missing',
  'actor_json',
  'role',
  'hostPrefix',
  'duplicate',
  'final_missing',
  'final_mismatch',
  'events_missing',
  'events_mismatch',
  'events_failed',
  'schema_missing',
  'schema_invalid',
  'execution_missing',
  'execution_timeout',
] as const) {
  testDevelopment(`旧付属actorの原記録を単独で照合する: ${defect}`, async (f) => {
    const t = await fixture(f);
    const dir = join(f.dir, 'test-codex-fixture');
    const patch = async (path: string, values: Record<string, unknown>) => {
      await writeFile(
        path,
        JSON.stringify({ ...object(JSON.parse(await readFile(path, 'utf8'))), ...values }),
      );
    };
    if (defect === 'actor_missing') {
      await rm(join(dir, 'actor.json'));
    }
    if (defect === 'actor_json') {
      await writeFile(join(dir, 'actor.json'), '{broken');
    }
    if (defect === 'role') {
      await patch(join(dir, 'actor.json'), { role: 'repair' });
    }
    if (defect === 'hostPrefix') {
      await patch(join(dir, 'actor.json'), { hostPrefix: 'test-2' });
    }
    if (defect === 'duplicate') {
      const other = await oldTestActor(
        join(f.dir, 'test-1-workspace'),
        await readFile(join(dir, 'final.json'), 'utf8'),
      );
      // run直下の同工程に対応する二つ目の呼出し。
      await rename(other.dir, join(f.dir, 'test-codex-duplicate'));
    }
    if (defect === 'final_missing') {
      await rm(join(dir, 'final.json'));
    }
    if (defect === 'final_mismatch') {
      await patch(join(dir, 'final.json'), { findings: '別の応答' });
    }
    if (defect === 'events_missing') {
      await rm(join(dir, 'events.jsonl'));
    }
    if (defect === 'events_mismatch' || defect === 'events_failed') {
      await changeOldEvents(dir, defect === 'events_failed');
    }
    if (defect === 'schema_missing') {
      await rm(join(dir, 'schema.json'));
    }
    if (defect === 'schema_invalid') {
      await writeFile(join(dir, 'schema.json'), '{}');
    }
    if (defect === 'execution_missing') {
      await rm(join(f.dir, 'test-1.execution.json'));
    }
    if (defect === 'execution_timeout') {
      await patch(join(f.dir, 'test-1.execution.json'), { timedOut: true });
    }
    await rejectedBeforeActors(f, t);
  });
}

for (const lock of ['run', 'checkout_index', 'common_refs', 'common_packed_refs'] as const) {
  testDevelopment(`旧runとGit管理領域のlockを個別に拒否する: ${lock}`, async (f) => {
    const t = await fixture(f);
    const common = await gitOutput(
      t.cwd,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    );
    const path =
      lock === 'run'
        ? join(f.dir, 'lock')
        : lock === 'checkout_index'
          ? await gitOutput(
              t.cwd,
              'rev-parse',
              '--path-format=absolute',
              '--git-path',
              'index.lock',
            )
          : lock === 'common_refs'
            ? join(common, 'refs/heads/codex/development-99.lock')
            : join(common, 'packed-refs.lock');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'lock fixture');
    const mode = (await lstat(path)).mode;
    await rejectedBeforeActors(f, t);
    expect(await readFile(path, 'utf8')).toBe('lock fixture');
    expect((await lstat(path)).mode).toBe(mode);
  });
}

type BoundaryChange = 'content' | 'mode' | 'process' | 'lock';
const boundaryContent = 'changed at return boundary';
async function applyBoundaryChange(path: string, change: BoundaryChange, control: string) {
  if (change === 'process') {
    await writeFile(control, JSON.stringify({ observation: 'live' }));
  } else if (change === 'mode') {
    await chmod(path, 0o755);
  } else {
    await writeFile(path, boundaryContent);
  }
}

async function expectBoundaryPreserved(
  run: string,
  original: Awaited<ReturnType<typeof preserved>>,
  path: string,
  change: BoundaryChange,
) {
  const expected = { ...original };
  if (change !== 'process') {
    const previous = original[path];
    const mode = previous?.mode ?? 0o100000 | (0o666 & ~process.umask());
    expected[path] = {
      mode: change === 'mode' ? (mode & ~0o777) | 0o755 : mode,
      content:
        change === 'mode' && previous
          ? previous.content
          : createHash('sha256').update(boundaryContent).digest('hex'),
    };
  }
  expect(await preserved(run)).toEqual(expected);
}

for (const phase of ['before_host_test', 'test_needs_host', 'implementation_needs_host'] as const) {
  for (const change of ['content', 'mode', 'process', 'lock'] as const) {
    testDevelopment(
      `復帰境界で旧原本・稼働状況の変化を再照合する: ${phase}/${change}`,
      async (f) => {
        const t = await fixture(f);
        let active = t;
        let firstRecords: Awaited<ReturnType<typeof preserved>> | undefined;
        const original = await preserved(f.dir);
        if (phase === 'before_host_test') {
          await writeFile(t.control, JSON.stringify({ response: 'needs_host' }));
          const first = await invoke(f, t);
          expect(first.code).toBe(1);
          expect(first.stderr).toMatch(/host_verification_required/);
          expect(await actorRoles(t.executions)).toEqual(['test']);
          active = await hostReturn(f, t, t.dir, 'boundary-host-return');
          firstRecords = await preserved(t.dir, ['checkout']);
        }
        const path =
          change === 'lock' ? join(f.dir, 'lock') : join(f.dir, 'test-codex-fixture/final.json');
        const modification =
          change === 'mode'
            ? { path, mode: 0o755 }
            : { path, content: 'changed at return boundary' };
        const control = {
          response: phase === 'test_needs_host' ? 'needs_host' : 'unnecessary',
          implementationHost: phase === 'implementation_needs_host',
          changeRole: phase === 'implementation_needs_host' ? 'repair' : 'test',
          ...(change === 'process' ? { activate: true } : { change: modification }),
        };
        if (phase === 'before_host_test') {
          await applyBoundaryChange(path, change, t.control);
        } else {
          await writeFile(t.control, JSON.stringify(control));
        }
        const changedBefore = await preserved(f.dir);
        const result = await invoke(f, active);
        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(1);
        expect(result.stderr).not.toMatch(
          /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
        );
        // 原本や稼働状況が変わった状態を、正常なホスト引継ぎとして封印しない。
        expect(result.stderr).not.toMatch(/host_verification_required/);
        expect(await actorRoles(t.executions)).toEqual(
          phase === 'implementation_needs_host' ? ['test', 'repair'] : ['test'],
        );
        if (phase === 'before_host_test') {
          expect(await preserved(f.dir)).toEqual(changedBefore);
          assert(firstRecords);
          expect(await preserved(t.dir, ['checkout'])).toEqual(firstRecords);
        } else {
          await expectBoundaryPreserved(f.dir, original, path, change);
        }
        const saved = object(JSON.parse(await readFile(join(active.dir, 'result.json'), 'utf8')));
        expect(saved.status).not.toBe('verified_local');
        expect(saved.publication).toBe('not_attempted');
      },
    );
  }
}

testDevelopment('旧付属actor fixtureは補正前の原応答とホスト実行記録に対応する', async (f) => {
  const t = await fixture(f, 'mismatch_artifact');
  const dir = join(f.dir, 'test-codex-fixture');
  const metadata = object(JSON.parse(await readFile(join(dir, 'actor.json'), 'utf8')));
  expect(runtimeShape.safeParse(metadata.runtime).success).toBe(true);
  expect(metadata).toMatchObject({ recordFormat: 2, role: 'test', hostPrefix: 'test-1' });
  const final = await readFile(join(dir, 'final.json'), 'utf8');
  expect(await readFile(join(f.dir, 'test-1.stdout'), 'utf8')).toBe(final + '\n');
  const reply = object(JSON.parse(final));
  const input = object(JSON.parse(await readFile(join(f.dir, 'test-1.target.json'), 'utf8')));
  expect(String(input.targetId)).toHaveLength(64);
  expect(String(reply.targetId)).toHaveLength(52);
  expect(input.targetId).not.toBe(reply.targetId);
  expect(reply).toMatchObject({ status: 'prepared', files: ['pending.test.js'] });
  const pending = join(f.dir, 'test-1-workspace/pending.test.js');
  expect(await readFile(pending, 'utf8')).toBe('process.exit(1);\n');
  expect((await lstat(pending)).mode & 0o777).toBe(0o755);
  expect(await Bun.file(join(t.cwd, 'pending.test.js')).exists()).toBe(false);
  const schema = object(JSON.parse(await readFile(join(dir, 'schema.json'), 'utf8')));
  expect(object(schema.properties).targetId).toEqual({
    type: 'string',
    minLength: 1,
    pattern: '\\S',
  });
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => object(JSON.parse(line)));
  expect(object(events[2]?.item).text).toBe(final);
  expect(events.at(-1)?.type).toBe('turn.completed');
  expect(
    object(JSON.parse(await readFile(join(f.dir, 'test-1.execution.json'), 'utf8'))),
  ).toMatchObject({ code: 0, timedOut: false });
  expect(f.calls.implementations).toBe(0);
  // 新入口が未接続でも模擬actor自身の構文・入力契約を限定して診断する。
  const fresh = await command(
    [process.execPath, t.script, 'test'],
    t.cwd,
    `入力: ${JSON.stringify({ targetId: input.targetId, stage: 'host_return' })}`,
    10000,
  );
  expect(fresh.code).toBe(0);
  expect(object(JSON.parse(fresh.stdout))).toMatchObject({
    targetId: input.targetId,
    status: 'unnecessary',
  });
  await writeFile(t.control, JSON.stringify({ implementationHost: true }));
  const implementation = await command([process.execPath, t.script, 'repair'], t.cwd, '', 10000);
  expect(implementation.code).toBe(0);
  expect(object(JSON.parse(implementation.stdout)).status).toBe('needs_host');
});

testDevelopment('変化のない旧原本は初回実装からの正当なneeds_hostを妨げない', async (f) => {
  const t = await fixture(f);
  const original = await preserved(f.dir);
  await writeFile(t.control, JSON.stringify({ response: 'unnecessary', implementationHost: true }));
  const result = await invoke(f, t);
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/host_verification_required/);
  expect(result.stderr).not.toMatch(
    /Unknown option|ERR_PARSE_ARGS|SyntaxError|TypeError|ReferenceError/,
  );
  expect(await actorRoles(t.executions)).toEqual(['test', 'repair']);
  expect(await preserved(f.dir)).toEqual(original);
  expect(object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')))).toMatchObject({
    reasonCode: 'host_verification_required',
    publication: 'not_attempted',
  });
});
