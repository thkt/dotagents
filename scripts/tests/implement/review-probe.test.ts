import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { events, object, reviewReplySource } from '../support/correction.ts';
import { readReviewerUsage } from '../../implement/review-probe.ts';

async function json(path: string) {
  return object(JSON.parse(await readFile(path, 'utf8')));
}

test('reviewer usage rejects fractional and overflowing token totals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-usage-'));
  const dir = join(root, 'review-codex-trial');
  const event = (input_tokens: number) =>
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens, cached_input_tokens: 0, output_tokens: 0 },
    });
  try {
    await mkdir(dir);
    for (const lines of [[event(0.5)], [event(10), event(Number.MAX_SAFE_INTEGER)]]) {
      await writeFile(join(dir, 'events.jsonl'), lines.join('\n'));
      await assert.rejects(() => readReviewerUsage(root), /Incomplete model usage/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function inspectCase(root: string, entry: Record<string, unknown>) {
  assert(typeof entry.id === 'string');
  expect(entry.id).toMatch(/^case-[A-Za-z0-9]+$/);
  const dir = join(root, entry.id);
  const state = await json(join(dir, 'verification/state.json'));
  expect(state).toMatchObject({ result: 'review_completed', review: 1, repair: 0, checks: 1 });
  expect(await Bun.file(join(dir, 'handoff.ts')).exists()).toBe(false);
  const actors = (await readdir(dir)).filter((name) => name.startsWith('review-codex-'));
  expect(actors).toHaveLength(1);
  assert(actors[0]);
  const input = await json(join(dir, actors[0], 'input.json'));
  expect(input.cwd).toBe(join(dir, 'checkout'));
  const serialized = JSON.stringify(input);
  // Generic review/test/correction vocabulary and actual source defects remain visible.
  // Only answer metadata and host-only references are excluded.
  expect(serialized).not.toMatch(
    /defective|knownDefect|missedKnownDefect|pending_host_adjudication/,
  );
  expect(serialized).not.toMatch(/\/(?:correct|host)\//);
  expect(serialized).not.toMatch(/cases\.json|oracle\.ts|result\.json|environment\.json/);
  const context = object(input.context);
  expect(context.previous).toBeNull();
  expect(context.attempt).toBe(1);
  for (const key of ['targetRecord', 'diff', 'additions']) {
    expect(context[key]).toBe(
      join(
        dir,
        'verification',
        `review-1.${
          key === 'targetRecord' ? 'target.json' : key === 'additions' ? 'additions.json' : 'diff'
        }`,
      ),
    );
  }
  const target = object(input.target);
  expect(object(target.issue).content).toContain(
    'Offset and limit must be nonnegative safe integers',
  );
  expect(target.reports).toEqual([]);
  expect(target.files).toEqual(
    expect.arrayContaining([
      ['README.md', expect.any(Number), expect.any(String)],
      ['page.test.ts', expect.any(Number), expect.any(String)],
      ['page.ts', expect.any(Number), expect.any(String)],
    ]),
  );
  expect(input.prompt).toContain('independent');
  expect(input.base).toBe('// Pagination will be implemented here.\n');
  expect(input.diff).toContain('return items.slice(offset,');
  expect(JSON.stringify(input.additions)).toContain('pagination contract');
  expect(input.checkStderr).toContain('1 pass');
  const source = object(input.files);
  expect(source['README.md']).toContain('Run `bun test`');
  expect(source['page.test.ts']).toContain("from 'bun:test'");
  const config = object(input.config);
  expect(config).toMatchObject({
    reviewTimeMs: 1200000,
    checkTimeMs: 540000,
  });
  expect(object(target.model).command).toEqual(config.review);
  expect(events(input.args)).toContain('--output-schema');

  const result = await json(join(root, 'host', entry.id, 'result.json'));
  expect(result).toMatchObject({ id: entry.id, name: entry.name, baseCommit: target.baseCommit });
  const broken = entry.name === 'defective';
  expect(source['page.ts']).toContain(
    broken ? 'slice(offset, limit)' : 'slice(offset, offset + limit)',
  );
  const reproduction = object(result.reproduction);
  expect(reproduction).toMatchObject({
    input: { items: [10, 20, 30, 40], offset: 2, limit: 2 },
    expected: [30, 40],
    actual: broken ? [] : [30, 40],
    source: join(dir, 'checkout', 'page.ts'),
    oracle: join(root, 'host', entry.id, 'oracle.ts'),
  });
  // Deliberately wrong mock judgments must not become host detection verdicts.
  expect(object(result.review).status).toBe(broken ? 'accepted' : 'needs_changes');
  const adjudication = object(result.adjudication);
  expect(adjudication.status).toBe('pending_host_adjudication');
  expect(adjudication.missedKnownDefect).toBeNull();
  expect(adjudication.knownDefect).toBe(
    broken ? 'slice uses limit as end index; nonzero offset can return too few items' : null,
  );
  expect(adjudication.findings).toEqual(
    broken
      ? []
      : [
          {
            id: 'R1-1',
            verdict: 'unconfirmed',
            reproduction: null,
            reason: null,
          },
        ],
  );
  expect(object(result.usage).completedTurns).toBe(1);
}

test('probe conceals answer metadata through the real review input path and retains host adjudication', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'review-input-')));
  try {
    const bin = join(temp, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'codex'),
      `#!${process.execPath}
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='--version') {console.log('simulated-codex');process.exit(0);}
const prompt=readFileSync(0,'utf8');
const context=JSON.parse(prompt.split('Host context: ')[1].split('\\n')[0]);
const target=JSON.parse(readFileSync(context.targetRecord,'utf8'));
const cwd=process.cwd(), dir=dirname(cwd);
const names=readdirSync('.').includes('page.test.ts')?['page.ts','page.test.ts','README.md']:['page.ts','README.md',...readdirSync('tests').map(name=>'tests/'+name)];
const files=Object.fromEntries(names.map(name=>[name,readFileSync(name,'utf8')]));
const output=args[args.indexOf('-o')+1];
writeFileSync(join(dirname(output),'input.json'),JSON.stringify({
 cwd,args,prompt,context,target,files,
 schema:JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8')),
 config:JSON.parse(readFileSync(join(dir,'config.json'),'utf8')),
 base:execFileSync('git',['show',target.baseCommit+':page.ts'],{encoding:'utf8'}),
 diff:readFileSync(context.diff,'utf8'),
 additions:JSON.parse(readFileSync(context.additions,'utf8')).map(file=>({...file,content:Buffer.from(file.content,'base64').toString('utf8')})),
 checkStdout:readFileSync(target.check.prefix+'.stdout','utf8'),
 checkStderr:readFileSync(target.check.prefix+'.stderr','utf8'),
 caseEntries:readdirSync(dir), checkoutEntries:readdirSync(cwd)
}));
const role='review';
${reviewReplySource.replace("readFileSync(0,'utf8')", 'prompt')}
const reply=reviewReply(files['page.ts'].includes('offset + limit')?'needs_changes':'accepted','Simulated judgment, not adjudication');
writeFileSync(output,JSON.stringify(reply));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:5}}));
`,
      { mode: 0o755 },
    );
    // Force each random-order branch without statistical/flaky repeated sampling.
    // The actual CLI, correction, actor, git and fixture checks still execute.
    for (const [index, scenario] of [
      { draw: 0, args: [], names: ['defective', 'correct'], inspect: inspectCase },
      { draw: 1, args: [], names: ['correct', 'defective'], inspect: inspectCase },
      {
        draw: 0,
        args: ['--scenario', 'test-review'],
        names: ['sound', 'unchanged', 'weak'],
        inspect: inspectTestCase,
      },
    ].entries()) {
      const work = join(temp, String(index));
      await mkdir(work);
      const preload = join(work, 'random.ts');
      await writeFile(
        preload,
        `import {mock} from 'bun:test';
import * as crypto from 'node:crypto';
mock.module('node:crypto',()=>({...crypto,randomInt:()=>${scenario.draw}}));`,
      );
      const execution = spawnSync(
        process.execPath,
        ['--preload', preload, resolve('scripts/implement/review-probe.ts'), ...scenario.args],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: work },
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      expect(execution.error).toBeUndefined();
      expect(execution.status, execution.stderr).toBe(0);
      const output = object(JSON.parse(execution.stdout));
      assert(typeof output.root === 'string');
      expect(dirname(output.root)).toBe(work);
      const mapping = events(
        JSON.parse(await readFile(join(output.root, 'host', 'cases.json'), 'utf8')),
      ).map(object);
      expect(mapping.map((entry) => entry.name)).toEqual(scenario.names);
      expect(new Set(mapping.map((entry) => entry.id)).size).toBe(scenario.names.length);
      expect(events(output.results).map((value) => object(value).id)).toEqual(
        mapping.map((entry) => entry.id),
      );
      for (const entry of mapping) {
        await scenario.inspect(output.root, entry);
      }
      const environment = await json(join(output.root, 'host', 'environment.json'));
      expect(environment.codex).toBe('simulated-codex');
      expect(environment.harnessCommit).toMatch(/^[a-f0-9]{40}$/);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60000);

async function inspectTestCase(root: string, entry: Record<string, unknown>) {
  assert(typeof entry.id === 'string');
  const dir = join(root, entry.id);
  const actors = (await readdir(dir)).filter((name) => name.startsWith('review-codex-'));
  expect(actors).toHaveLength(1);
  assert(actors[0]);
  const input = await json(join(dir, actors[0], 'input.json'));
  const serialized = JSON.stringify(input);
  expect(serialized).not.toMatch(
    /weak|sound|knownDefect|expectedTestGap|pending_host_adjudication|mutation-copy|preflight\.json|cases\.json|oracle\.ts/,
  );
  expect(serialized).not.toMatch(/\/host\//);
  const target = object(input.target);
  expect(object(target.issue).content).toContain(String(target.baseCommit));
  expect(object(target.issue).content).toContain('tests/06-invalid.test.ts');
  expect(object(input.config)).toMatchObject({
    reviewTimeMs: 180000,
  });
  expect(input.base).toContain('offset + limit');
  expect(events(input.args)).toContain('--output-schema');
  const result = await json(join(root, 'host', entry.id, 'result.json'));
  const fixture = object(result.fixture);
  expect(fixture.headCommit).not.toBe(fixture.baseCommit);
  const preflight = await json(String(fixture.preflight));
  expect(object(preflight.normal).code).toBe(0);
  expect(object(preflight.mutated).code).toBe(entry.name === 'sound' ? 1 : 0);
  expect(object(preflight.original).stdout).toBe('[30,40]\n');
  expect(object(preflight.reproduction).stdout).toBe('[]\n');
  const files = object(input.files);
  if (entry.name === 'unchanged') {
    expect(fixture.headTree).toBe(fixture.baseTree);
    expect(input.diff).toBe('');
    expect(files['tests/07-offset.test.ts']).toBeUndefined();
    expect(input.checkStderr).toContain('6 pass');
  } else {
    expect(fixture.headTree).not.toBe(fixture.baseTree);
    expect(input.diff).toContain('07-offset.test.ts');
    expect(files['tests/07-offset.test.ts']).toContain(entry.name === 'weak' ? ',0,2)' : ',2,2)');
    expect(files['tests/08-reference.test.ts']).toContain('toBe(a)');
    expect(input.checkStderr).toContain('8 pass');
  }
  expect(object(result.adjudication)).toMatchObject({
    status: 'pending_host_adjudication',
    inputIntegrity: 'unconfirmed',
    verificationClaims: 'unconfirmed',
  });
}

// Shared process tests cover both handled signals; SIGTERM checks the preflight wiring.
test.each(['mismatch', 'copy', 'SIGTERM'])(
  'a later fixture preflight %s failure prevents every model launch and retains evidence',
  async (failure) => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'review-preflight-')));
    try {
      const bin = join(temp, 'bin');
      await mkdir(bin);
      const marker = join(temp, 'model-started');
      await writeFile(
        join(bin, 'codex'),
        `#!${process.execPath}
if(process.argv[2]==='--version') {console.log('simulated-codex');}
else {await Bun.write(${JSON.stringify(marker)},'started');process.exit(1);}
`,
        { mode: 0o755 },
      );
      const preload = join(temp, 'failure.ts');
      const processModule = resolve('scripts/shared/process.ts');
      await writeFile(
        preload,
        `import {mock} from 'bun:test';
import * as crypto from 'node:crypto';
import * as processApi from ${JSON.stringify(processModule)};
import * as fs from 'node:fs/promises';
const original=processApi.command, copy=fs.cp;
const failure=${JSON.stringify(failure)};
let mutations=0, copies=0;
mock.module('node:fs/promises',()=>({...fs,cp:async (...args)=>{
 if(args[1].endsWith('/mutation-copy') && ++copies===2 && failure==='copy') {
  throw Error('Simulated mutation copy failure');
 }
 return copy(...args);
}}));
mock.module('node:crypto',()=>({...crypto,randomInt:()=>0}));
mock.module(${JSON.stringify(processModule)},()=>({...processApi,command:async (...args)=>{
 const failHere=args[0][1]==='test' && args[1].endsWith('/mutation-copy') && ++mutations===2;
 if(failHere && failure.startsWith('SIG')) {
  args[0]=[process.execPath,'-e',
   "import {writeSync} from 'node:fs'; writeSync(1,'partial stdout'); writeSync(2,'partial stderr'); process.kill(process.ppid,"+JSON.stringify(failure)+"); setInterval(()=>{},1000);"];
 }
 const result=await original(...args);
 return failHere && failure==='mismatch'
  ? {...result,code:1,stderr:'Simulated unexpected test failure'} : result;
}}));`,
      );
      const execution = spawnSync(
        process.execPath,
        [
          '--preload',
          preload,
          resolve('scripts/implement/review-probe.ts'),
          '--scenario',
          'test-review',
        ],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp },
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      expect(execution.error).toBeUndefined();
      expect(execution.status).toBe(1);
      expect(await Bun.file(marker).exists()).toBe(false);
      const root = execution.stderr.match(/Live review evidence retained at (.+)/)?.[1];
      assert(root);
      const mapping = events(
        JSON.parse(await readFile(join(root, 'host', 'cases.json'), 'utf8')),
      ).map(object);
      expect(mapping.map((entry) => entry.name)).toEqual(['sound', 'unchanged', 'weak']);
      for (const entry of mapping) {
        assert(typeof entry.id === 'string');
        expect(
          (await readdir(join(root, entry.id))).filter((name) => name.startsWith('review-codex-')),
        ).toEqual([]);
      }
      const failed = mapping[1];
      assert(failed && typeof failed.id === 'string');
      const evidence = await json(join(root, 'host', failed.id, 'preflight.json'));
      expect(object(evidence.normal).code).toBe(0);
      expect(object(evidence.normal).stderr).toContain('6 pass');
      expect(object(evidence.original).stdout).toBe('[30,40]\n');
      const stopped = await readFile(join(root, 'stopped.txt'), 'utf8');
      if (failure === 'mismatch') {
        expect(object(evidence.mutated).stderr).toBe('Simulated unexpected test failure');
        expect(stopped).toContain('Unexpected mutation detection');
      } else {
        expect(Object.keys(evidence)).toEqual(['normal', 'original']);
        if (failure === 'copy') {
          expect(stopped).toContain('Simulated mutation copy failure');
        } else {
          expect(stopped).toContain('Interrupted execution');
          const prefix = join(root, 'host', failed.id, 'preflight-mutated');
          expect(await readFile(`${prefix}.stdout`, 'utf8')).toBe('partial stdout');
          expect(await readFile(`${prefix}.stderr`, 'utf8')).toBe('partial stderr');
        }
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
  30000,
);
