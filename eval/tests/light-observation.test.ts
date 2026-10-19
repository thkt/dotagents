import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { lightObservationPreload } from './light-observation.preload.fixture.ts';
import { instructionFiles } from './trusted-inputs.ts';
import { isRecord } from '../../scripts/shared/values.ts';

async function logSizes(root: string, trials: string[]) {
  const sizes: number[] = [];
  for (const trial of trials) {
    const directory = join(root, 'run', trial);
    if (!(await Bun.file(join(directory, 'trial.json')).exists())) {
      continue;
    }
    let total = 0;
    for (const name of await readdir(directory)) {
      const info = await lstat(join(directory, name));
      if (info.isFile()) {
        total += info.size;
      }
    }
    sizes.push(total);
  }
  return sizes;
}

// #405の容量・完了境界を、公開runから実際の回収・保存まで接続する。
// 版・入力準備・認証・nativeCommandだけを合成に置換する。実CLIは起動しない。
async function observe(scenario: string, replay = false) {
  const root = await mkdtemp(join(tmpdir(), 'light-observation-'));
  try {
    const home = join(root, 'home');
    await mkdir(home);
    const registered = scenario.startsWith('registered');
    const registrationFiles = [
      'AGENTS.md',
      'config.toml',
      'hooks.json',
      'plugins/probe.json',
      'rules/probe.md',
      'memories/probe.md',
      'skills/implement/SKILL.md',
    ];
    const registrationBodies: Record<string, string> = {};
    if (registered) {
      for (const path of registrationFiles) {
        await mkdir(join(home, path, '..'), { recursive: true });
        const body = `SYNTHETIC_PERSONAL_${path}`;
        registrationBodies[path] = body;
        await writeFile(join(home, path), body);
      }
      await symlink(join(home, 'skills/implement'), join(home, 'skills/personal-link'));
      await writeFile(join(home, 'auth.json'), 'SYNTHETIC_SECRET_AUTH');
    }
    const settings = join(root, 'settings.json');
    await writeFile(settings, JSON.stringify({ root, scenario }));
    const config = {
      repository: 'thkt/dotagents',
      issue: 'https://github.com/thkt/dotagents/issues/405',
      authentication: 'chatgpt',
      stage: 1,
      before: 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092',
      after: '6181233d17a29c711a84f20549f78507c5c3e5fb',
      corpusCommit: '0c7316253a9768844eb1c224961e00be52dcdcf2',
      workspaceCommit: '0c7316253a9768844eb1c224961e00be52dcdcf2',
      workspaceFiles: ['eval/fixtures/workspace/README.md'],
      instructionFiles,
      cases: ['storage-fields', 'completion-message'],
      trialOrder: [
        'before-storage-fields',
        'after-storage-fields',
        'after-completion-message',
        'before-completion-message',
      ],
      maxTrials: 4,
      model: 'gpt-6.1-sol',
      reasoning: 'medium',
      cliVersion: 'synthetic-cli',
      bunVersion: '1.4.3',
      gitVersion: 'synthetic-git',
      permissionProfile: 'eval-light',
      caseTimeMs: 100,
      totalTimeMs: 10000,
      outputDirectory: join(root, 'run'),
      disclosure: {
        inputs: 'reviewed-public-committed-files-only',
        raw: 'local-only',
        summary: 'manual-issue-or-pr',
      },
    };
    const configuration = join(root, 'config.json');
    await writeFile(configuration, JSON.stringify(config));
    const worker = Bun.spawn(
      [
        process.execPath,
        '--preload',
        lightObservationPreload,
        resolve(import.meta.dir, '../light.ts'),
        'run',
        configuration,
      ],
      {
        cwd: resolve(import.meta.dir, '../..'),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CODEX_HOME: home,
          TMPDIR: root,
          LIGHT_OBSERVATION_SETTINGS: settings,
          OPENAI_API_KEY: 'SYNTHETIC_SECRET_ENV',
          NODE_OPTIONS: '--synthetic-hook-must-not-propagate',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const timer = setTimeout(() => worker.kill(), 15000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(worker.stdout).text(),
        new Response(worker.stderr).text(),
        worker.exited,
      ]);
      assert(!worker.signalCode, `検証プロセスが中断: ${stdout}${stderr}`);
      assert(!/Cannot find|Module not found|SyntaxError|ENOENT|EPERM|EACCES/.test(stderr), stderr);
      assert(
        await Bun.file(join(root, 'run/evaluation.json')).exists(),
        `保存入口へ未到達（Redに数えない）: ${stdout}${stderr}`,
      );
      const evaluation: unknown = JSON.parse(
        await readFile(join(root, 'run/evaluation.json'), 'utf8'),
      );
      assert(isRecord(evaluation) && Array.isArray(evaluation.records));
      const records = evaluation.records.filter(isRecord);
      assert.equal(records.length, 4, '予定分母を保つ');
      const events = (await readFile(join(root, 'observations.jsonl'), 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const value: unknown = JSON.parse(line);
          assert(isRecord(value));
          return value;
        });
      for (const [path, body] of Object.entries(registrationBodies)) {
        if (!(scenario === 'registered-change' && path === 'AGENTS.md')) {
          expect(await readFile(join(home, path), 'utf8')).toBe(body);
        }
      }
      if (registered) {
        expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('SYNTHETIC_SECRET_AUTH');
        expect((await lstat(join(home, 'skills/personal-link'))).isSymbolicLink()).toBe(true);
      }
      if (replay) {
        const reservationRoot = join(home, 'eval-light-runs');
        const names = await readdir(reservationRoot);
        expect(names).toHaveLength(1);
        const reservation = join(reservationRoot, names[0] ?? 'missing');
        const originalReservation = await readFile(reservation, 'utf8');
        const originalEvaluation = await readFile(join(root, 'run/evaluation.json'), 'utf8');
        const originalEvents = await readFile(join(root, 'observations.jsonl'), 'utf8');
        await writeFile(
          configuration,
          JSON.stringify({ ...config, outputDirectory: join(root, 'different-output') }),
        );
        const retry = Bun.spawn(
          [
            process.execPath,
            '--preload',
            lightObservationPreload,
            resolve(import.meta.dir, '../light.ts'),
            'run',
            configuration,
          ],
          {
            cwd: resolve(import.meta.dir, '../..'),
            env: {
              PATH: process.env.PATH,
              HOME: home,
              CODEX_HOME: home,
              TMPDIR: root,
              LIGHT_OBSERVATION_SETTINGS: settings,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const retryTimer = setTimeout(() => retry.kill(), 15000);
        try {
          const [out, err, exit] = await Promise.all([
            new Response(retry.stdout).text(),
            new Response(retry.stderr).text(),
            retry.exited,
          ]);
          assert(!retry.signalCode, `再実行の検証プロセスが中断: ${out}${err}`);
          expect(exit).not.toBe(0);
          expect(out + err).toMatch(/EEXIST|予約|reserv/i);
          expect(await readFile(join(root, 'observations.jsonl'), 'utf8')).toBe(originalEvents);
          expect(await readFile(reservation, 'utf8')).toBe(originalReservation);
          expect(await readdir(reservationRoot)).toEqual(names);
          expect(await readFile(join(root, 'run/evaluation.json'), 'utf8')).toBe(
            originalEvaluation,
          );
        } finally {
          clearTimeout(retryTimer);
          retry.kill();
        }
      }
      return {
        code,
        evaluation,
        records,
        events,
        home,
        logSizes: await logSizes(root, config.trialOrder),
      };
    } finally {
      clearTimeout(timer);
      worker.kill();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const scenario of ['normal', 'collection']) {
  test(`保存先の変更で同じ段階を再実行できず予約と原記録を保つ: ${scenario}`, async () => {
    const result = await observe(scenario, true);
    expect(result.events.filter((item) => item.event === 'exec')).toHaveLength(
      scenario === 'normal' ? 4 : 1,
    );
    expect(result.code === 0).toBe(scenario === 'normal');
  }, 40000);
}

for (const scenario of ['normal', 'cleanup', 'capacity-normal']) {
  test(`正常な回収・保存と別枠の終了観測を維持する: ${scenario}`, async () => {
    const result = await observe(scenario);
    expect(result.code).toBe(0);
    expect(result.evaluation.error).toBeNull();
    expect(result.events.filter((item) => item.event === 'exec')).toHaveLength(4);
    expect(result.records.every((item) => item.execution === 'completed')).toBe(true);
    expect(result.logSizes).toHaveLength(4);
    expect(result.logSizes.every((size) => size <= 16 * 1024 * 1024)).toBe(true);
    // cleanupは操作10ms＋終了観測200ms。100msの操作枠を超えても別枠30秒内。
  }, 20000);
}
for (const scenario of ['collection', 'save', 'aggregate', 'terminal']) {
  test(`実際の回収・保存で違反した後は起動せず成功記録にしない: ${scenario}`, async () => {
    const result = await observe(scenario);
    expect(result.code).not.toBe(0);
    expect(result.evaluation.error).toBeTruthy();
    expect(result.events.filter((item) => item.event === 'exec')).toHaveLength(1);
    expect(result.records[0]?.execution).not.toBe('completed');
    expect(
      result.records.slice(1).every((item) => !item.launched && item.execution === 'unevaluated'),
    ).toBe(true);
    if (scenario === 'collection' || scenario === 'save') {
      expect(
        result.events.some(
          (item) => item.event === `${scenario === 'collection' ? 'collection' : 'save'}-completed`,
        ),
      ).toBe(true);
    } else {
      expect(result.events.some((item) => item.event === 'bounded-output')).toBe(true);
      // 合計上限を守る。actor単体では枠内、各成果物は1byte、件数も上限内。
      expect(result.logSizes.every((size) => size <= 16 * 1024 * 1024)).toBe(true);
    }
  }, 20000);
}

test('通常登録とsymlinkのある普段の認証保存先を変更・複製せず4試行へ接続する', async () => {
  const result = await observe('registered');
  expect(result.code, String(result.evaluation.error)).toBe(0);
  expect(result.events.filter((item) => item.event === 'exec')).toHaveLength(4);
  expect(result.records.every((item) => item.execution === 'completed')).toBe(true);
  const auth = result.events.filter((item) => item.event === 'auth');
  expect(auth.length).toBeGreaterThanOrEqual(4);
  for (const item of [...auth, ...result.events.filter((item) => item.event === 'exec')]) {
    assert(isRecord(item.environment));
    expect(item.environment.CODEX_HOME).toBe(result.home);
    expect(JSON.stringify(item)).not.toContain('SYNTHETIC_SECRET_AUTH');
    expect(JSON.stringify(item)).not.toContain('SYNTHETIC_SECRET_ENV');
  }
});

test('試行間で把握した共通条件が変われば後続を止める', async () => {
  const result = await observe('registered-change');
  expect(result.events.filter((item) => item.event === 'exec')).toHaveLength(1);
  expect(result.evaluation.error).toBeTruthy();
  expect(
    result.records.slice(1).every((item) => !item.launched && item.execution === 'unevaluated'),
  ).toBe(true);
});
for (const scenario of ['auth-absent', 'auth-api', 'auth-unknown', 'auth-failed']) {
  test(`認証拒否時には推論を起動しない: ${scenario}`, async () => {
    const result = await observe(scenario);
    expect(result.code).not.toBe(0);
    expect(result.events.some((item) => item.event === 'auth')).toBe(true);
    expect(result.events.filter((item) => item.event === 'exec')).toHaveLength(0);
    expect(result.records.every((item) => !item.launched)).toBe(true);
  });
}
