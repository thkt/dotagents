import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { expect } from 'bun:test';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { develop } from '../../../implement/orchestrator.ts';
import { gitOutput, issue } from '../../support/development.ts';
import { events, object } from '../../support/correction.ts';
import {
  expectActorAssociation,
  expectActorReference,
  saveActorRecord,
} from '../../support/actor-records.ts';
import {
  records,
  recoveryCli,
  contractRecoveryCli,
  recoveryFixture,
  testReviewRecovery as testDevelopment,
} from '../../support/review-recovery.ts';

testDevelopment('公開権限を維持した復帰で検証済み成果物のcommitを公開前に照合する', async (f) => {
  // 要求3: 旧runの権限を維持する。全fixtureをローカル限定するとこの接続を通れない。
  const t = await recoveryFixture(f, false);
  const original = await records(f.dir);
  const stoppedHead = await gitOutput(t.cwd, 'rev-parse', 'HEAD');
  const artifacts = await records(t.cwd);
  const testMode = (await stat(join(t.cwd, 'result.test.js'))).mode;
  const verify = f.verify;
  const heads: (string | undefined)[] = [];
  f.verify = async (config, publicationHead) => {
    heads.push(publicationHead);
    expect(await records(t.cwd)).toEqual(artifacts);
    expect((await stat(join(t.cwd, 'result.test.js'))).mode).toBe(testMode);
    if (publicationHead === undefined) {
      expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD')).toBe(stoppedHead);
    } else {
      expect(publicationHead).toBe(await gitOutput(t.cwd, 'rev-parse', 'HEAD'));
      expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD^')).toBe(stoppedHead);
      expect(await gitOutput(t.cwd, 'status', '--porcelain')).toBe('');
    }
    return verify(config, publicationHead);
  };
  const execute = f.io.command;
  let reachedPush = false;
  f.io.command = async (argv, cwd, ...rest) => {
    if (argv[0] === 'git' && argv.includes('push')) {
      reachedPush = true;
      expect(heads[0]).toBeUndefined();
      // 照合回数は契約ではない。評価からcommit後の照合を経てpushする順序を守る。
      const publicationHead = await gitOutput(t.cwd, 'rev-parse', 'HEAD');
      expect(heads.filter((head) => head !== undefined).length).toBeGreaterThan(0);
      expect(heads.at(-1)).toBe(publicationHead);
      expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD^')).toBe(stoppedHead);
      expect(await gitOutput(t.cwd, 'status', '--porcelain')).toBe('');
      expect(await records(t.cwd)).toEqual(artifacts);
      throw Error('fixture: 公開前照合を確認したため送信しない');
    }
    return execute(argv, cwd, ...rest);
  };
  await assert.rejects(() => develop(t.args, f.io), /fixture: 公開前照合を確認したため送信しない/);
  expect(reachedPush).toBe(true);
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
  expect(await records(f.dir)).toEqual(original);
  const state = object(JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')));
  expect(state).toMatchObject({
    result: 'ready_for_human_review',
    checks: 1,
    review: 1,
    repair: 0,
  });
});

testDevelopment('公開権限を維持した復帰で成果物が同じでも任意HEADの公開を拒否する', async (f) => {
  const t = await recoveryFixture(f, false);
  const original = await records(f.dir);
  const stoppedHead = await gitOutput(t.cwd, 'rev-parse', 'HEAD');
  const artifacts = await records(t.cwd);
  const execute = f.io.command;
  let injected = false;
  let verifiedRecords: Record<string, string> = {};
  f.io.command = async (argv, cwd, ...rest) => {
    // 送信境界は必ず遮断する。ここへの到達自体が失敗であり、公開は実行しない。
    if (argv[0] === 'git' && argv.includes('push')) {
      throw Error('fixture: 任意HEADが公開境界へ到達した');
    }
    const response = await execute(argv, cwd, ...rest);
    if (argv[0] === 'git' && argv[1] === 'commit' && response.code === 0) {
      expect(injected).toBe(false);
      expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD^')).toBe(stoppedHead);
      const tree = await gitOutput(t.cwd, 'rev-parse', 'HEAD^{tree}');
      verifiedRecords = await records(join(t.dir, 'verification'));
      // 成果物の変更で先に止めず、同じtree・clean状態の別HEADだけを与える。
      await gitOutput(t.cwd, 'commit', '--allow-empty', '-m', 'fixture: unrelated HEAD');
      injected = true;
      expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
      expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD^')).not.toBe(stoppedHead);
      expect(await gitOutput(t.cwd, 'status', '--porcelain')).toBe('');
      expect(await records(t.cwd)).toEqual(artifacts);
    }
    return response;
  };
  const outcome: unknown = await develop(t.args, f.io).catch((error: unknown) => error);
  expect(injected).toBe(true);
  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).not.toMatch(
    /Unknown option|ERR_PARSE_ARGS|Cannot find|SyntaxError|任意HEADが公開境界へ到達した/,
  );
  expect(String(outcome)).toMatch(/HEAD|commit|target/i);
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
  expect(await records(f.dir)).toEqual(original);
  expect(await records(join(t.dir, 'verification'))).toEqual(verifiedRecords);
  const saved = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
  expect(saved).toMatchObject({ status: 'stopped', publication: 'not_attempted' });
  const state = object(JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')));
  expect(state).toMatchObject({
    result: 'ready_for_human_review',
    checks: 1,
    review: 1,
    repair: 0,
  });
});

for (const scenario of ['accepted', 'invalid', 'change_check', 'change_review'] as const) {
  testDevelopment(`保存した実CLIの検証契約を保った新run: ${scenario}`, async (f) => {
    const changedDuringRun = scenario === 'change_check' || scenario === 'change_review';
    const response = scenario === 'invalid' ? 'invalid' : 'accepted';
    const t = await recoveryFixture(f);
    await gitOutput(t.cwd, 'branch', '-m', 'fixture-custom-stop');
    const prior = join(dirname(f.dir), 'contract-stop');
    await writeFile(t.control, JSON.stringify({ response: 'invalid' }));
    const stopped = await contractRecoveryCli(f, t, [
      '99',
      '--repo',
      f.repo,
      '--run-dir',
      prior,
      '--no-publish',
    ]);
    expect(stopped.timedOut).toBe(false);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain('Verification stopped: invalid_review');
    const configPath = join(prior, 'verification-config.json');
    const config = object(JSON.parse(await readFile(configPath, 'utf8')));
    const priorState = object(
      JSON.parse(await readFile(join(prior, 'verification/state.json'), 'utf8')),
    );
    expect(priorState).toMatchObject({
      result: 'invalid_review',
      review: 1,
      repair: 0,
      reviewHistory: [],
    });
    expect(priorState.configHash).toBe(
      createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    );
    // 通常CLIが保存する信頼するactorのargv。模擬argvへの設定書換えで照合を通さない。
    expect(events(config.review)[1]).toBe(
      new URL('../../../implement/codex-actor.ts', import.meta.url).pathname,
    );
    expect(events(config.issue)[0]).toBe('gh');
    const original = await records(prior);
    const dir = join(dirname(f.dir), 'contract-return');
    const cwd = String(config.cwd);
    const testContent = await readFile(join(cwd, 'result.test.js'));
    const testMode = (await stat(join(cwd, 'result.test.js'))).mode;
    const oldResponsePath = join(prior, 'verification/review-1.stdout');
    const oldResponse = await readFile(oldResponsePath, 'utf8');
    const changedResponse = oldResponse + '\n';
    await writeFile(
      t.control,
      JSON.stringify({
        response,
        ...(changedDuringRun
          ? {
              [scenario === 'change_check' ? 'changeCheck' : 'change']: {
                path: oldResponsePath,
                content: changedResponse,
              },
            }
          : {}),
      }),
    );
    const returned = await contractRecoveryCli(f, t, [
      '99',
      '--repo',
      cwd,
      '--review-run',
      prior,
      '--run-dir',
      dir,
      '--no-publish',
    ]);
    expect(returned.timedOut).toBe(false);
    expect(returned.stderr).not.toMatch(/Unknown option|ERR_PARSE_ARGS|Cannot find|SyntaxError/);
    const accepted = response === 'accepted' && !changedDuringRun;
    expect(returned.code).toBe(accepted ? 0 : 1);
    const fresh = object(JSON.parse(await readFile(join(dir, 'verification-config.json'), 'utf8')));
    for (const field of [
      'cwd',
      'baseCommit',
      'targetText',
      'check',
      'setup',
      'capture',
      'captureDestination',
      'captureRequired',
    ]) {
      expect(fresh[field]).toEqual(config[field]);
    }
    const state = object(JSON.parse(await readFile(join(dir, 'verification/state.json'), 'utf8')));
    expect(fresh.checkTimeMs).toBeNull();
    expect(state.configHash).toBe(createHash('sha256').update(JSON.stringify(fresh)).digest('hex'));
    if (changedDuringRun) {
      // 要求4: 正常な応答でも旧記録の変更後は受け入れない。変更工程への到達も確認する。
      expect(await readFile(oldResponsePath, 'utf8')).toBe(changedResponse);
      expect(state.result).not.toBe('ready_for_human_review');
      expect(events(state.reviewHistory)).toEqual([]);
      const preserved = await records(prior);
      expect(preserved[oldResponsePath]).toBe(
        createHash('sha256').update(changedResponse).digest('hex'),
      );
      delete preserved[oldResponsePath];
      delete original[oldResponsePath];
      expect(preserved).toEqual(original);
    } else {
      expect(state).toMatchObject({
        result: accepted ? 'ready_for_human_review' : 'invalid_review',
        checks: 1,
        review: 1,
        repair: 0,
      });
      expect(events(state.reviewHistory)).toHaveLength(accepted ? 1 : 0);
      expect(await records(prior)).toEqual(original);
    }
    expect(await Bun.file(join(dir, 'verification/check-1.stdout')).exists()).toBe(true);
    expect(await Bun.file(join(dir, 'verification/review-1.stdout')).exists()).toBe(
      scenario !== 'change_check',
    );
    expect(await readFile(join(cwd, 'result.test.js'))).toEqual(testContent);
    expect((await stat(join(cwd, 'result.test.js'))).mode).toBe(testMode);
    expect(object(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')))).toMatchObject({
      publication: 'not_attempted',
      status: accepted ? 'verified_local' : 'stopped',
    });
  });
}

for (const response of ['accepted', 'invalid'] as const) {
  testDevelopment(`公開CLIで初回不正評価から新規検証する: ${response}`, async (f) => {
    const t = await recoveryFixture(f);
    const original = await records(f.dir);
    await writeFile(t.control, JSON.stringify({ response }));
    const outcome = await recoveryCli(f, t);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.stderr).not.toMatch(/Unknown option|ERR_PARSE_ARGS|Cannot find|SyntaxError/);
    expect(outcome.code).toBe(response === 'accepted' ? 0 : 1);
    const state = object(
      JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
    );
    expect(state).toMatchObject({
      result: response === 'accepted' ? 'ready_for_human_review' : 'invalid_review',
      checks: 1,
      review: 1,
      repair: 0,
    });
    expect(events(state.reviewHistory)).toHaveLength(response === 'accepted' ? 1 : 0);
    expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(true);
    const saved = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
    expect(saved.publication).toBe('not_attempted');
    expect(saved.status).toBe(response === 'accepted' ? 'verified_local' : 'stopped');
    expect(await records(f.dir)).toEqual(original);
  });
}

for (const response of ['accepted', 'invalid', 'needs_changes', 'check_repair'] as const) {
  testDevelopment(`初回不正評価の復帰は新しいcheckと評価を必要とする: ${response}`, async (f) => {
    const t = await recoveryFixture(f);
    const original = await records(f.dir);
    const tests = await readFile(join(t.cwd, 'result.test.js'));
    const mode = (await stat(join(t.cwd, 'result.test.js'))).mode;
    const head = await gitOutput(t.cwd, 'rev-parse', 'HEAD');
    const branch = await gitOutput(t.cwd, 'branch', '--show-current');
    const config = await readFile(join(t.cwd, '.dotagents.json'));
    await writeFile(
      t.control,
      JSON.stringify({ response, failCheck: response === 'check_repair' }),
    );
    const outcome: unknown = await develop(t.args, f.io).catch((error: unknown) => error);
    expect(String(outcome)).not.toMatch(/Unknown option|ERR_PARSE_ARGS|Cannot find|SyntaxError/);
    const state = object(
      JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')),
    );
    if (response === 'invalid') {
      expect(outcome).toBeInstanceOf(Error);
      expect(state).toMatchObject({
        result: 'invalid_review',
        checks: 1,
        review: 1,
        repair: 0,
        reviewHistory: [],
      });
      expect(await Bun.file(join(t.dir, 'verification/review-1.json')).exists()).toBe(false);
    } else {
      expect(outcome).toMatchObject({ status: 'verified_local' });
      expect(state.result).toBe('ready_for_human_review');
      expect(state.checks).toBe(response === 'accepted' ? 1 : 2);
      expect(state.review).toBe(response === 'needs_changes' ? 2 : 1);
      expect(state.repair).toBe(response === 'accepted' ? 0 : 1);
      expect(events(state.reviewHistory).map((value) => object(value).status)).toEqual(
        response === 'needs_changes' ? ['needs_changes', 'accepted'] : ['accepted'],
      );
      const target = await readFile(join(t.dir, 'verification/review-1.target.json'), 'utf8');
      // 保存形式には依存せず、旧runと原応答のhash付き参照を辿れることを確認する。
      const newRecords = await records(t.dir);
      const text = (
        await Promise.all(
          Object.keys(newRecords)
            .filter((path) => path.endsWith('.json'))
            .map((path) => readFile(path, 'utf8')),
        )
      ).join('\n');
      expect(text).toContain(f.dir);
      expect(text).toContain(
        original[join(f.dir, 'verification/review-1.stdout')] ?? 'missing-old-response',
      );
      expect(object(JSON.parse(target)).baseCommit).toBe(head);
    }
    expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(true);
    expect(await Bun.file(join(t.dir, 'verification/review-1.stdout')).exists()).toBe(true);
    expect(await readFile(join(t.cwd, 'result.txt'), 'utf8')).toBe('implemented');
    expect(await readFile(join(t.cwd, 'result.test.js'))).toEqual(tests);
    expect((await stat(join(t.cwd, 'result.test.js'))).mode).toBe(mode);
    expect(await readFile(join(t.cwd, '.dotagents.json'))).toEqual(config);
    expect(await gitOutput(t.cwd, 'rev-parse', 'HEAD')).toBe(head);
    expect(await gitOutput(t.cwd, 'branch', '--show-current')).toBe(branch);
    expect(await records(f.dir)).toEqual(original);
    const roles = (await readFile(t.executions, 'utf8')).trim().split('\n');
    expect(roles.filter((role) => role === 'check')).toHaveLength(Number(state.checks) + 1);
    expect(roles.filter((role) => role === 'review')).toHaveLength(Number(state.review) + 1);
    expect(f.calls.implementations).toBe(1);
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
  });
}

for (const change of [
  'published',
  'nonterminal',
  'review_count',
  'base',
  'checkout',
  'missing_config',
  'reason',
  'history',
  'repair',
  'active',
  'lock',
  'missing_target',
  'missing_response',
  'missing_state',
  'missing_result',
  'old_review_format',
  'missing_test_records',
  'test_response',
  'test_input',
  'test_prompt',
  'source',
  'test_content',
  'test_mode',
  'setting',
  'head',
  'branch',
  'issue',
  'actor',
  'repository',
  'same_directory',
  'nested_directory',
  'expanded_authority',
] as const) {
  testDevelopment(`初回不正評価の復帰条件の不一致を拒否する: ${change}`, async (f) => {
    const t = await recoveryFixture(f);
    const patch = async (name: string, values: Record<string, unknown>) => {
      const path = join(f.dir, name);
      const saved = object(JSON.parse(await readFile(path, 'utf8')));
      await writeFile(path, JSON.stringify({ ...saved, ...values }));
    };
    const operations: Partial<Record<typeof change, () => Promise<unknown> | void>> = {
      published: () => patch('result.json', { publication: 'published' }),
      nonterminal: () => patch('result.json', { terminal: false }),
      base: () => patch('verification-config.json', { baseCommit: '0'.repeat(40) }),
      checkout: () => patch('verification-config.json', { cwd: f.repo }),
      missing_config: () => rm(join(f.dir, 'verification-config.json')),
      reason: () => patch('verification/state.json', { result: 'review_failed' }),
      history: () => patch('verification/state.json', { reviewHistory: f.history }),
      review_count: () => patch('verification/state.json', { review: 2 }),
      repair: () => patch('verification/state.json', { repair: 1 }),
      active: () =>
        patch('verification/state.json', {
          active: { role: 'review', prefix: join(f.dir, 'verification/review-1') },
        }),
      lock: () => mkdir(join(f.dir, 'verification/lock')),
      missing_target: () => rm(join(f.dir, 'verification/review-1.target.json')),
      // 要求3・4: 診断用の原応答と初回停止の証拠を欠いたrunを補完しない。
      missing_response: () => rm(join(f.dir, 'verification/review-1.stdout')),
      missing_state: () => rm(join(f.dir, 'verification/state.json')),
      missing_result: () => rm(join(f.dir, 'result.json')),
      // 対象外の旧形式を現行形式へ自動変換して復帰させない。
      old_review_format: () => patch('verification/state.json', { reviewFormat: 3 }),
      missing_test_records: () => rm(join(f.dir, 'test-records.json')),
      test_response: async () => {
        const path = join(f.dir, 'test-1.stdout');
        await writeFile(path, (await readFile(path, 'utf8')) + '\n');
      },
      test_input: async () => {
        const path = join(f.dir, 'test-1.target.json');
        await writeFile(path, (await readFile(path, 'utf8')) + '\n');
      },
      test_prompt: async () => {
        const path = join(f.dir, 'test-1.prompt');
        await writeFile(path, (await readFile(path, 'utf8')) + '\n');
      },
      source: () => writeFile(join(t.cwd, 'result.txt'), 'changed'),
      test_content: () => writeFile(join(t.cwd, 'result.test.js'), 'process.exit(0);'),
      test_mode: () => chmod(join(t.cwd, 'result.test.js'), 0o644),
      setting: () => writeFile(join(t.cwd, '.dotagents.json'), JSON.stringify(f.settings) + '\n'),
      head: () => gitOutput(t.cwd, 'commit', '--allow-empty', '-m', 'different HEAD'),
      branch: () => gitOutput(t.cwd, 'branch', '-m', 'different-branch'),
      same_directory: () => {
        t.args[t.args.indexOf('--run-dir') + 1] = f.dir;
      },
      nested_directory: () => {
        t.args[t.args.indexOf('--run-dir') + 1] = join(f.dir, 'return');
      },
      expanded_authority: () => {
        t.args.pop();
      },
    };
    const operation = operations[change];
    await operation?.();
    // Issue・主体・repositoryも公開CLIの外部I/Oにだけ注入する。
    const githubReplies: Record<string, string> = {};
    if (change === 'issue') {
      githubReplies.issue = issue.replace('Show the requested result.', 'Changed requirement.');
    }
    if (change === 'actor') {
      githubReplies.user = JSON.stringify({ login: 'different-actor' });
    }
    if (change === 'repository') {
      const key = `repos/${f.settings.repository}`;
      const response = await f.github(['gh', 'api', key], t.cwd, null);
      githubReplies[key] = response.stdout.replace('"id":123', '"id":456');
    }
    const original = await records(f.dir);
    const executions = await readFile(t.executions, 'utf8');
    const cli = await recoveryCli(f, t, githubReplies);
    expect(cli.timedOut).toBe(false);
    expect(cli.code).toBe(1);
    // 未実装の引数・構文エラーや型例外を、復帰条件の検出と数えない。
    expect(cli.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|Cannot find|SyntaxError|TypeError|ReferenceError/,
    );
    expect(cli.stderr.trim()).not.toBe('');
    expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    expect(await Bun.file(join(t.dir, 'verification/review-1.stdout')).exists()).toBe(false);
    // 子プロセスのI/Oは親のcallsに反映されないため、実行記録を直接確認する。
    expect(await readFile(t.executions, 'utf8')).toBe(executions);
    expect(f.calls.implementations).toBe(1);
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
    expect(await records(f.dir)).toEqual(original);
  });
}

testDevelopment('公開CLIは旧runの稼働プロセスを拒否し、終了後は新規検証する', async (f) => {
  const t = await recoveryFixture(f);
  // 実CLIのargvを使い、制御処理のI/O境界だけを待機させる。モデルは起動しない。
  const preload = join(dirname(f.dir), 'active-cli.ts');
  const orchestrator = new URL('../../../implement/orchestrator.ts', import.meta.url).pathname;
  await writeFile(
    preload,
    `import {mock} from 'bun:test'; mock.module(${JSON.stringify(orchestrator)},()=>({develop:async()=>{process.stdout.write('ready');await new Promise(()=>{});}}));setInterval(()=>{},1000);`,
  );
  const child = spawn(
    process.execPath,
    [
      '--preload',
      preload,
      new URL('../../../implement/development.ts', import.meta.url).pathname,
      '99',
      '--repo',
      t.cwd,
      '--run-dir',
      f.dir,
      '--no-publish',
    ],
    { cwd: t.cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    assert(child.stdout && child.pid);
    await once(child.stdout, 'data');
    process.kill(child.pid, 0);
    const original = await records(f.dir);
    const executions = await readFile(t.executions, 'utf8');
    const outcome = await recoveryCli(f, t);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(1);
    // 要求3の拒否理由を確認する。照合不能はOSコードがなくても検出成功に数えない。
    expect(outcome.stderr).toMatch(
      /(?:running|active|live|稼働)[^\n]*(?:process|プロセス)|(?:process|プロセス)[^\n]*(?:running|active|live|稼働)/i,
    );
    expect(outcome.stderr).not.toMatch(
      /Unknown option|ERR_PARSE_ARGS|Cannot find|SyntaxError|EPERM|EACCES|ENOENT|(?:照合|取得|確認)(?:できません|不能)/,
    );
    expect(await readFile(t.executions, 'utf8')).toBe(executions);
    expect(await Bun.file(join(t.dir, 'verification/check-1.stdout')).exists()).toBe(false);
    expect(await Bun.file(join(t.dir, 'verification/review-1.stdout')).exists()).toBe(false);
    expect(await records(f.dir)).toEqual(original);
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  // 他の条件は固定し、子プロセスだけを終了した正常対照を同じ公開入口で確認する。
  // 一覧取得不能で常に拒否する環境・実装は、この対照を満たさない。
  const original = await records(f.dir);
  const executions = await readFile(t.executions, 'utf8');
  const returned = await recoveryCli(f, t);
  expect(returned.timedOut).toBe(false);
  expect(returned.code).toBe(0);
  const state = object(JSON.parse(await readFile(join(t.dir, 'verification/state.json'), 'utf8')));
  expect(state).toMatchObject({
    result: 'ready_for_human_review',
    checks: 1,
    review: 1,
    repair: 0,
  });
  expect(events(state.reviewHistory)).toHaveLength(1);
  expect(await readFile(t.executions, 'utf8')).toBe(executions + 'check\nreview\n');
  const saved = object(JSON.parse(await readFile(join(t.dir, 'result.json'), 'utf8')));
  expect(saved).toMatchObject({ status: 'verified_local', publication: 'not_attempted' });
  expect(await records(f.dir)).toEqual(original);
});

testDevelopment('不正評価からの新runは旧actor原記録をpromptから辿れ保全する', async (f) => {
  const implementation = f.implement;
  let path = '';
  f.implement = async (...args) => {
    const response = await implementation(...args);
    assert(args[4]);
    path = await saveActorRecord(f.dir, args[4], 'repair', 'invalid-review');
    return response;
  };
  const t = await recoveryFixture(f);
  const original = await records(f.dir);
  const result = await develop(t.args, f.io);
  expect(result.status).toBe('verified_local');
  const prefix = join(t.dir, 'verification/review-1');
  const target = object(JSON.parse(await readFile(`${prefix}.target.json`, 'utf8')));
  await expectActorReference(target, path);
  expectActorAssociation(target, path, f.dir, 'implementation', 'repair');
  expect(await readFile(`${prefix}.prompt`, 'utf8')).toContain(`${prefix}.target.json`);
  expect(target.reviewReturn).toMatchObject({ previousRun: f.dir });
  expect(await records(f.dir)).toEqual(original);
  expect(f.calls.implementations).toBe(1);
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
});

testDevelopment('不正評価の停止後に旧actor原記録が変われば新runの検証を起動しない', async (f) => {
  const implementation = f.implement;
  let path = '';
  f.implement = async (...args) => {
    const response = await implementation(...args);
    assert(args[4]);
    path = await saveActorRecord(f.dir, args[4], 'repair', 'invalid-review');
    return response;
  };
  const t = await recoveryFixture(f);
  const record = object(JSON.parse(await readFile(path, 'utf8')));
  const runtime = object(record.runtime);
  // 同じ形式・role・prefixを保ち、観測値の内容だけを停止後に変えます。
  object(runtime.cli).version = { value: 'changed-after-stop', reason: null };
  await writeFile(path, JSON.stringify(record));
  const original = await records(f.dir);
  const executions = await readFile(t.executions, 'utf8');
  const outcome: unknown = await develop(t.args, f.io).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).toMatch(/runtime|actor|原記録/i);
  expect(String(outcome)).toMatch(/chang|hash|変更|変化|不一致/i);
  expect(await readFile(t.executions, 'utf8')).toBe(executions);
  expect(await records(f.dir)).toEqual(original);
  expect(f.calls.implementations).toBe(1);
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
});
