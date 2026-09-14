import { test, expect, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { correctionFixture, object, events } from './support/correction.ts';

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

for (const [mode, result, captures, reviews] of [
  ['capture_success', 'ready_for_human_review', 2, 1],
  ['capture_review', 'ready_for_human_review', 2, 2],
  ['capture_failure', 'ready_for_human_review', 2, 1],
  ['capture_unavailable', 'capture_unavailable', 1, 0],
  ['capture_timeout', 'capture_timeout', 1, 0],
  ['capture_changed', 'source_changed', 1, 0],
] as const) {
  test(`${mode} through controller entry`, async () => {
    const t = await trial(mode, { checkTimeMs: 500 });
    const resultProcess = t.execute();
    expect(resultProcess.status).toBe(result === 'ready_for_human_review' ? 0 : 1);
    const state = await t.state();
    expect(state.result).toBe(result);
    expect(state.review).toBe(reviews);
    expect(events(state.events).filter((event) => object(event).role === 'capture')).toHaveLength(
      captures,
    );
    if (result === 'ready_for_human_review') {
      expect(
        await readFile(join(t.config.cwd, 'trial/evidence/generated/desktop.png'), 'utf8'),
      ).toBe('correct');
    }
    if (mode === 'capture_success') {
      const before = JSON.stringify(state);
      expect(t.execute().status).toBe(0);
      expect(JSON.stringify(await t.state())).toBe(before);
      await writeFile(join(t.config.cwd, 'trial/evidence/generated/desktop.png'), 'stale');
      expect(object(JSON.parse(t.execute().stdout)).result).toBe('target_changed_after_stop');
    }
    if (mode === 'capture_unavailable') {
      expect(state.findings).toContain('capture-1.stderr');
      expect(state.repair).toBe(0);
    }
  });
}

for (const kind of [
  'tracked-doc',
  'staged-doc',
  'new-doc',
  'deleted-doc',
  'new-code',
  'tracked-code',
]) {
  test(`capture preserves existing media only for Markdown changes: ${kind}`, async () => {
    const t = await trial('media_scope');
    const { cwd } = t.config;
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      expect(result.status).toBe(0);
    };
    const media = join(cwd, 'trial/evidence/generated/desktop.png');
    await mkdir(join(cwd, 'trial/evidence/generated'), { recursive: true });
    await writeFile(join(cwd, 'source.txt'), 'correct');
    await writeFile(join(cwd, 'README.md'), 'original');
    await writeFile(join(cwd, 'app.js'), 'original');
    await writeFile(media, 'retained');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline');
    if (kind === 'deleted-doc') {
      await rm(join(cwd, 'README.md'));
    } else {
      const name =
        kind === 'new-doc'
          ? 'NEW.md'
          : kind === 'new-code'
            ? 'new.js'
            : kind === 'tracked-code'
              ? 'app.js'
              : 'README.md';
      await writeFile(join(cwd, name), 'current');
      if (kind === 'staged-doc') {
        git('add', 'README.md');
      }
    }
    t.config.capture = [process.execPath, join(t.root, 'helper.js'), 'capture'];
    await writeFile(t.configFile, JSON.stringify(t.config));
    expect(t.execute().status).toBe(0);
    const state = await t.state();
    const hasCode = kind.endsWith('code');
    expect(events(state.events).filter((event) => object(event).role === 'capture')).toHaveLength(
      hasCode ? 1 : 0,
    );
    expect(state.checks).toBe(1);
    expect(state.review).toBe(1);
    expect(state.result).toBe('ready_for_human_review');
    expect(await readFile(media, 'utf8')).toBe(hasCode ? 'correct' : 'retained');
  });
}

test('documentation repair keeps media unchanged through both checks and reviews', async () => {
  const t = await trial('docs');
  const { cwd } = t.config;
  const git = (...args: string[]) => {
    expect(spawnSync('git', args, { cwd }).status).toBe(0);
  };
  const media = join(cwd, 'trial/evidence/generated/desktop.png');
  await mkdir(join(cwd, 'trial/evidence/generated'), { recursive: true });
  await writeFile(join(cwd, 'source.txt'), 'correct');
  await writeFile(join(cwd, 'README.md'), 'original');
  await writeFile(media, 'retained');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline');
  await rm(join(cwd, 'README.md'));
  t.config.capture = [process.execPath, join(t.root, 'helper.js'), 'capture'];
  await writeFile(t.configFile, JSON.stringify(t.config));
  expect(t.execute().status).toBe(0);
  const state = await t.state();
  expect(events(state.events).filter((event) => object(event).role === 'capture')).toHaveLength(0);
  expect(state.checks).toBe(2);
  expect(state.review).toBe(2);
  expect(state.repair).toBe(1);
  expect(await readFile(join(cwd, 'README.md'), 'utf8')).toBe('current');
  expect(await readFile(media, 'utf8')).toBe('retained');
});

for (const change of [
  'records',
  'required-records',
  'source',
  'definition',
  'media',
  'symlink',
  'executable',
]) {
  test(`successful capture reuse after review repair: ${change}`, async () => {
    const t = await trial('reuse', { captureRequired: change === 'required-records' });
    const helper = join(t.root, 'reuse.js');
    await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
    await mkdir(join(t.config.cwd, 'trial/evidence'), { recursive: true });
    await writeFile(join(t.config.cwd, 'trial/evidence/old.json'), '{}');
    await writeFile(
      helper,
      `
import {readFileSync,writeFileSync,existsSync,mkdirSync,rmSync,symlinkSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const role=process.argv[2], change=${JSON.stringify(change)};
const media='trial/evidence/generated/demo.webm', record='trial/evidence/provenance.json';
const hash=()=>createHash('sha256').update(readFileSync(media)).digest('hex');
if(role==='capture') writeFileSync(join(process.argv[3],'demo.webm'),crypto.randomUUID());
if(role==='repair') {
 writeFileSync('README.md','updated explanation');
 writeFileSync(record,JSON.stringify({hash:hash()}));
 writeFileSync('trial/evidence/check.stdout','passed');
 if(change==='records') rmSync('trial/evidence/old.json');
 if(change==='source') writeFileSync('app.js','changed app');
 if(change==='definition') writeFileSync('trial/capture.spec.js','changed capture');
 if(change==='media') writeFileSync(media,'altered');
 if(change==='symlink') symlinkSync('../source.txt','trial/input.md');
 if(change==='executable') {writeFileSync('trial/evidence/command.txt','executable');chmodSync('trial/evidence/command.txt',0o755);}
 console.log(JSON.stringify({status:'repaired',findings:'updated'}));
}
if(role==='review') {
 const status=existsSync(record)?'accepted':'needs_changes';
 if(status==='accepted') {
  const same=JSON.parse(readFileSync(record,'utf8')).hash===hash();
  if(same!==(change==='records')) process.exit(7);
 }
 console.log(JSON.stringify({status,findings:'verify media identity'}));
}
`,
    );
    t.config.capture = [process.execPath, helper, 'capture'];
    t.config.repair = [process.execPath, helper, 'repair'];
    t.config.review = [process.execPath, helper, 'review'];
    await writeFile(t.configFile, JSON.stringify(t.config));
    expect(t.execute().status).toBe(0);
    const state = await t.state();
    expect(state.result).toBe('ready_for_human_review');
    expect(state.checks).toBe(2);
    expect(state.review).toBe(2);
    expect(state.repair).toBe(1);
    expect(events(state.events).filter((event) => object(event).role === 'capture')).toHaveLength(
      change === 'records' ? 1 : 2,
    );
  });
}

test('required capture without a command is rejected before starting a run', async () => {
  const t = await trial('media_scope', { captureRequired: true });
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe('Required capture command missing');
  expect(await readFile(join(t.config.cwd, 'source.txt'), 'utf8')).toBe('broken');
  expect(existsSync(t.config.runDir)).toBe(false);
});

// Markdown can itself be a rendering input in other repositories.
test('required capture runs for documentation and installs into the configured media directory', async () => {
  const t = await trial('media_scope', {
    captureDestination: 'review/media',
    captureRequired: true,
  });
  await writeFile(join(t.config.cwd, 'source.txt'), 'correct');
  await writeFile(join(t.config.cwd, 'README.md'), 'original');
  expect(spawnSync('git', ['add', '.'], { cwd: t.config.cwd }).status).toBe(0);
  expect(
    spawnSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline'],
      { cwd: t.config.cwd },
    ).status,
  ).toBe(0);
  await writeFile(join(t.config.cwd, 'README.md'), 'rendered documentation');
  t.config.capture = [process.execPath, join(t.root, 'helper.js'), 'capture'];
  await writeFile(t.configFile, JSON.stringify(t.config));
  expect(t.execute().status).toBe(0);
  expect(await readFile(join(t.config.cwd, 'review/media/desktop.png'), 'utf8')).toBe('correct');
  expect((await t.state()).result).toBe('ready_for_human_review');
});

test('a successful capture command without media cannot reach review or remove prior media', async () => {
  const t = await trial('media_scope', {
    captureDestination: 'review/media',
    captureRequired: true,
  });
  const media = join(t.config.cwd, 'review/media');
  await mkdir(media, { recursive: true });
  await writeFile(join(media, 'prior.png'), 'keep');
  t.config.capture = [process.execPath, '-e', 'process.exit(0)'];
  await writeFile(t.configFile, JSON.stringify(t.config));
  const result = t.execute();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Capture succeeded without required media');
  expect((await t.state()).review).toBe(0);
  expect(await readFile(join(media, 'prior.png'), 'utf8')).toBe('keep');
});

test('Playwright capture rejects a missing spec before attempting browser or server startup', async () => {
  const t = await trial('media_scope');
  const output = join(t.root, 'output');
  const config = join(t.config.cwd, 'capture.config.js');
  const spec = join(t.config.cwd, 'missing.spec.js');
  await mkdir(output);
  await writeFile(config, 'export default {};');
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dir, '../capture.ts'), spec, config, output],
    { cwd: t.config.cwd, encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stderr).toContain(spec);
  expect(result.stderr).not.toContain('Host cannot start');
});
