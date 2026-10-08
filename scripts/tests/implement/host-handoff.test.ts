import assert from 'node:assert/strict';
import { expect } from 'bun:test';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { develop } from '../../implement/orchestrator.ts';
import { run, snapshot } from '../../implement/correction.ts';
import { hash, hostReturnShape } from '../../implement/host-records.ts';
import { command } from '../../shared/process.ts';
import { testDevelopment, gitOutput, issue, ok } from '../support/development.ts';
import type { DevelopmentFixture } from '../support/development.ts';
import { object, reviewReplySource } from '../support/correction.ts';

const findings =
  'Run the agreed host measurement for current result.txt; configured check verifies local behavior only. Retain output and update the verification summary.';

async function prepareStop(
  f: DevelopmentFixture,
  stage: 'initial' | 'repair' = 'initial',
  localOnly = true,
) {
  if (localOnly) {
    f.args.push('--no-publish');
  }
  const implement = f.implement;
  if (stage === 'initial') {
    f.implement = async (...args) => {
      const result = await implement(...args);
      result.stdout = JSON.stringify({ status: 'needs_host', findings });
      await writeFile(`${args[4]}.stdout`, result.stdout);
      return result;
    };
  }
  f.verify = async (config) => {
    const script = join(dirname(f.dir), 'review.js');
    await writeFile(
      script,
      `
      import {readFileSync,existsSync,writeFileSync} from 'node:fs';
      const role=process.argv[2];
      ${reviewReplySource}
      if(role==='test') {
        const prompt=readFileSync(0,'utf8');
        const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);
        console.log(JSON.stringify({targetId:input.targetId,status:'unnecessary',findings:'既存の模擬検証で受入条件を確認できます。',files:[]}));
      }
      if(role==='repair') {
        writeFileSync('repair-note.md','Verification pending');
        console.log(JSON.stringify({status:'needs_host',findings:${JSON.stringify(findings)}}));
      }
      if(role==='review') {
        const complete=existsSync('verification.md') && !existsSync('host-pending.txt');
        if(complete && readFileSync('verification.md','utf8')!=='Host measurement passed; simulated evidence only.') process.exit(5);
        const target=JSON.parse(readFileSync(reviewContext.targetRecord,'utf8'));
        if(complete && !target.hostReturn) process.exit(6);
        console.log(JSON.stringify(reviewReply(complete?'accepted':'needs_changes',complete?'Measurement evidence inspected':'Required measurement missing')));
      }
    `,
    );
    const actual = {
      ...config,
      issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(issue)})`],
      review: [process.execPath, script, 'review'],
      repair: [process.execPath, script, 'repair'],
      test: [process.execPath, script, 'test'],
    };
    await writeFile(
      join(dirname(config.runDir), 'verification-config.json'),
      JSON.stringify(actual, null, 2),
    );
    return run(actual);
  };
  await assert.rejects(() => develop(f.args, f.io), /Host verification required/);
  const stopped = object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
  expect(stopped).toMatchObject({
    reasonCode: 'host_verification_required',
    status: 'stopped',
    publication: 'not_attempted',
  });
  expect(f.calls.reviews).toBe(stage === 'initial' ? 0 : 1);
  const cwd = join(f.dir, 'checkout');
  if (stage === 'repair') {
    const state = object(
      JSON.parse(await readFile(join(f.dir, 'verification/state.json'), 'utf8')),
    );
    expect(state).toMatchObject({ checks: 1, review: 1, repair: 1, source: await snapshot(cwd) });
  }
  return cwd;
}
async function measurement(f: DevelopmentFixture, cwd: string, previousRun = f.dir) {
  const prefix = join(dirname(f.dir), `${basename(previousRun)}-measurement`);
  const measured = await command(
    [process.execPath, '-e', "process.stdout.write('simulated measurement passed')"],
    cwd,
    '',
    1000,
    prefix,
  );
  expect(measured.code).toBe(0);
  await writeFile(
    join(cwd, 'verification.md'),
    'Host measurement passed; simulated evidence only.',
  );
  const evidence = {
    status: 'passed',
    source: await snapshot(cwd),
    findings: 'Compared current result.txt and updated the verification summary; simulation only.',
    logs: [{ path: `${prefix}.stdout`, sha256: hash(await readFile(`${prefix}.stdout`)) }],
  };
  const evidenceFile = `${prefix}.json`;
  await writeFile(evidenceFile, JSON.stringify(evidence));
  const dir = join(dirname(f.dir), `${basename(previousRun)}-return`);
  const args = [
    '99',
    '--repo',
    cwd,
    '--host-run',
    previousRun,
    '--host-evidence',
    evidenceFile,
    '--run-dir',
    dir,
    '--no-publish',
  ];
  return { evidence, evidenceFile, dir, args };
}
async function runRecords(dir: string): Promise<Record<string, string>> {
  const records: Record<string, string> = {};
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name === 'checkout') {
      continue;
    }
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      Object.assign(records, await runRecords(path));
    } else {
      records[path] = hash(await readFile(path));
    }
  }
  return records;
}

testDevelopment('初回テストのホスト支援後に新しい独立判定と初回実装を行う', async (f) => {
  f.args.push('--no-publish');
  const testFile = 'returned-result.test.js';
  const testSource =
    "import {readFileSync} from 'node:fs'; process.exit(readFileSync('result.txt','utf8')==='implemented'?0:1);\n";
  let stoppedWorkspace = '';
  f.test = async (_argv, cwd, prompt, _timeout, prefix) => {
    const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
    stoppedWorkspace = cwd;
    await writeFile(join(cwd, 'unfinished.test.js'), 'process.exit(1);\n');
    const response = ok(
      JSON.stringify({
        targetId: input.targetId,
        status: 'needs_host',
        findings: 'HOST_PRIVATE_TEST_360: ホストの模擬実行記録を確認して再判定してください。',
        files: ['unfinished.test.js'],
      }),
    );
    assert(prefix);
    await writeFile(`${prefix}.stdout`, response.stdout);
    await writeFile(`${prefix}.stderr`, 'ホスト支援が必要な工程の原診断');
    return response;
  };
  await assert.rejects(() => develop(f.args, f.io), /Host verification required|ホスト/i);
  expect(f.calls.tests).toBe(1);
  expect(f.calls.implementations).toBe(0);
  expect(f.calls.reviews).toBe(0);
  const cwd = join(f.dir, 'checkout');
  expect(await readFile(join(cwd, 'result.txt'), 'utf8')).toBe('old');
  expect(await Bun.file(join(cwd, 'unfinished.test.js')).exists()).toBe(false);
  const stoppedRecords = await runRecords(f.dir);
  const m = await measurement(f, cwd);
  f.test = async (...args) => {
    expect(args[1]).not.toBe(stoppedWorkspace);
    expect(await readFile(join(args[1], 'result.txt'), 'utf8')).toBe('old');
    expect(await Bun.file(join(args[1], 'unfinished.test.js')).exists()).toBe(false);
    expect(args[2]).not.toContain('HOST_PRIVATE_TEST_360');
    expect(args[2]).not.toContain('Implementation claim, not verification');
    const input = object(JSON.parse(args[2].split('入力: ')[1]?.split('\n')[0] ?? ''));
    await writeFile(join(args[1], testFile), testSource);
    const red = await command([process.execPath, testFile], args[1], '', 10000);
    expect(red.code).toBe(1);
    expect(red.stderr).toBe('');
    const response = ok(
      JSON.stringify({
        targetId: input.targetId,
        status: 'prepared',
        findings: '修正前oldでは終了1、要求したimplementedでは終了0。',
        files: [testFile],
      }),
    );
    assert(args[4]);
    await writeFile(`${args[4]}.stdout`, response.stdout);
    await writeFile(`${args[4]}.stderr`, '');
    return response;
  };
  const script = join(dirname(f.dir), 'returned-review.js');
  await writeFile(
    script,
    `
import {readFileSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
if(role==='repair') throw Error('初回実装後に不要な追加修正を実行しました');
if(role==='review') {
 if(readFileSync(${JSON.stringify(testFile)},'utf8')!==${JSON.stringify(testSource)}) process.exit(8);
 console.log(JSON.stringify(reviewReply('accepted','転送したテストと初回実装後の成果物を確認しました。')));
}
`,
  );
  f.verify = (config) =>
    run({
      ...config,
      issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(issue)})`],
      check: [process.execPath, testFile],
      review: [process.execPath, script, 'review'],
      repair: [process.execPath, script, 'repair'],
    });
  const result = await develop(m.args, f.io);
  expect(result.status).toBe('verified_local');
  const state = object(JSON.parse(await readFile(join(m.dir, 'verification/state.json'), 'utf8')));
  expect(state).toMatchObject({
    checks: 1,
    review: 1,
    repair: 0,
    result: 'ready_for_human_review',
  });
  expect(await readFile(join(cwd, testFile), 'utf8')).toBe(testSource);
  expect(f.calls.tests).toBe(2);
  expect(f.calls.implementations).toBe(1);
  expect(await readFile(join(cwd, 'result.txt'), 'utf8')).toBe('implemented');
  expect(await Bun.file(join(cwd, 'unfinished.test.js')).exists()).toBe(false);
  expect(await readFile(join(stoppedWorkspace, 'unfinished.test.js'), 'utf8')).toBe(
    'process.exit(1);\n',
  );
  expect(await runRecords(f.dir)).toEqual(stoppedRecords);
  expect(f.calls.pushes).toBe(0);
});

for (const changeExpectation of [false, true]) {
  testDevelopment(
    `ホスト復帰後の追加修正でも元のbaselineと期待値を保持する: 変更=${changeExpectation}`,
    async (f) => {
      const testFile = 'host-result.test.js';
      const testSource =
        "import {readFileSync} from 'node:fs'; process.exit(readFileSync('result.txt','utf8')==='implemented'?0:1);\n";
      f.test = async (_argv, cwd, prompt, _timeout, prefix) => {
        const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
        const prior = await Bun.file(join(cwd, testFile)).exists();
        if (!prior) {
          await writeFile(join(cwd, testFile), testSource);
        }
        const response = ok(
          JSON.stringify({
            targetId: input.targetId,
            status: prior ? 'unnecessary' : 'prepared',
            findings: '要求したimplementedを同じ期待値で確認します。',
            files: prior ? [] : [testFile],
          }),
        );
        assert(prefix);
        await writeFile(`${prefix}.stdout`, response.stdout);
        await writeFile(`${prefix}.stderr`, '');
        return response;
      };
      const cwd = await prepareStop(f, 'repair');
      expect(await readFile(join(cwd, testFile), 'utf8')).toBe(testSource);
      const original = await runRecords(f.dir);
      const m = await measurement(f, cwd);
      const script = join(dirname(f.dir), 'host-followup.js');
      const observations = join(dirname(f.dir), 'host-followup-tests.jsonl');
      await writeFile(
        script,
        `
import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
if(role==='test') {
 const prompt=readFileSync(0,'utf8');
 const input=JSON.parse(prompt.split('入力: ')[1].split('\\n')[0]);
 appendFileSync(${JSON.stringify(observations)},JSON.stringify({source:readFileSync('result.txt','utf8'),test:readFileSync(${JSON.stringify(testFile)},'utf8'),prompt})+'\\n');
 console.log(JSON.stringify({targetId:input.targetId,status:'unnecessary',findings:'元の要求期待値と既存検証を維持します。',files:[]}));
}
if(role==='repair') {
 writeFileSync('README.md','ホスト検証後の追加修正');
 if(${changeExpectation}) writeFileSync(${JSON.stringify(testFile)},'process.exit(0);\\n');
 console.log(JSON.stringify({status:'repaired',findings:'HOST_RETURN_IMPLEMENTATION_PRIVATE_360'}));
}
if(role==='review') console.log(JSON.stringify(reviewReply(existsSync('README.md')?'accepted':'needs_changes','要求した追加修正の有無を確認しました。')));
`,
      );
      f.verify = (config) =>
        run({
          ...config,
          issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(issue)})`],
          test: [process.execPath, script, 'test'],
          repair: [process.execPath, script, 'repair'],
          review: [process.execPath, script, 'review'],
        });
      const outcome: unknown = await develop(m.args, f.io).catch((error: unknown) => error);
      assert(await Bun.file(observations).exists(), String(outcome));
      const observed = (await readFile(observations, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => object(JSON.parse(line)));
      expect(observed).toHaveLength(1);
      expect(observed[0]?.source).toBe('old');
      expect(observed[0]?.test).toBe(testSource);
      expect(observed[0]?.prompt).not.toContain('HOST_RETURN_IMPLEMENTATION_PRIVATE_360');
      expect(observed[0]?.prompt).not.toContain('Required measurement missing');
      const state = object(
        JSON.parse(await readFile(join(m.dir, 'verification/state.json'), 'utf8')),
      );
      if (changeExpectation) {
        expect(outcome).toBeInstanceOf(Error);
        expect(state.result).not.toBe('ready_for_human_review');
        expect(state.review).toBe(1);
        expect(state.findings).toMatch(/test|テスト|期待値/i);
        expect(await readFile(join(cwd, testFile), 'utf8')).toBe('process.exit(0);\n');
      } else {
        expect(outcome).toMatchObject({ status: 'verified_local' });
        expect(state.result).toBe('ready_for_human_review');
        expect(state.review).toBe(2);
        expect(await readFile(join(cwd, testFile), 'utf8')).toBe(testSource);
      }
      expect(await runRecords(f.dir)).toEqual(original);
      expect(f.calls.pushes).toBe(0);
    },
  );
}

testDevelopment(
  '復帰後の追加変更で必要なホスト測定が失効したら新しい独立評価で支援へ戻る',
  async (f) => {
    const cwd = await prepareStop(f, 'repair');
    const original = await runRecords(f.dir);
    const m = await measurement(f, cwd);
    const script = join(dirname(f.dir), 'invalidated-host-review.js');
    await writeFile(
      script,
      `
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
if(role==='test') {
 const input=JSON.parse(readFileSync(0,'utf8').split('入力: ')[1].split('\\n')[0]);
 console.log(JSON.stringify({targetId:input.targetId,status:'unnecessary',findings:'既存checkを維持します。',files:[]}));
}
if(role==='review') console.log(JSON.stringify(reviewReply('needs_changes',existsSync('host-pending.txt')?'追加変更後のホスト測定が必要です。':'追加変更が必要です。')));
if(role==='repair') {
 if(existsSync('host-pending.txt')) console.log(JSON.stringify({status:'needs_host',findings:'追加変更後の版をホストで再測定してください。'}));
 else {writeFileSync('host-pending.txt','追加変更によって必要な測定が失効'); console.log(JSON.stringify({status:'repaired',findings:'追加変更を完了しました。'}));}
}
`,
    );
    f.verify = (config) =>
      run({
        ...config,
        issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(issue)})`],
        test: [process.execPath, script, 'test'],
        review: [process.execPath, script, 'review'],
        repair: [process.execPath, script, 'repair'],
      });
    await assert.rejects(() => develop(m.args, f.io), /Host verification required/);
    const state = object(
      JSON.parse(await readFile(join(m.dir, 'verification/state.json'), 'utf8')),
    );
    expect(state).toMatchObject({
      checks: 2,
      review: 2,
      repair: 2,
      result: 'host_verification_required',
    });
    const stopped = object(JSON.parse(await readFile(join(m.dir, 'result.json'), 'utf8')));
    expect(stopped).toMatchObject({
      status: 'stopped',
      publication: 'not_attempted',
      reasonCode: 'host_verification_required',
    });
    expect(await readFile(join(cwd, 'host-pending.txt'), 'utf8')).toContain('失効');
    expect(await runRecords(f.dir)).toEqual(original);
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
  },
);

for (const ignored of [false, true]) {
  testDevelopment(`ローカル設定でホスト検証後に再評価する: 除外=${ignored}`, async (f) => {
    await gitOutput(f.repo, 'rm', '--cached', '.dotagents.json');
    await gitOutput(f.repo, 'commit', '-m', 'local configuration');
    if (ignored) {
      await writeFile(join(f.repo, '.git/info/exclude'), '/.dotagents.json\n');
    }
    const cwd = await prepareStop(f, ignored ? 'repair' : 'initial');
    const text = await readFile(join(cwd, '.dotagents.json'), 'utf8');
    const records = await runRecords(f.dir);
    const m = await measurement(f, cwd);
    const result = await develop(m.args, f.io);
    expect(result.status).toBe('verified_local');
    expect(await readFile(join(cwd, '.dotagents.json'), 'utf8')).toBe(text);
    expect(JSON.parse(await readFile(join(m.dir, 'target.json'), 'utf8'))).toMatchObject({ text });
    expect(await gitOutput(cwd, 'ls-tree', 'HEAD', '--', '.dotagents.json')).toBe('');
    expect(await runRecords(f.dir)).toEqual(records);
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.implementations).toBe(1);
  });
}

for (const stage of ['initial', 'repair'] as const) {
  testDevelopment(
    `host ${stage} handoff returns current work to fresh check and review`,
    async (f) => {
      const base = await gitOutput(f.repo, 'rev-parse', 'HEAD');
      let handoff = false;
      let targetReads = 0;
      const command = f.io.command;
      f.io.command = async (...args) => {
        const [argv] = args;
        if (handoff && argv[0] === 'gh' && argv[1] === 'api' && argv[2] === 'user') {
          targetReads++;
        }
        const result = await command(...args);
        if (stage === 'initial' && argv[1]?.endsWith('/codex-actor.ts') && argv[2] === 'repair') {
          handoff = true;
        }
        return result;
      };
      const verify = f.io.verify;
      f.io.verify = async (config) => {
        const state = await verify(config);
        handoff = true;
        return state;
      };
      const cwd = await prepareStop(f, stage);
      expect(targetReads).toBe(1);
      handoff = false;
      const original = await runRecords(f.dir);
      const m = await measurement(f, cwd);
      const result = await develop(m.args, f.io);
      expect(result.status).toBe('verified_local');
      expect(f.calls.implementations).toBe(1);
      expect(await gitOutput(cwd, 'rev-parse', 'HEAD')).toBe(base);
      expect(await gitOutput(cwd, 'status', '--porcelain')).toContain('verification.md');
      expect(await readFile(join(cwd, 'result.txt'), 'utf8')).toBe('implemented');
      const state = object(
        JSON.parse(await readFile(join(m.dir, 'verification/state.json'), 'utf8')),
      );
      expect(state).toMatchObject({
        baseCommit: base,
        checks: 1,
        review: 1,
        repair: 0,
        result: 'ready_for_human_review',
      });
      const target = object(
        JSON.parse(await readFile(join(m.dir, 'verification/review-1.target.json'), 'utf8')),
      );
      expect(target.baseCommit).toBe(base);
      expect(object(target.hostReturn).previousRun).toBe(f.dir);
      if (stage === 'repair') {
        const returned = hostReturnShape.parse(target.hostReturn);
        for (const name of ['review-1.json', 'state.json', 'repair-1.stdout']) {
          const ref = returned.records.find(
            (ref) => ref.path === join(f.dir, 'verification', name),
          );
          assert(ref);
          expect(hash(await readFile(ref.path))).toBe(ref.sha256);
        }
        expect(await readFile(join(f.dir, 'verification/review-1.json'), 'utf8')).toContain(
          'Required measurement missing',
        );
      }
      expect(await readFile(join(m.dir, 'verification/review-1.diff'), 'utf8')).toContain(
        '+implemented',
      );
      expect(await runRecords(f.dir)).toEqual(original);
      expect(f.calls.publications).toBe(0);
      expect(f.calls.pushes).toBe(0);
      await assert.rejects(() => develop(m.args, f.io), /EEXIST/);
      expect(await runRecords(f.dir)).toEqual(original);
    },
  );
}

testDevelopment(
  'repeated host return redacts all prior runs and evidence from publication',
  async (f) => {
    const cwd = await prepareStop(f, 'repair', false);
    const original = await runRecords(f.dir);
    await writeFile(join(cwd, 'host-pending.txt'), 'Additional host measurement required');
    const first = await measurement(f, cwd);
    first.args.pop();
    await assert.rejects(() => develop(first.args, f.io), /Host verification required/);
    expect(f.calls.publications).toBe(0);
    expect(f.calls.pushes).toBe(0);
    const stopped = object(JSON.parse(await readFile(join(first.dir, 'result.json'), 'utf8')));
    expect(stopped).toMatchObject({
      reasonCode: 'host_verification_required',
      publication: 'not_attempted',
    });
    const returned = await runRecords(first.dir);
    await rm(join(cwd, 'host-pending.txt'));
    const m = await measurement(f, cwd, first.dir);
    m.args.pop();
    const verify = f.verify;
    const paths = [
      join(f.dir, 'verification/check-1.stdout'),
      first.evidenceFile,
      first.evidence.logs[0]?.path,
      join(first.dir, 'verification/check-1.stdout'),
      m.evidenceFile,
      m.evidence.logs[0]?.path,
    ];
    f.verify = async (config) => {
      const state = await verify(config);
      const review = state.reviewHistory.at(-1);
      assert(review);
      review.assessments.tests = `測定結果を確認。${paths.join('、')}。実サービスは未確認。/home/settings と https://example.com/results を保持。`;
      return state;
    };
    f.publish = async (input) => {
      expect(input.cwd).toBe(cwd);
      expect(input.bodyFile).toBe(join(m.dir, 'pr.md'));
      const body = await readFile(input.bodyFile, 'utf8');
      for (const path of paths) {
        assert(path);
        expect(body).not.toContain(path);
      }
      for (const text of [
        '測定結果を確認。',
        '実サービスは未確認。',
        '/home/settings',
        'https://example.com/results',
      ]) {
        expect(body).toContain(text);
      }
      return `https://github.com/${f.settings.repository}/pull/100`;
    };
    expect((await develop(m.args, f.io)).status).toBe('published_draft');
    expect(f.calls.publications).toBe(1);
    expect(f.calls.implementations).toBe(1);
    expect(await runRecords(f.dir)).toEqual(original);
    expect(await runRecords(first.dir)).toEqual(returned);
  },
);

for (const boundary of ['return', 'publication'] as const) {
  for (const damaged of ['record', 'log'] as const) {
    testDevelopment(
      `repeated host return rejects ancestor ${damaged} at ${boundary}`,
      async (f) => {
        const cwd = await prepareStop(f, 'repair', false);
        const head = await gitOutput(cwd, 'rev-parse', 'HEAD');
        await writeFile(join(cwd, 'host-pending.txt'), 'Additional host measurement required');
        const first = await measurement(f, cwd);
        first.args.pop();
        await assert.rejects(() => develop(first.args, f.io), /Host verification required/);
        await rm(join(cwd, 'host-pending.txt'));
        const m = await measurement(f, cwd, first.dir);
        m.args.pop();
        f.publish = async () => `https://github.com/${f.settings.repository}/pull/100`;
        const ancestorPath =
          damaged === 'record'
            ? join(f.dir, 'verification/review-1.json')
            : first.evidence.logs[0]?.path;
        assert(ancestorPath);
        const reason = damaged === 'record' ? /ENOENT/ : /Host verification evidence changed/;
        const damage = () =>
          damaged === 'record'
            ? rm(ancestorPath)
            : writeFile(ancestorPath, 'changed ancestor measurement');
        let ancestorRecords: Record<string, string>;
        if (boundary === 'return') {
          await damage();
          ancestorRecords = await runRecords(f.dir);
        } else {
          ancestorRecords = await runRecords(f.dir);
          const verify = f.verify;
          let changed = false;
          f.verify = async (config) => {
            const state = await verify(config);
            expect(state.result).toBe('ready_for_human_review');
            if (!changed) {
              await damage();
              changed = true;
              ancestorRecords = await runRecords(f.dir);
            }
            return state;
          };
        }
        const previousRecords = await runRecords(first.dir);
        await assert.rejects(() => develop(m.args, f.io), reason);
        const result = object(JSON.parse(await readFile(join(m.dir, 'result.json'), 'utf8')));
        expect(result).toMatchObject({ status: 'stopped', publication: 'not_attempted' });
        expect(result.reason).toMatch(reason);
        expect(result.reason).toContain(ancestorPath);
        expect(await readFile(join(m.dir, 'host-return.json'), 'utf8')).toContain(first.dir);
        if (boundary === 'return') {
          const files = await readdir(join(m.dir, 'verification'));
          expect(files.filter((name) => /^(check|review|repair)-\d/.test(name))).toEqual([]);
        } else {
          const state = object(
            JSON.parse(await readFile(join(m.dir, 'verification/state.json'), 'utf8')),
          );
          expect(state).toMatchObject({ checks: 1, review: 1, repair: 0 });
        }
        expect(await gitOutput(cwd, 'rev-parse', 'HEAD')).toBe(head);
        expect(await gitOutput(cwd, 'status', '--porcelain')).toContain('verification.md');
        expect(await runRecords(f.dir)).toEqual(ancestorRecords);
        expect(await runRecords(first.dir)).toEqual(previousRecords);
        expect(f.calls.implementations).toBe(1);
        expect(f.calls.publications).toBe(0);
        expect(f.calls.pushes).toBe(0);
      },
    );
  }
}

for (const mode of [
  'failed',
  'unavailable',
  'missing_log',
  'stale_source',
  'setup_source',
  'setup_log',
  'issue',
  'actor',
  'permission',
  'head',
  'tampered_stop',
  'expanded_authority',
] as const) {
  testDevelopment(`host return rejects ${mode} without acceptance or publication`, async (f) => {
    const cwd = await prepareStop(f, 'initial', mode !== 'permission');
    const m = await measurement(f, cwd);
    if (mode === 'permission') {
      m.args.pop();
    }
    let reason: RegExp;
    if (mode === 'failed' || mode === 'unavailable') {
      m.evidence.status = mode;
      await writeFile(m.evidenceFile, JSON.stringify(m.evidence));
      reason = /Host verification (failed|unavailable)/;
    } else if (mode === 'missing_log') {
      m.evidence.logs[0] = { path: join(dirname(f.dir), 'missing.log'), sha256: hash('missing') };
      await writeFile(m.evidenceFile, JSON.stringify(m.evidence));
      reason = /ENOENT/;
    } else if (mode === 'stale_source') {
      await writeFile(join(cwd, 'result.txt'), 'unmeasured revision');
      reason = /Host evidence does not match/;
    } else if (mode === 'setup_source' || mode === 'setup_log') {
      const localCommand = f.localCommand;
      f.localCommand = async (...args) => {
        const result = await localCommand(...args);
        if (args[0][0] === 'sh') {
          const log = m.evidence.logs[0];
          assert(log);
          await writeFile(
            mode === 'setup_source' ? join(cwd, 'result.txt') : log.path,
            'changed during setup',
          );
        }
        return result;
      };
      reason = mode === 'setup_source' ? /Host evidence does not match/ : /evidence changed/;
    } else if (mode === 'head') {
      await gitOutput(cwd, 'commit', '--allow-empty', '-m', 'different HEAD');
      reason = /Host handoff HEAD changed/;
    } else if (mode === 'tampered_stop') {
      await writeFile(join(f.dir, 'implementation.stdout'), 'changed response');
      reason = /evidence changed/;
    } else if (mode === 'expanded_authority') {
      m.args.pop();
      reason = /expand publication authority/;
    } else {
      const github = f.github;
      f.github = async (argv, ...args) => {
        if (mode === 'issue' && argv[1] === 'issue') {
          return ok(issue.replace('Show the requested result.', 'Changed requirements.'));
        }
        if (mode === 'actor' && argv[2] === 'user') {
          return ok(JSON.stringify({ login: 'someone-else' }));
        }
        if (mode === 'permission' && argv[2] === `repos/${f.settings.repository}`) {
          const response = await github(argv, ...args);
          return { ...response, stdout: response.stdout.replace('"push":true', '"push":false') };
        }
        return github(argv, ...args);
      };
      reason = {
        issue: /Agreed Issue changed/,
        actor: /target or actor changed/,
        permission: /permission|push/i,
      }[mode];
    }
    const original = await runRecords(f.dir);
    await assert.rejects(() => develop(m.args, f.io), reason);
    expect(f.calls.implementations).toBe(1);
    expect(f.calls.publications).toBe(0);
    expect(f.calls.pushes).toBe(0);
    expect(await runRecords(f.dir)).toEqual(original);
    if (['failed', 'unavailable', 'setup_source', 'setup_log'].includes(mode)) {
      // The verifier is entered, but rejects evidence before check or actor execution.
      const files = await readdir(join(m.dir, 'verification'));
      expect(files.filter((name) => /^(check|review|repair)-\d/.test(name))).toEqual([]);
      expect(object(JSON.parse(await readFile(join(m.dir, 'result.json'), 'utf8'))).status).toBe(
        'stopped',
      );
      expect(await readFile(join(m.dir, 'host-return.json'), 'utf8')).toContain(m.evidenceFile);
    } else {
      expect(f.calls.reviews).toBe(0);
    }
  });
}

testDevelopment('passed host evidence still requires independent acceptance', async (f) => {
  const cwd = await prepareStop(f, 'repair');
  const before = await runRecords(f.dir);
  const m = await measurement(f, cwd);
  await rm(join(cwd, 'verification.md'));
  m.evidence.source = await snapshot(cwd);
  await writeFile(m.evidenceFile, JSON.stringify(m.evidence));
  await assert.rejects(() => develop(m.args, f.io), /Host verification required/);
  const state = object(JSON.parse(await readFile(join(m.dir, 'verification/state.json'), 'utf8')));
  expect(state).toMatchObject({
    checks: 1,
    review: 1,
    repair: 1,
    result: 'host_verification_required',
  });
  expect(f.calls.publications).toBe(0);
  expect(await runRecords(f.dir)).toEqual(before);
});

testDevelopment('changed external evidence during check cannot reach review', async (f) => {
  const cwd = await prepareStop(f);
  const m = await measurement(f, cwd);
  const verify = f.verify;
  const log = m.evidence.logs[0];
  assert(log);
  f.verify = (config) =>
    verify({
      ...config,
      check: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(log.path)},'changed evidence')`,
      ],
    });
  await assert.rejects(() => develop(m.args, f.io), /Host verification evidence changed/);
  const state = object(JSON.parse(await readFile(join(m.dir, 'verification/state.json'), 'utf8')));
  expect(state).toMatchObject({
    checks: 1,
    review: 0,
    repair: 0,
    reviewHistory: [],
    result: 'host_evidence_changed',
  });
  const failedRecords = await runRecords(m.dir);
  f.verify = verify;
  const newLog = join(dirname(f.dir), 'new-measurement.stdout');
  await writeFile(newLog, 'new simulated verification passed');
  const newEvidence = join(dirname(f.dir), 'new-evidence.json');
  await writeFile(
    newEvidence,
    JSON.stringify({
      ...m.evidence,
      logs: [{ path: newLog, sha256: hash(await readFile(newLog)) }],
    }),
  );
  const args = [...m.args];
  args[args.indexOf('--host-evidence') + 1] = newEvidence;
  args[args.indexOf('--run-dir') + 1] = join(dirname(f.dir), 'fresh-return');
  expect((await develop(args, f.io)).status).toBe('verified_local');
  expect(await runRecords(m.dir)).toEqual(failedRecords);
  expect(f.calls.publications).toBe(0);
});

testDevelopment('ホスト復帰の版記録がcheck中に変わったらreviewと公開を止める', async (f) => {
  const normalTest = f.test;
  const normalImplement = f.implement;
  f.test = async (_argv, _cwd, prompt, _timeout, prefix) => {
    const input = object(JSON.parse(prompt.split('入力: ')[1]?.split('\n')[0] ?? ''));
    const response = ok(
      JSON.stringify({
        targetId: input.targetId,
        status: 'needs_host',
        findings: 'ホスト測定後に要求から独立してテストの要否を再判定します。',
        files: [],
      }),
    );
    assert(prefix);
    await writeFile(`${prefix}.stdout`, response.stdout);
    await writeFile(`${prefix}.stderr`, '');
    return response;
  };
  const cwd = await prepareStop(f, 'initial', false);
  const original = await runRecords(f.dir);
  const m = await measurement(f, cwd);
  m.args.pop();
  f.test = normalTest;
  f.implement = normalImplement;
  const verify = f.verify;
  const preparationPath = join(m.dir, 'host-preparation.json');
  let preparationBefore = '';
  let changedPreparation = '';
  f.verify = async (config) => {
    preparationBefore = await readFile(preparationPath, 'utf8');
    expect(config.hostPreparation).toEqual({
      path: preparationPath,
      sha256: hash(preparationBefore),
    });
    const preparation = object(JSON.parse(preparationBefore));
    expect(preparation.sourceBefore).toBe(m.evidence.source);
    expect(preparation.sourceAfterTests).toBe(preparation.sourceBefore);
    expect(preparation.sourceAfter).toBe(await snapshot(cwd));
    expect(preparation.sourceAfter).not.toBe(preparation.sourceBefore);
    changedPreparation = JSON.stringify({
      ...preparation,
      sourceAfterTests: 'changed during check',
    });
    return verify({
      ...config,
      check: [
        process.execPath,
        '-e',
        `const fs=require('node:fs'); if(fs.readFileSync('result.txt','utf8')!=='implemented'||fs.readFileSync('setup.txt','utf8')!=='configured')process.exit(1); fs.writeFileSync(${JSON.stringify(preparationPath)},${JSON.stringify(changedPreparation)});`,
      ],
    });
  };
  const outcome: unknown = await develop(m.args, f.io).catch((error: unknown) => error);
  const state = object(JSON.parse(await readFile(join(m.dir, 'verification/state.json'), 'utf8')));
  expect(state).toMatchObject({
    checks: 1,
    review: 0,
    repair: 0,
    reviewHistory: [],
    result: 'host_evidence_changed',
  });
  expect(outcome).toBeInstanceOf(Error);
  expect(state.findings).toContain(preparationPath);
  const result = object(JSON.parse(await readFile(join(m.dir, 'result.json'), 'utf8')));
  expect(result).toMatchObject({ status: 'stopped', publication: 'not_attempted' });
  expect(await readFile(preparationPath, 'utf8')).toBe(changedPreparation);
  const savedConfig = object(
    JSON.parse(await readFile(join(m.dir, 'verification-config.json'), 'utf8')),
  );
  expect(savedConfig.hostPreparation).toEqual({
    path: preparationPath,
    sha256: hash(preparationBefore),
  });
  expect(await runRecords(f.dir)).toEqual(original);
  expect(await readFile(join(cwd, 'result.txt'), 'utf8')).toBe('implemented');
  expect(await gitOutput(cwd, 'status', '--porcelain')).toContain('verification.md');
  expect(f.calls.implementations).toBe(1);
  expect(f.calls.publications).toBe(0);
  expect(f.calls.pushes).toBe(0);
});
