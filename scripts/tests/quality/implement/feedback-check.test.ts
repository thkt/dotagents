import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { develop } from '../../../implement/orchestrator.ts';
import { testDevelopment, gitOutput } from '../../support/development.ts';
import { correctionFixture, events, object } from '../../support/correction.ts';
import { fixture as revisionFixture } from '../../support/revision-fixture.ts';
import { records } from '../../support/review-recovery.ts';
import { targetConfig } from '../../support/target.ts';
import { withInterrupts } from '../../../shared/process.ts';

for (const format of ['omitted', 'shell', 'argv'] as const) {
  testDevelopment(`feedbackCheckの初回実装・独立テストへの引き継ぎ: ${format}`, async (f) => {
    const marker = 'feedback-iteration-only';
    const feedbackCheck = format === 'shell' ? `printf '%s' '${marker}'` : ['echo', marker, ''];
    if (format !== 'omitted') {
      Object.assign(f.settings, { feedbackCheck });
      await writeFile(join(f.repo, '.dotagents.json'), JSON.stringify(f.settings));
      await gitOutput(f.repo, 'add', '.dotagents.json');
      await gitOutput(f.repo, 'commit', '-m', '反復用checkを設定');
    }
    f.args.push('--no-publish');
    const received: string[] = [];
    const implement = f.implement;
    f.implement = (...args) => {
      received.push(args[2]);
      return implement(...args);
    };
    const author = f.test;
    f.test = (...args) => {
      received.push(args[2]);
      return author(...args);
    };
    const result = await develop(f.args, f.io);
    expect(result.status).toBe('verified_local');
    expect(received).toHaveLength(2);
    for (const prompt of received) {
      expect(prompt).toContain(JSON.stringify(f.settings.check));
      if (format === 'omitted') {
        expect(prompt).not.toContain('feedbackCheck');
        expect(prompt).not.toContain(marker);
      } else {
        expect(prompt).toContain(marker);
        expect(prompt).toMatch(/反復|作業中/);
      }
    }
    const config = object(
      JSON.parse(await readFile(join(f.dir, 'verification-config.json'), 'utf8')),
    );
    expect(config.check).toEqual(f.settings.check);
    expect(JSON.parse(await readFile(join(f.dir, 'target.json'), 'utf8'))).toMatchObject({
      text: JSON.stringify(f.settings),
    });
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
  });
}

const { trial, cleanup } = correctionFixture();
afterEach(cleanup);

for (const enabled of [false, true]) {
  test(`feedbackCheckの有無で修正周回の全体check・評価記録を変えない: ${enabled}`, async () => {
    const t = await trial('docs');
    const marker = join(t.root, 'feedback-was-executed');
    const feedbackCheck = ['sh', '-c', `printf unexpected > '${marker}'`];
    await writeFile(
      t.configFile,
      JSON.stringify({
        ...t.config,
        ...(enabled ? { feedbackCheck } : {}),
      }),
    );
    const result = t.execute();
    assert.equal(result.status, 0, result.stderr);
    const state = await t.state();
    expect(state).toMatchObject({
      result: 'ready_for_human_review',
      checks: 3,
      repair: 2,
      review: 2,
    });
    expect(
      events(state.events)
        .map(object)
        .map((event) => event.role),
    ).toEqual(['check', 'repair', 'check', 'review', 'repair', 'check', 'review']);
    expect(await Bun.file(marker).exists()).toBe(false);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = await readFile(join(t.config.runDir, `repair-${attempt}.prompt`), 'utf8');
      expect(prompt).toContain(JSON.stringify(t.config.check));
      if (enabled) {
        expect(prompt).toContain(marker);
        expect(prompt).toMatch(/反復|作業中/);
      } else {
        expect(prompt).not.toContain('feedbackCheck');
      }
      const target = object(
        JSON.parse(await readFile(join(t.config.runDir, `review-${attempt}.target.json`), 'utf8')),
      );
      expect(object(target.check).command).toEqual(t.config.check);
      expect(object(target.check).code).toBe(0);
    }
    const saved = await readFile(join(t.config.runDir, 'state.json'), 'utf8');
    const repeated = t.execute();
    assert.equal(repeated.status, 0, repeated.stderr);
    expect(await readFile(join(t.config.runDir, 'state.json'), 'utf8')).toBe(saved);
  });
}

for (const scenario of ['omitted', 'same', 'changed_text'] as const) {
  test(`feedbackCheck設定を既存PRの修正で照合する: ${scenario}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-revision-')));
    try {
      const settings = {
        ...targetConfig,
        ...(scenario === 'omitted' ? {} : { feedbackCheck: ['echo', 'revision-feedback'] }),
      };
      const f = await revisionFixture(root, false, [], false, false, true, settings);
      const prior = await records(f.prior);
      const oldConfig = object(
        JSON.parse(await readFile(join(f.prior, 'verification-config.json'), 'utf8')),
      );
      expect(oldConfig.check).toEqual(settings.check);
      if (scenario === 'omitted') {
        expect(oldConfig).not.toHaveProperty('feedbackCheck');
      }
      if (scenario === 'changed_text') {
        const path = join(f.cwd, '.dotagents.json');
        await writeFile(path, (await readFile(path, 'utf8')) + '\n');
        await assert.rejects(
          () => develop(f.args, f.io),
          /Previous repository, Issue, configuration or actor differs/,
        );
        expect(f.hooks.implementations).toBe(0);
        expect(f.hooks.verificationEntries).toBe(0);
        expect(f.hooks.pushes).toBe(0);
        expect(f.hooks.edits).toBe(0);
        expect(f.independentTests).toHaveLength(0);
      } else {
        const result = await develop(f.args, f.io);
        expect(result.status).toBe('published_draft');
        expect(f.hooks.implementations).toBe(1);
        expect(f.independentTests).toHaveLength(1);
        const fresh = object(
          JSON.parse(await readFile(join(f.dir, 'verification-config.json'), 'utf8')),
        );
        expect(fresh.check).toEqual(settings.check);
        expect(fresh.targetText).toBe(oldConfig.targetText);
        if (scenario === 'same') {
          expect(f.independentTests[0]?.prompt).toContain('revision-feedback');
          expect(f.implementationPrompts.at(-1)).toContain('revision-feedback');
        }
      }
      expect(await records(f.prior)).toEqual(prior);
    } finally {
      await withInterrupts(async () => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}
