import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  controller,
  correctionFixture,
  events,
  object,
  reviewer,
  withFileHooks,
} from '../../support/correction.ts';
import { git } from '../../support/target.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

for (const [attempt, terminalFailure] of [
  [1, false],
  [2, false],
  [2, true],
] as const) {
  test(`review save failure at attempt ${attempt}, terminal save failure ${terminalFailure}`, async () => {
    const t = await trial('docs');
    await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await reviewer(
      t,
      `const reply=reviewReply(${attempt}===1 || reviewContext.previous ? 'accepted' : 'needs_changes','Valid review');`,
    );
    const prefix = join(t.config.runDir, `review-${attempt}`);
    const result = await withFileHooks(
      t,
      `
writeFile: async (path,...args)=>{
 if(path===${JSON.stringify(prefix + '.json')}) throw Error('review disk fixture failure');
 if(${terminalFailure} && String(path).endsWith('state.json.tmp') && JSON.parse(args[0]).result==='review_storage_failed') throw Error('terminal disk fixture failure');
 return fs.writeFile(path,...args);
}`,
    );
    expect(result.status).toBe(1);
    const state = await t.state();
    expect([state.review, state.repair]).toEqual([attempt, attempt - 1]);
    expect(events(state.reviewHistory)).toHaveLength(attempt - 1);
    if (attempt === 2) {
      const previous = object(
        JSON.parse(await readFile(join(t.config.runDir, 'review-1.json'), 'utf8')),
      );
      expect(events(state.reviewHistory)[0]).toEqual(previous.review);
      expect(object(previous.review).status).toBe('needs_changes');
    }
    const raw = object(JSON.parse(await readFile(`${prefix}.stdout`, 'utf8')));
    expect(raw.newItems).toEqual([]);
    expect(await Bun.file(`${prefix}.target.json`).exists()).toBe(true);
    if (terminalFailure) {
      expect(state.active).toMatchObject({ role: 'review', prefix });
      expect(result.stderr).toContain('terminal disk fixture failure');
      expect(result.stderr).toContain(join(t.config.runDir, 'state.json'));
    } else {
      expect(state.result).toBe('review_storage_failed');
      expect(state.active).toBeNull();
    }
    const diagnostic = terminalFailure ? result.stderr : String(state.findings);
    expect(diagnostic).toContain('review disk fixture failure');
    expect(diagnostic).toContain(`${prefix}.json`);
    expect(diagnostic).toContain(`${prefix}.stdout`);
    expect(diagnostic).not.toContain('Invalid review');
    const saved = await readFile(join(t.config.runDir, 'state.json'), 'utf8');
    expect(t.execute().status).toBe(1);
    expect(await readFile(join(t.config.runDir, 'state.json'), 'utf8')).toBe(saved);
    expect(await Bun.file(join(t.config.runDir, `repair-${attempt}.prompt`)).exists()).toBe(false);
    expect(await Bun.file(join(t.config.runDir, `review-${attempt + 1}.prompt`)).exists()).toBe(
      false,
    );
  });
}

test('a file disappearing after lstat is not treated as an identified deletion', async () => {
  const t = await trial('normal');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  const path = join(t.config.cwd, 'vanishing.txt');
  await writeFile(path, 'must be read');
  git(t.config.cwd, 'add', 'vanishing.txt');
  const result = await withFileHooks(
    t,
    `
lstat: async (path,...args)=>{
 const stat=await fs.lstat(path,...args);
 if(path===${JSON.stringify(path)}) await fs.unlink(path);
 return stat;
}`,
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stderr).toContain('vanishing.txt');
  expect(await t.state()).toMatchObject({ review: 0, repair: 0, checks: 0 });
  expect(await Bun.file(join(t.config.runDir, 'review-1.prompt')).exists()).toBe(false);
});

test('an enumerated untracked file disappearing stops review without a partial success', async () => {
  const t = await trial('normal');
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  const path = join(t.config.cwd, 'vanishing.txt');
  await writeFile(path, 'must be recorded');
  const bin = join(t.root, 'bin');
  await mkdir(bin);
  const realGit = Bun.which('git');
  expect(realGit).not.toBeNull();
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env bun
import {spawnSync} from 'node:child_process';
import {unlinkSync} from 'node:fs';
const args=process.argv.slice(2);
const result=spawnSync(${JSON.stringify(realGit)},args);
if(result.status===0 && args.includes('ls-files') && args.includes('--others') && !args.includes('--cached')) {
 unlinkSync(${JSON.stringify(path)});
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status??1);
`,
  );
  await chmod(join(bin, 'git'), 0o755);
  const result = spawnSync(process.execPath, [controller, t.configFile], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 20000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stderr).toContain('vanishing.txt');
  expect(await t.state()).toMatchObject({ review: 0, repair: 0, checks: 1 });
  expect(await Bun.file(join(t.config.runDir, 'review-1.prompt')).exists()).toBe(false);
});
