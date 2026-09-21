import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateReviewReport } from '../review-report.ts';
import { events, object, reviewReplySource } from './support/correction.ts';

async function json(path: string) {
  return object(JSON.parse(await readFile(path, 'utf8')));
}

async function inspectCase(root: string, entry: Record<string, unknown>) {
  assert(typeof entry.id === 'string');
  expect(entry.id).toMatch(/^case-[A-Za-z0-9]+$/);
  const dir = join(root, entry.id);
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
    repairLimit: 1,
    reviewLimit: 1,
    modelTimeMs: 1200000,
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
  // Reuse this producer trial to catch drift between saved records and the HTML reader.
  const report = await generateReviewReport(
    join(root, 'host', entry.id, 'result.json'),
    join(dirname(root), `${entry.id}.html`),
  );
  const html = await readFile(report.output, 'utf8');
  expect(html).toContain(String(object(result.review).status));
  expect(html).toContain('pending_host_adjudication');
  expect(html).toContain(`<pre>${Bun.escapeHTML(String(source['page.test.ts']))}</pre>`);
  expect(html).toContain(`<pre>${Bun.escapeHTML(String(source['README.md']))}</pre>`);
  expect(report.warnings).toEqual([]);
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
const files=Object.fromEntries(['page.ts','page.test.ts','README.md'].map(name=>[name,readFileSync(name,'utf8')]));
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
    for (const draw of [0, 1]) {
      const work = join(temp, String(draw));
      await mkdir(work);
      const preload = join(work, 'random.ts');
      await writeFile(
        preload,
        `import {mock} from 'bun:test';
import * as crypto from 'node:crypto';
mock.module('node:crypto',()=>({...crypto,randomInt:()=>${draw}}));`,
      );
      const execution = spawnSync(
        process.execPath,
        ['--preload', preload, resolve('scripts/verify-review.ts')],
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
      expect(mapping.map((entry) => entry.name)).toEqual(
        draw === 0 ? ['defective', 'correct'] : ['correct', 'defective'],
      );
      expect(new Set(mapping.map((entry) => entry.id)).size).toBe(2);
      expect(events(output.results).map((value) => object(value).id)).toEqual(
        mapping.map((entry) => entry.id),
      );
      for (const entry of mapping) {
        await inspectCase(output.root, entry);
      }
      const environment = await json(join(output.root, 'host', 'environment.json'));
      expect(environment.codex).toBe('simulated-codex');
      expect(environment.harnessCommit).toMatch(/^[a-f0-9]{40}$/);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60000);
