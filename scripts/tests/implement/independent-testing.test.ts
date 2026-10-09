import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { develop } from '../../implement/orchestrator.ts';
import { isRecord } from '../../shared/values.ts';
import { gitOutput, ok, testDevelopment } from '../support/development.ts';
import { command } from '../../shared/process.ts';
import { correctionFixture, events, object, reviewReplySource } from '../support/correction.ts';
import { run } from '../../implement/correction.ts';
import { aggregateUsage } from '../../implement/usage.ts';
import { randomUUID } from 'node:crypto';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

function testInput(prompt: string) {
  const match = prompt.match(/入力: (\{[^\n]+\})/);
  assert(match?.[1], 'テスト作成入力が必要');
  const value: unknown = JSON.parse(match[1]);
  assert(isRecord(value) && typeof value.targetId === 'string');
  return { ...value, targetId: value.targetId };
}

testDevelopment('不要な独立テスト判定でも正常にローカル検証を完了する', async (f) => {
  f.args.push('--no-publish');
  const prepare = f.test;
  f.test = async (...args) => {
    expect(args[1]).not.toBe(join(f.dir, 'checkout'));
    expect(await readFile(join(args[1], 'result.txt'), 'utf8')).toBe('old');
    expect(args[2]).toContain('Show the requested result.');
    expect(args[2]).not.toContain('Implementation claim, not verification');
    expect(args[2]).not.toContain('RAW_LOG_ONLY');
    return prepare(...args);
  };
  const result = await develop(f.args, f.io);
  expect(result.status).toBe('verified_local');
  expect(f.calls.tests).toBe(1);
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
  expect(await readFile(join(result.checkout, 'result.txt'), 'utf8')).toBe('implemented');
});

testDevelopment('修正前snapshotで相対symlinkを通常ファイルに変えず保持する', async (f) => {
  f.args.push('--no-publish');
  await symlink('result.txt', join(f.repo, 'result-link.txt'));
  await gitOutput(f.repo, 'add', 'result-link.txt');
  await gitOutput(f.repo, 'commit', '-m', '相対symlinkの試験入力');
  const prepare = f.test;
  f.test = async (...args) => {
    const path = join(args[1], 'result-link.txt');
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readlink(path)).toBe('result.txt');
    expect(await readFile(path, 'utf8')).toBe('old');
    return prepare(...args);
  };
  const result = await develop(f.args, f.io);
  expect(result.status).toBe('verified_local');
  const path = join(result.checkout, 'result-link.txt');
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(await readlink(path)).toBe('result.txt');
  expect(await readFile(path, 'utf8')).toBe('implemented');
});

testDevelopment('独立した期待値を修正前の失敗から実装後の成功まで受け渡す', async (f) => {
  f.args.push('--no-publish');
  const testFile = 'result.test.js';
  const testSource = `import {readFileSync} from 'node:fs';
const result=readFileSync('result.txt','utf8');
console.log('要求期待値: implemented; 実際: '+result);
process.exit(result==='implemented'?0:1);
`;
  let baseline = '';
  f.test = async (_argv, cwd, prompt, _timeout, prefix) => {
    baseline = cwd;
    const context = testInput(prompt);
    expect(cwd).not.toBe(join(f.dir, 'checkout'));
    expect(await readFile(join(cwd, 'result.txt'), 'utf8')).toBe('old');
    expect(prompt).not.toContain('Implementation claim, not verification');
    await writeFile(join(cwd, testFile), testSource);
    const red = await command([process.execPath, testFile], cwd, '', 10000);
    expect(red.code).toBe(1);
    expect(red.stdout).toContain('要求期待値: implemented; 実際: old');
    expect(red.stderr).toBe('');
    const response = ok(
      JSON.stringify({
        targetId: context.targetId,
        status: 'prepared',
        findings:
          '既存checkに加え、作成成果物の転送と同じ期待値の保持を確認します。修正前は要求期待値との差で終了1です。',
        files: [testFile],
      }),
    );
    assert(prefix);
    await writeFile(`${prefix}.stdout`, response.stdout);
    await writeFile(`${prefix}.stderr`, '');
    return response;
  };
  const verify = f.verify;
  f.verify = async (config) => {
    expect(config.cwd).not.toBe(baseline);
    expect(await readFile(join(config.cwd, testFile), 'utf8')).toBe(testSource);
    const green = await command([process.execPath, testFile], config.cwd, '', 10000);
    expect(green.code).toBe(0);
    expect(green.stdout).toContain('要求期待値: implemented; 実際: implemented');
    return verify(config);
  };
  const result = await develop(f.args, f.io);
  expect(result.status).toBe('verified_local');
  expect(f.calls.tests).toBe(1);
  expect(f.calls.pushes).toBe(0);
  expect(await readFile(join(result.checkout, testFile), 'utf8')).toBe(testSource);
});

testDevelopment('新規テスト成果物symlinkを転送前に拒否して原応答とworkspaceを保つ', async (f) => {
  const testFile = 'result.test.js';
  let workspace = '';
  let originalResponse = '';
  let responsePrefix = '';
  f.test = async (_argv, cwd, prompt, _timeout, prefix) => {
    const context = testInput(prompt);
    workspace = cwd;
    await symlink('result.txt', join(cwd, testFile));
    originalResponse = JSON.stringify({
      targetId: context.targetId,
      status: 'prepared',
      findings: '正常prepared応答と同じ対象で、新規成果物の種類だけをsymlinkにした試験です。',
      files: [testFile],
    });
    assert(prefix);
    responsePrefix = prefix;
    await writeFile(`${prefix}.stdout`, originalResponse);
    await writeFile(`${prefix}.stderr`, '成果物種類の試験診断');
    return ok(originalResponse);
  };
  const outcome: unknown = await develop(f.args, f.io).catch((error: unknown) => error);
  expect(f.calls.tests).toBe(1);
  expect(outcome).toBeInstanceOf(Error);
  const saved: unknown = JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8'));
  assert(isRecord(saved));
  expect(saved.status).toBe('stopped');
  expect(saved.publication).toBe('not_attempted');
  expect(saved.reason).toMatch(/symlink|symbolic|シンボリック|通常ファイル/i);
  expect(f.calls.implementations).toBe(0);
  expect(f.calls.verificationEntries).toBe(0);
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
  expect(await Bun.file(join(f.dir, 'checkout', testFile)).exists()).toBe(false);
  expect(await readFile(`${responsePrefix}.stdout`, 'utf8')).toBe(originalResponse);
  expect(await readFile(`${responsePrefix}.stderr`, 'utf8')).toBe('成果物種類の試験診断');
  expect((await lstat(join(workspace, testFile))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(workspace, testFile))).toBe('result.txt');
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('old');
});

testDevelopment('形が正しい独立テスト応答でも対象不一致なら公開を止める', async (f) => {
  f.test = async (_argv, _cwd, prompt, _timeout, prefix) => {
    const context = testInput(prompt);
    const response = ok(
      JSON.stringify({
        targetId: `${context.targetId}-different`,
        status: 'unnecessary',
        findings: '正常な形のまま対象IDだけを変えた試験入力です。',
        files: [],
      }),
    );
    assert(prefix);
    await writeFile(`${prefix}.stdout`, response.stdout);
    await writeFile(`${prefix}.stderr`, '');
    return response;
  };
  const outcome: unknown = await develop(f.args, f.io).catch((error: unknown) => error);
  expect(f.calls.tests).toBe(1);
  expect(outcome).toBeInstanceOf(Error);
  const saved: unknown = JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8'));
  assert(isRecord(saved));
  expect(saved.status).toBe('stopped');
  expect(saved.publication).toBe('not_attempted');
  expect(saved.reason).toMatch(/target|対象|入力/i);
  expect(f.calls.verificationEntries).toBe(0);
  expect(f.calls.pushes).toBe(0);
  expect(f.calls.publications).toBe(0);
});

// Issue #360の停止条件。schema拒否は対象・status・成果物を正常にし、findingsだけ欠落させる。
for (const failure of ['command_failure', 'invalid_json', 'invalid_response'] as const) {
  testDevelopment(`独立テスト工程の${failure}で公開を止め原記録を保つ`, async (f) => {
    const execute = f.io.command;
    const retained: { stdout: string; stderr: string; prefix: string; cwd: string }[] = [];
    const originalHead = await gitOutput(f.repo, 'rev-parse', 'HEAD');
    f.io.command = async (argv, cwd, input, timeout, prefix) => {
      // 既存の実装actor・Git・setup・GitHub照合は正常にする。
      // 独立評価は既存のverify境界で正常応答を返すため、ここでは新しい作成工程だけを観測する。
      if (['git', 'sh', 'gh'].includes(argv[0] ?? '') || argv[2] === 'repair') {
        return execute(argv, cwd, input, timeout, prefix);
      }
      assert(prefix, '独立テスト工程の原ログ保存先が必要');
      const context = testInput(input);
      await writeFile(join(cwd, 'pending.test.js'), 'process.exit(1);\n');
      const stdout =
        failure === 'invalid_json'
          ? '{broken-test-response'
          : failure === 'invalid_response'
            ? JSON.stringify({
                targetId: context.targetId,
                status: 'prepared',
                files: ['pending.test.js'],
              })
            : '{}';
      const stderr = `独立テスト工程の試験診断: ${failure}`;
      retained.push({ stdout, stderr, prefix, cwd });
      await writeFile(`${prefix}.stdout`, stdout);
      await writeFile(`${prefix}.stderr`, stderr);
      return { ...ok(stdout), stderr, code: failure === 'command_failure' ? 7 : 0 };
    };

    const outcome: unknown = await develop(f.args, f.io).catch((error: unknown) => error);
    expect(retained.length).toBeGreaterThan(0);
    expect(outcome).toBeInstanceOf(Error);
    const saved: unknown = JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8'));
    assert(isRecord(saved));
    expect(saved.status).toBe('stopped');
    expect(saved.publication).toBe('not_attempted');
    expect(saved.reason).toBeTruthy();
    if (failure === 'command_failure') {
      expect(saved.reason).toContain(`独立テスト工程の試験診断: ${failure}`);
    }
    if (failure === 'invalid_response') {
      expect(saved.reason).toMatch(/findings/);
      expect(saved.reason).not.toMatch(/テスト応答の入力が一致しません/);
    }
    expect(f.calls.implementations).toBe(0);
    expect(await Bun.file(join(f.dir, 'checkout/pending.test.js')).exists()).toBe(false);
    for (const log of retained) {
      expect(await readFile(join(log.cwd, 'pending.test.js'), 'utf8')).toBe('process.exit(1);\n');
    }
    expect(saved.nextAction).toBeTruthy();
    expect(saved.evidence).toBe(f.dir);
    expect(saved.issue).toContain('/issues/99');
    expect(f.calls.verificationEntries).toBe(0);
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
    expect(f.calls.attachments).toBe(0);
    for (const log of retained) {
      expect(await readFile(`${log.prefix}.stdout`, 'utf8')).toBe(log.stdout);
      expect(await readFile(`${log.prefix}.stderr`, 'utf8')).toBe(log.stderr);
    }
    expect(await gitOutput(f.repo, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(await readFile(join(f.repo, 'result.txt'), 'utf8')).toBe('old');
    if (f.calls.implementations > 0) {
      expect(await readFile(join(f.dir, 'checkout/result.txt'), 'utf8')).toBe('implemented');
    }
  });
}

for (const changeExpectation of [false, true]) {
  test(`追加修正でも独立作成を再実行し期待値変更を止める: 変更=${changeExpectation}`, async () => {
    const t = await trial('docs');
    const baseline = join(t.root, 'test-baseline');
    const actor = join(t.root, 'test-actor.js');
    const observations = join(t.root, 'test-observations.jsonl');
    const testFile = 'source.test.js';
    const testSource =
      "import {readFileSync} from 'node:fs'; process.exit(readFileSync('source.txt','utf8')==='correct'?0:1);\n";
    await writeFile(
      actor,
      `
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
const prompt=readFileSync(0,'utf8');
const match=prompt.match(/入力: (\\{[^\\n]+\\})/);
if(!match) throw Error('テスト作成入力が必要');
const input=JSON.parse(match[1]);
const prior=existsSync(${JSON.stringify(testFile)});
appendFileSync(${JSON.stringify(observations)},JSON.stringify({cwd:process.cwd(),source:readFileSync('source.txt','utf8'),docs:existsSync('README.md'),prior,prompt})+'\\n');
if(!prior) writeFileSync(${JSON.stringify(testFile)},${JSON.stringify(testSource)});
console.log(JSON.stringify({targetId:input.targetId,status:prior?'unnecessary':'prepared',findings:'修正前のsourceがbrokenなら終了1、要求どおりcorrectなら終了0となる期待値を保持します。',files:prior?[]:[${JSON.stringify(testFile)}]}));
`,
    );
    const helper = join(t.root, 'helper.js');
    const original = await readFile(helper, 'utf8');
    const insertion = changeExpectation
      ? `if(existsSync(${JSON.stringify(testFile)})) writeFileSync(${JSON.stringify(testFile)},'process.exit(0);\\n');`
      : '';
    await writeFile(
      helper,
      original.replace(
        "console.log(JSON.stringify({status:'repaired',findings:'fixed'}));",
        `${insertion}\nconsole.log(JSON.stringify({status:'repaired',findings:'IMPLEMENTATION_PRIVATE_360'}));`,
      ),
    );
    t.config.test = [process.execPath, actor];
    t.config.testBaseline = baseline;
    await writeFile(t.configFile, JSON.stringify(t.config));
    const result = t.execute();
    expect(result.error).toBeUndefined();
    assert(result.stdout.trim(), result.stderr);
    const state = await t.state();
    const observed = (await readFile(observations, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => object(JSON.parse(line)));
    expect(observed.length).toBeGreaterThan(0);
    for (const observation of observed) {
      expect(observation.cwd).not.toBe(t.config.cwd);
      expect(observation.source).toBe('broken');
      expect(observation.docs).toBe(false);
      expect(observation.prompt).not.toContain('IMPLEMENTATION_PRIVATE_360');
      expect(observation.prompt).not.toContain('README missing');
    }
    if (changeExpectation) {
      expect(result.status).toBe(1);
      expect(state.result).not.toBe('ready_for_human_review');
      expect(state.findings).toMatch(/test|テスト|期待値/i);
      expect(state.review).toBe(0);
      expect(await readFile(join(t.config.cwd, testFile), 'utf8')).toBe('process.exit(0);\n');
    } else {
      expect(result.status).toBe(0);
      expect(state.result).toBe('ready_for_human_review');
      expect(state.repair).toBe(2);
      expect(observed).toHaveLength(2);
      expect(new Set(observed.map((item) => item.cwd)).size).toBe(2);
      expect(observed.map((item) => item.prior)).toEqual([false, true]);
      expect(await readFile(join(t.config.cwd, testFile), 'utf8')).toBe(testSource);
      const history = events(state.reviewHistory).map(object);
      expect(history.at(-1)?.status).toBe('accepted');
    }
  });
}

for (const failure of ['command_failure', 'invalid_json', 'invalid_response'] as const) {
  testDevelopment(
    `追加テスト工程の${failure}でも完了した終了履歴とusage集計を保持する`,
    async (f) => {
      f.args.push('--no-publish');
      const script = join(f.dir, 'additional-test-actor.js');
      const observed = join(f.dir, 'additional-test-workspace.txt');
      const usage = { input_tokens: 23, cached_input_tokens: 5, output_tokens: 7 };
      const code = failure === 'command_failure' ? 7 : 0;
      let prefix = '';
      let commandResult: { code: number | null; timedOut: boolean; ms: number } | undefined;
      f.verify = async (config) => {
        const actorDirectory = join(config.runDir, 'completed-test-actor');
        await mkdir(actorDirectory, { recursive: true });
        prefix = join(config.runDir, 'test-1');
        await writeFile(
          join(actorDirectory, 'actor.json'),
          JSON.stringify({
            recordFormat: 2,
            runtime: {
              cli: {
                entry: { value: '/fixture/codex', reason: null },
                realpath: { value: '/fixture/manager', reason: null },
                version: { value: null, reason: '模擬コマンド' },
              },
              harness: {
                commit: { value: await gitOutput(config.cwd, 'rev-parse', 'HEAD'), reason: null },
                trackedDirty: { value: false, reason: null },
                codeHash: { value: 'b'.repeat(64), reason: null },
                scope:
                  'implement/shared direct *.ts + package.json + bun.lock; sorted path/mode/content SHA-256; regular files only',
              },
            },
            invocationId: randomUUID(),
            role: 'test',
            hostPrefix: 'verification/test-1',
            model: 'fixture-model',
            reasoningEffort: 'high',
            sandbox: 'workspace-write',
            ignoreUserConfig: true,
          }),
        );
        await writeFile(
          join(actorDirectory, 'events.jsonl'),
          [
            { type: 'thread.started', thread_id: `additional-${failure}` },
            { type: 'turn.started' },
            { type: 'turn.completed', usage },
          ]
            .map((value) => JSON.stringify(value))
            .join('\n') + '\n',
        );
        await writeFile(
          script,
          `
import {readFileSync,writeFileSync} from 'node:fs';
const role=process.argv[2];
${reviewReplySource}
if(role==='check') {console.log('設定済みcheckは成功しました');process.exit(0);}
if(role==='review') {
 console.log(JSON.stringify(reviewReply('needs_changes','要求した追加文書が不足しているため追加テスト判断へ進みます。')));
 process.exit(0);
}
if(role==='test') {
 const prompt=readFileSync(0,'utf8');
 const input=JSON.parse(prompt.match(/入力: (\\{[^\\n]+\\})/)[1]);
 writeFileSync(${JSON.stringify(observed)},process.cwd());
 writeFileSync('pending.test.js','process.exit(1);\\n');
 console.error('追加テスト工程の原診断: ${failure}');
 console.log(${failure === 'invalid_response' ? "JSON.stringify({targetId:input.targetId,status:'prepared',files:['pending.test.js']})" : JSON.stringify(failure === 'invalid_json' ? '{broken-response' : '{}')});
 process.exit(${code});
}
if(role==='repair') throw Error('失敗したテスト工程の後続が実行されました');
`,
        );
        const state = await run({
          ...config,
          issue: [
            process.execPath,
            '-e',
            `process.stdout.write(${JSON.stringify('合意済み要求: implementedと操作文書を保持し、テスト工程失敗では公開を止める。')})`,
          ],
          check: [process.execPath, script, 'check'],
          test: [process.execPath, script, 'test'],
          repair: [process.execPath, script, 'repair'],
          review: [process.execPath, script, 'review'],
        });
        const execution = object(JSON.parse(await readFile(`${prefix}.execution.json`, 'utf8')));
        assert(
          (typeof execution.code === 'number' || execution.code === null) &&
            typeof execution.timedOut === 'boolean' &&
            typeof execution.ms === 'number',
        );
        commandResult = { code: execution.code, timedOut: execution.timedOut, ms: execution.ms };
        return state;
      };
      const outcome: unknown = await develop(f.args, f.io).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      const stopped = object(JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8')));
      expect(stopped).toMatchObject({ status: 'stopped', publication: 'not_attempted' });
      const state = object(
        JSON.parse(await readFile(join(f.dir, 'verification/state.json'), 'utf8')),
      );
      expect(state).toMatchObject({
        test: 1,
        repair: 0,
        review: 1,
        checks: 1,
        active: null,
        result: failure === 'command_failure' ? 'test_failed' : 'invalid_test',
      });
      const stdout = await readFile(`${prefix}.stdout`, 'utf8');
      if (failure === 'invalid_response') {
        expect(stopped.reason).toMatch(/findings/);
        expect(state.findings).toMatch(/findings/);
        expect(stopped.reason).not.toMatch(/テスト応答の入力が一致しません/);
        const input = testInput(await readFile(`${prefix}.prompt`, 'utf8'));
        expect(stdout).toBe(
          JSON.stringify({
            targetId: input.targetId,
            status: 'prepared',
            files: ['pending.test.js'],
          }) + '\n',
        );
      } else {
        expect(stdout).toBe((failure === 'invalid_json' ? '{broken-response' : '{}') + '\n');
      }
      expect(await readFile(`${prefix}.stderr`, 'utf8')).toContain(
        `追加テスト工程の原診断: ${failure}`,
      );
      const workspace = await readFile(observed, 'utf8');
      expect(await readFile(join(workspace, 'pending.test.js'), 'utf8')).toBe('process.exit(1);\n');
      expect(await Bun.file(join(f.dir, 'checkout/pending.test.js')).exists()).toBe(false);
      expect(await readFile(join(f.dir, 'checkout/result.txt'), 'utf8')).toBe('implemented');
      expect(f.calls.pushes).toBe(0);
      expect(f.calls.publications).toBe(0);
      const completed = events(state.events).map(object);
      const history = completed.filter((event) => event.role === 'test');
      const priorCommands = completed.filter((event) => event.role !== 'test');
      expect(priorCommands.map((event) => event.role)).toEqual(['check', 'review']);
      for (const event of priorCommands) {
        expect(event).toMatchObject({ code: 0, timedOut: false });
      }
      const reviews = events(state.reviewHistory).map(object);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.status).toBe('needs_changes');
      assert(commandResult);
      expect(commandResult).toMatchObject({ code, timedOut: false });
      expect(commandResult.ms).toBeGreaterThan(0);
      const retainedState = await readFile(join(f.dir, 'verification/state.json'), 'utf8');
      const report = await aggregateUsage(
        {
          format: 1,
          conditions: {
            id: 'issue360-failure',
            model: 'fixture-model',
            reasoningEffort: 'high',
            environment: '模擬コマンドの完了履歴',
            evaluationCriteria: 'Issue #360要求4の停止と保全',
            evidence: '固定版の独立テスト',
          },
          runs: [
            {
              id: 'failed-test',
              directory: f.dir,
              task: 'issue360',
              targetCommit: stopped.startCommit,
              retryOf: null,
              evaluation: {
                outcome: 'unsatisfied',
                evaluator: 'independent-test',
                evidence: 'テスト工程の応答拒否を確認',
              },
            },
          ],
        },
        f.dir,
      );
      const stage = report.stages.find((stage) => stage.phase === 'test');
      expect(stage).toMatchObject({ commandMs: 1 + commandResult.ms, observed: usage });
      expect(report.runs[0]?.stages.find((stage) => stage.phase === 'test')?.commands).toHaveLength(
        2,
      );
      expect(report.counts.satisfiedAttempts).toBe(0);
      expect(report.counts.executionFailed).toBe(failure === 'command_failure' ? 1 : 0);
      expect(await readFile(join(f.dir, 'verification/state.json'), 'utf8')).toBe(retainedState);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ prefix, ...commandResult });
      const reviewCommand = priorCommands.find((event) => event.role === 'review');
      assert(typeof reviewCommand?.ms === 'number');
      expect(state.modelMs).toBe(reviewCommand.ms + commandResult.ms);
    },
  );
}
