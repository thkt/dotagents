import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test, expect } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  stat,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { develop } from '../../../implement/orchestrator.ts';
import { run } from '../../../implement/correction.ts';
import { createHash } from 'node:crypto';
import { reviewReplySource } from '../../support/correction.ts';
import { PublicationError } from '../../../implement/publish.ts';
import { command } from '../../../shared/process.ts';
import type { Config, State } from '../../../implement/input.ts';
import { isRecord } from '../../../shared/values.ts';
import { initializeTarget, githubTarget, targetConfig } from '../../support/target.ts';

import { gitOutput, issue, ok, mediaCapture, testDevelopment } from '../../support/development.ts';
import type { DevelopmentFixture } from '../../support/development.ts';

import {
  reportPath,
  reportContent,
  secondReport,
  commitReport,
  runDevelopment,
  noPublication,
  stopped,
  rejectedBeforeStart,
  verificationEvidence,
  verifiedLocal,
  publishedEvidence,
  commitSettings,
  initialStop,
  publicationFields,
  finalFields,
  ciStop,
  publicationReadStop,
} from '../../support/development-observations.ts';
testDevelopment('ローカル除外設定を引き継ぎ公開差分へ混入させない', async (f) => {
  await gitOutput(f.repo, 'rm', '--cached', '.dotagents.json');
  await gitOutput(f.repo, 'commit', '-m', 'local configuration');
  await writeFile(join(f.repo, '.git/info/exclude'), '/.dotagents.json\n');
  const original = await readFile(join(f.repo, '.dotagents.json'), 'utf8');
  const result = await develop(f.args, f.io);
  expect(result.status).toBe('published_draft');
  expect(await readFile(join(result.checkout, '.dotagents.json'), 'utf8')).toBe(original);
  expect(JSON.parse(await readFile(join(f.dir, 'target.json'), 'utf8'))).toMatchObject({
    text: original,
  });
  expect(await gitOutput(result.checkout, 'ls-tree', 'HEAD', '--', '.dotagents.json')).toBe('');
  expect(
    await gitOutput(result.checkout, 'diff', result.startCommit, 'HEAD', '--', '.dotagents.json'),
  ).toBe('');
  expect(f.calls.pushes).toBe(1);
  expect(await readFile(join(f.dir, 'pr.md'), 'utf8')).not.toContain(
    `/blob/${result.commit}/.dotagents.json`,
  );
});

testDevelopment(
  '設定以外がすべてstage済み削除でも公開できる',
  async (f) => {
    await gitOutput(f.repo, 'rm', '--cached', '.dotagents.json');
    await gitOutput(f.repo, 'commit', '-m', 'local configuration');
    await writeFile(join(f.repo, '.git/info/exclude'), '/.dotagents.json\n');
    const implement = f.implement;
    f.implement = async (...args) => {
      const response = await implement(...args);
      await gitOutput(args[1], 'rm', '--force', 'result.txt');
      return response;
    };
    f.verify = async (config) => {
      expect(await gitOutput(config.cwd, 'ls-files')).toBe('');
      const checked = await command(config.check, config.cwd, '', 10000);
      expect(checked.code).toBe(0);
      await mkdir(config.runDir, { recursive: true });
      await writeFile(join(config.runDir, 'review-2.stdout'), f.rawReview);
      return {
        reviewFormat: 4,
        issueFormat: 1,
        baseCommit: config.baseCommit ?? '',
        reviewHistory: f.history,
        configHash: '',
        issueHash: '',
        repair: 0,
        review: 1,
        checks: 1,
        modelMs: 1,
        active: null,
        events: [],
        findings: f.summary,
        result: 'ready_for_human_review',
      };
    };
    const result = await develop(f.args, f.io);
    expect(result.status).toBe('published_draft');
    expect(await gitOutput(result.checkout, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('');
    expect(
      await gitOutput(result.checkout, 'diff', '--name-status', result.startCommit, 'HEAD'),
    ).toBe('D\tresult.txt');
    expect(await readFile(join(result.checkout, '.dotagents.json'), 'utf8')).toBe(
      JSON.stringify(f.settings),
    );
    expect(f.calls.pushes).toBe(1);
    expect(f.calls.publications).toBe(1);
  },
  { setup: [], check: ['sh', '-c', 'test ! -e result.txt'] },
);

for (const phase of ['implementation', 'check', 'staging'] as const) {
  testDevelopment(`ローカル除外設定の差替えを拒否する: ${phase}`, async (f) => {
    await gitOutput(f.repo, 'rm', '--cached', '.dotagents.json');
    await gitOutput(f.repo, 'commit', '-m', 'local configuration');
    await writeFile(join(f.repo, '.git/info/exclude'), '/.dotagents.json\n');
    const change = async (cwd: string) => {
      const path = join(cwd, '.dotagents.json');
      await writeFile(path, (await readFile(path, 'utf8')) + '\n');
    };
    if (phase === 'implementation' || phase === 'staging') {
      const implement = f.implement;
      f.implement = async (...args) => {
        const result = await implement(...args);
        if (phase === 'staging') {
          await gitOutput(args[1], 'add', '--force', '.dotagents.json');
        } else {
          await change(args[1]);
        }
        return result;
      };
    } else {
      f.verify = async (config) => {
        await run({
          ...config,
          issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(issue)})`],
          check: ['sh', '-c', 'printf "\\n" >> .dotagents.json'],
        });
        throw Error('設定差替えの拒否が必要');
      };
    }
    await assert.rejects(
      () => develop(f.args, f.io),
      phase === 'staging'
        ? /ローカル対象設定をindexへ追加できません/
        : /Target configuration or GitHub actor changed|検証中に対象設定が変更されました/,
    );
    expect(f.calls.pushes).toBe(0);
    expect(f.calls.publications).toBe(0);
    expect(await gitOutput(join(f.dir, 'checkout'), 'rev-parse', 'HEAD')).toBe(
      await gitOutput(f.repo, 'rev-parse', 'HEAD'),
    );
  });
}

for (const mode of ['missing', 'invalid', 'symlink'] as const) {
  testDevelopment(`必須設定の${mode}を開始前に拒否する`, async (f) => {
    const path = join(f.repo, '.dotagents.json');
    if (mode === 'invalid') {
      await writeFile(path, '{}');
    } else {
      await rm(path);
      if (mode === 'symlink') {
        const outside = join(f.repo, '..', 'settings.json');
        await writeFile(outside, JSON.stringify(f.settings));
        await symlink(outside, path);
      }
    }
    await assert.rejects(
      () => develop(f.args, f.io),
      mode === 'missing'
        ? /ENOENT/
        : mode === 'invalid'
          ? /Invalid repository/
          : /対象設定は通常ファイルである必要があります/,
    );
    expect(existsSync(f.dir)).toBe(false);
    expect(f.calls.implementations).toBe(0);
    expect(f.calls.pushes).toBe(0);
  });
}

for (const advanceBranch of [false, true]) {
  testDevelopment(`検証済みSHAを送信して公開へ渡す: ブランチ更新=${advanceBranch}`, async (f) => {
    if (!advanceBranch) {
      await gitOutput(f.repo, 'rm', '--cached', '.dotagents.json');
      await gitOutput(f.repo, 'commit', '-m', 'local configuration');
    }
    const original = advanceBranch
      ? undefined
      : await readFile(join(f.repo, '.dotagents.json'), 'utf8');
    const remote = join(f.dir, 'receiver.git');
    let verified = '';
    let publishedCommit = '';
    const execute = f.io.command;
    f.io.command = async (argv, cwd, ...rest) => {
      if (argv[0] !== 'git' || !argv.includes('push')) {
        return execute(argv, cwd, ...rest);
      }
      verified = await gitOutput(cwd, 'rev-parse', 'HEAD');
      await gitOutput(cwd, 'init', '--bare', remote);
      // 最後の対象照合を通過した後、pushのIO境界でブランチを更新する。
      if (advanceBranch) {
        await writeFile(join(cwd, 'result.txt'), 'unverified');
        await gitOutput(cwd, 'add', 'result.txt');
        await gitOutput(cwd, 'commit', '-m', '未検証の並行更新');
      }
      await execute(argv, cwd, ...rest);
      // 生成された送信元は保ち、転送先と許可protocolだけを一時bare repoへ変更する。
      const local = argv.map((arg) =>
        arg.replace(`https://github.com/${f.settings.repository}.git`, remote),
      );
      local.splice(local.indexOf('push'), 0, '-c', 'protocol.file.allow=always');
      return command(local, cwd, ...rest);
    };
    const publication = f.publish;
    f.publish = async (input) => {
      publishedCommit = input.commit;
      return publication(input);
    };
    const prView = f.prView;
    f.prView = async (...args) => {
      const response = await prView(...args);
      const pr: unknown = JSON.parse(response.stdout);
      assert(isRecord(pr));
      return ok(
        JSON.stringify({
          ...pr,
          headRefOid: await gitOutput(remote, 'rev-parse', 'refs/heads/codex/development-99'),
        }),
      );
    };
    const outcome = await develop(f.args, f.io).catch((error: unknown) => error);
    // 後続処理の停止だけでは送信内容を保証できないため、受信した実体を先に照合する。
    expect(await gitOutput(remote, 'rev-parse', 'refs/heads/codex/development-99')).toBe(verified);
    const receivedConfig = await gitOutput(
      remote,
      'ls-tree',
      'refs/heads/codex/development-99',
      '--',
      '.dotagents.json',
    );
    expect(receivedConfig.length > 0).toBe(advanceBranch);
    expect(await gitOutput(remote, 'show', 'refs/heads/codex/development-99:result.txt')).toBe(
      'implemented',
    );
    const current = await gitOutput(join(f.dir, 'checkout'), 'rev-parse', 'HEAD');
    expect(current === verified).toBe(!advanceBranch);
    expect(publishedCommit).toBe(verified);
    assert(isRecord(outcome), String(outcome));
    expect(outcome).toMatchObject({ status: 'published_draft', commit: verified, ci: 'passed' });
    if (!advanceBranch) {
      assert(typeof original === 'string');
      expect(await readFile(join(f.dir, 'checkout/.dotagents.json'), 'utf8')).toBe(original);
      expect(JSON.parse(await readFile(join(f.dir, 'target.json'), 'utf8'))).toMatchObject({
        text: original,
      });
      expect(
        await gitOutput(
          join(f.dir, 'checkout'),
          'diff',
          String(outcome.startCommit),
          'HEAD',
          '--',
          '.dotagents.json',
        ),
      ).toBe('');
      expect(await readFile(join(f.dir, 'pr.md'), 'utf8')).not.toContain(
        `/blob/${verified}/.dotagents.json`,
      );
    }
  });
}

test('development CLI rejects a missing Issue before reading a target', () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dir, '../../../implement/development.ts')],
    {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Usage: bun scripts/implement/development.ts ISSUE');
});

testDevelopment('missing_check', async (f) => {
  await commitSettings(f, { ...f.settings, check: [] });
  await rejectedBeforeStart(f, /Verification command is required/);
});

testDevelopment(
  'no_ci',
  async (f) => {
    await rejectedBeforeStart(f, /Publishing requires expected CI checks/);
  },
  { ciChecks: [] },
);

testDevelopment(
  'local_no_ci',
  async (f) => {
    f.args.push('--no-publish');
    const result = await verifiedLocal(f);
    expect(result.remaining).not.toContain('ci');
  },
  { ciChecks: [] },
);

for (const [name, replacement, reason] of [
  ['wrong_repo', ['team/component', 'other/repo'], /GitHub repository mismatch/],
  ['denied_start', ['"push":true', '"push":false'], /GitHub push permission required/],
] as const) {
  testDevelopment(name, async (f) => {
    const github = f.github;
    f.github = async (...args) => {
      const response = await github(...args);
      return { ...response, stdout: response.stdout.replace(replacement[0], replacement[1]) };
    };
    await rejectedBeforeStart(f, reason);
  });
}

testDevelopment('local_denied', async (f) => {
  f.args.push('--no-publish');
  const github = f.github;
  f.github = async (...args) => {
    const response = await github(...args);
    return { ...response, stdout: response.stdout.replace('"push":true', '"push":false') };
  };
  expect((await verifiedLocal(f)).remaining).toContain('ci');
});

testDevelopment('wrong_issue', async (f) => {
  f.args[0] = 'https://github.com/other/repo/issues/99';
  await rejectedBeforeStart(f, /Issue does not match target repository/);
});

testDevelopment('wrong_push', async (f) => {
  await gitOutput(
    f.repo,
    'remote',
    'set-url',
    '--push',
    f.settings.remote,
    'git@github.com:other/repo.git',
  );
  await rejectedBeforeStart(f, /Remote\/repository mismatch/);
});

for (const [name, args, replacement, reason] of [
  ['permission_lost', [], ['"push":true', '"push":false'], /GitHub push permission required/],
  [
    'actor_changed',
    [],
    ['operator', 'different-operator'],
    /Target configuration or GitHub actor changed/,
  ],
  [
    'local_actor_changed',
    ['--no-publish'],
    ['operator', 'different-operator'],
    /Target configuration or GitHub actor changed/,
  ],
] as const) {
  testDevelopment(name, async (f) => {
    f.args.push(...args);
    const github = f.github;
    const verify = f.verify;
    let verified = false;
    f.verify = async (config) => {
      const state = await verify(config);
      verified = true;
      return state;
    };
    f.github = async (...args) => {
      const response = await github(...args);
      return verified
        ? { ...response, stdout: response.stdout.replace(replacement[0], replacement[1]) }
        : response;
    };
    await stopped(f, reason);
    expect(f.calls.verificationEntries).toBe(1);
    noPublication(f);
  });
}

for (const [name, change, reason] of [
  [
    'config_changed',
    async (config: Config, f: DevelopmentFixture) => {
      await writeFile(join(config.cwd, '.dotagents.json'), JSON.stringify(f.settings) + '\n');
    },
    /Target configuration or GitHub actor changed/,
  ],
  [
    'branch_changed',
    async (config: Config) => {
      await gitOutput(config.cwd, 'switch', '-c', 'unexpected');
    },
    /Actor changed branch or HEAD/,
  ],
  [
    'head_changed',
    async (config: Config) => {
      await gitOutput(config.cwd, 'add', '.');
      await gitOutput(config.cwd, 'commit', '-m', 'unexpected actor commit');
    },
    /Actor changed branch or HEAD/,
  ],
] as const) {
  testDevelopment(name, async (f) => {
    const verify = f.verify;
    f.verify = async (config) => {
      await change(config, f);
      return verify(config);
    };
    await stopped(f, reason);
    expect(f.calls.verificationEntries).toBe(1);
    noPublication(f);
  });
}

for (const status of ['repaired', 'needs_host'] as const) {
  testDevelopment(`requirements_changed after ${status}`, async (f) => {
    const implement = f.implement;
    f.implement = async (...args) => {
      const result = await implement(...args);
      return { ...result, stdout: JSON.stringify({ status, findings: 'Verification pending' }) };
    };
    const github = f.github;
    f.github = async (argv, ...rest) =>
      argv[1] === 'issue' && f.calls.implementations > 0
        ? ok(issue.replace('visible', 'different'))
        : github(argv, ...rest);
    await stopped(f, /Requirements changed during (implementation|host handoff)/);
    expect(f.calls.implementations).toBe(1);
    expect(f.calls.verificationEntries).toBe(0);
    expect(await Bun.file(join(f.dir, 'host-stop.json')).exists()).toBe(false);
    noPublication(f);
  });
}

for (const [name, response, reason] of [
  ['initial_failure', { code: 1 }, /Initial implementation process failed/],
  ['initial_timeout', { timedOut: true }, /Initial implementation timed out/],
] as const) {
  testDevelopment(name, async (f) => {
    const implement = f.implement;
    f.implement = async (...args) => ({ ...(await implement(...args)), ...response });
    await initialStop(f, reason);
    expect(await readFile(join(f.dir, 'implementation.stderr'), 'utf8')).toContain(
      'Actor diagnostic',
    );
    expect(existsSync(join(f.dir, 'implementation.json'))).toBe(true);
  });
}

for (const [name, reply, reason] of [
  [
    'needs_human',
    { status: 'needs_human', findings: 'Need agreement on scope' },
    /Human decision required: Need agreement on scope/,
  ],
  [
    'invalid_reply',
    { status: 'accepted', findings: 'Unexpected status' },
    /Invalid implementation reply/,
  ],
  [
    'blank_host',
    { status: 'needs_host', findings: ' \t\r\n\u3000' },
    /Invalid implementation reply/,
  ],
  [
    'blank_human',
    { status: 'needs_human', findings: ' \t\r\n\u3000' },
    /Invalid implementation reply/,
  ],
] as const) {
  testDevelopment(name, async (f) => {
    const stdout = JSON.stringify(reply);
    f.implement = async (_argv, cwd, _input, _timeout, prefix) => {
      await writeFile(`${prefix}.stdout`, stdout);
      await writeFile(`${prefix}.stderr`, 'Actor diagnostic');
      await writeFile(join(cwd, 'result.txt'), 'implemented');
      return { ...ok(stdout), ms: 500 };
    };
    const saved = await initialStop(f, reason);
    expect(await readFile(join(f.dir, 'implementation.stderr'), 'utf8')).toContain(
      'Actor diagnostic',
    );
    expect(existsSync(join(f.dir, 'implementation.json'))).toBe(true);
    expect(await readFile(join(f.dir, 'checkout/result.txt'), 'utf8')).toBe('implemented');
    expect(await readFile(join(f.dir, 'implementation.stdout'), 'utf8')).toBe(stdout);
    expect(existsSync(join(f.dir, 'implementation-summary.md'))).toBe(name === 'needs_human');
    if (name === 'needs_human') {
      expect(saved.reasonCode).toBe('human_decision_required');
      expect(saved.nextAction).toContain('human decision');
      expect(await readFile(join(f.dir, 'implementation-summary.md'), 'utf8')).toBe(
        'Need agreement on scope',
      );
    }
  });
}

for (const [result, nextAction] of [
  ['review_storage_failed', 'writable evidence storage'],
  ['invalid_review', null],
  ['check_unavailable', null],
  ['capture_unavailable', 'capture logs and configured runtime'],
  ['human_decision_required', 'human decision described in the repair findings'],
] as const) {
  testDevelopment(result, async (f) => {
    const verify = f.verify;
    f.verify = async (config) => ({ ...(await verify(config)), result });
    const saved = await stopped(f, new RegExp(`Verification stopped: ${result}`));
    expect(saved.reasonCode).toBe(result);
    if (result === 'invalid_review') {
      // Issue要求5: 表現の綴りではなく、診断・生成側の修正と限定した新runの入口を守る。
      expect(saved.nextAction).toMatch(/原応答|raw review response/i);
      expect(saved.nextAction).toMatch(/応答生成|response producer|response generat/i);
      expect(saved.nextAction).toContain('--review-run');
      expect(saved.nextAction).toContain('--run-dir');
      expect(saved.nextAction).toMatch(/初回|first|initial/i);
      expect(saved.nextAction).toMatch(/未公開|unpublished/i);
      expect(saved.nextAction).toMatch(
        /履歴なし|no (?:valid )?(?:review )?history|without.*history/i,
      );
      expect(saved.nextAction).toMatch(/追加修正なし|no (?:additional )?repairs?|without.*repair/i);
      expect(saved.nextAction).toMatch(
        /旧応答.*編集.*再投入.*ない|(?:do not|never).*edit.*re.?submit/i,
      );
    } else if (result === 'check_unavailable') {
      expect(saved.nextAction).toMatch(/check/i);
      expect(saved.nextAction).toMatch(/起動失敗|startup/i);
      expect(saved.nextAction).toMatch(/時間切れ|timeout/i);
      expect(saved.nextAction).toMatch(/原ログ|command logs/i);
    } else {
      expect(saved.nextAction).toContain(nextAction);
    }
    expect(saved.nextAction).toContain('Evidence: ' + join(f.dir, 'verification/state.json'));
    expect(saved.nextAction).toContain(
      'reconfirm target, evidence, authorization and verification',
    );
    expect(saved.nextAction).toContain('Do not resume this run');
    expect(saved.publication).toBe('not_attempted');
    expect(saved.remaining).toContain('local_verification');
    expect(f.calls.verificationEntries).toBe(1);
    noPublication(f);
    const statePath = await verificationEvidence(f, result);
    expect(saved.details).toBe(statePath);
  });
}

testDevelopment('review_failure', async (f) => {
  const verify = f.verify;
  f.verify = async (config) => ({ ...(await verify(config)), result: 'review_failed' });
  const saved = await stopped(f, /Verification stopped: review_failed/);
  expect(saved).toMatchObject({ phase: 'verification', reasonCode: 'review_failed' });
  noPublication(f);
  const statePath = await verificationEvidence(f, 'review_failed');
  expect(saved.details).toBe(statePath);
});

testDevelopment('source_changed', async (f) => {
  const verify = f.verify;
  f.verify = async (config) => {
    // commit前に、保存済み終端結果を再照合する入口で変化を返す。
    const retained = await Bun.file(join(config.runDir, 'state.json')).exists();
    return {
      ...(await verify(config)),
      result: retained ? 'target_changed_after_stop' : 'ready_for_human_review',
    };
  };
  const saved = await stopped(f, /Verification stopped: target_changed_after_stop/);
  expect(saved).toMatchObject({ phase: 'verification', reasonCode: 'target_changed_after_stop' });
  expect(f.calls.verificationEntries).toBe(2);
  noPublication(f);
  const statePath = await verificationEvidence(f, 'ready_for_human_review');
  expect(saved.details).toBe(statePath);
});
for (const [name, error, url] of [
  ['publication_unconfirmed', Error('PR author or body could not be confirmed'), undefined],
  [
    'publication_readback_unconfirmed',
    new PublicationError(
      'https://github.com/team/component/pull/100',
      Error('PR author or body could not be confirmed'),
    ),
    'https://github.com/team/component/pull/100',
  ],
] as const) {
  testDevelopment(name, async (f) => {
    const publish = f.publish;
    f.publish = async (input) => {
      await publish(input);
      throw error;
    };
    const saved = await stopped(f, /PR author or body could not be confirmed/);
    await publishedEvidence(f, saved);
    expect(saved).toMatchObject({ publication: 'unconfirmed', phase: 'publication' });
    expect(saved.url).toBe(url);
    expect(saved.ci).toBeUndefined();
    expect(existsSync(join(f.dir, 'pr-url.txt'))).toBe(false);
    expect(f.calls.attachments).toBe(0);
    expect(f.prReads).toEqual([]);
  });
}

testDevelopment('existing_ready_pr', async (f) => {
  const github = f.github;
  f.github = async (argv, ...rest) =>
    argv[2] === `repos/${f.settings.repository}/pulls`
      ? ok(
          JSON.stringify([
            [
              {
                html_url: 'https://github.com/team/component/pull/100',
                head: { ref: 'codex/development-99', repo: { full_name: f.settings.repository } },
              },
            ],
          ]),
        )
      : github(argv, ...rest);
  await stopped(f, /Open PR already uses this branch/);
  noPublication(f);
});

async function attachmentStop(f: DevelopmentFixture, reason: RegExp) {
  const saved = await stopped(f, reason);
  await publishedEvidence(f, saved);
  expect(saved).toMatchObject({ publication: 'published', phase: 'publication' });
  expect(saved.url).toBe(await readFile(join(f.dir, 'pr-url.txt'), 'utf8'));
  expect(saved.url).toContain('/pull/100');
  expect(saved.ci).toBeUndefined();
  expect(saved.remaining).toEqual([
    'ci',
    'published_body_check',
    'mark_ready',
    'human_review',
    'attachments',
    'rendered_media_check',
  ]);
  expect(f.prReads).toEqual([]);
}

testDevelopment(
  'attachment_failure',
  async (f) => {
    const github = f.github;
    f.github = async (argv, ...rest) =>
      argv[1] === 'pr' && argv[2] === 'edit'
        ? { ...ok(), code: 1, stderr: 'attachment fixture failure' }
        : github(argv, ...rest);
    await attachmentStop(f, /attachment fixture failure/);
    expect(f.calls.attachments).toBe(1);
  },
  { capture: mediaCapture },
);

testDevelopment(
  'attachment_actor_changed',
  async (f) => {
    const github = f.github;
    f.github = async (...args) => {
      const response = await github(...args);
      return f.calls.publications > 0
        ? { ...response, stdout: response.stdout.replace('operator', 'different-operator') }
        : response;
    };
    await attachmentStop(f, /Target configuration or GitHub actor changed/);
    expect(f.calls.attachments).toBe(0);
  },
  { capture: mediaCapture },
);

testDevelopment(
  'attachment_draft_changed',
  async (f) => {
    const github = f.github;
    f.github = async (argv, ...rest) => {
      const response = await github(argv, ...rest);
      return argv[2] === `repos/${f.settings.repository}/pulls/100`
        ? { ...response, stdout: response.stdout.replace('"draft":true', '"draft":false') }
        : response;
    };
    await attachmentStop(f, /not confirmed draft/);
    expect(f.calls.attachments).toBe(0);
  },
  { capture: mediaCapture },
);

// CI owns the initial target field matrix; development retains the stop/result connection.
testDevelopment('CI publication rejects changed head', async (f) => {
  const prView = f.prView;
  f.prView = async (argv, cwd, timeout) => {
    const response = await prView(argv, cwd, timeout);
    if (argv.at(-1) !== publicationFields) {
      return response;
    }
    const view: unknown = JSON.parse(response.stdout);
    assert(isRecord(view));
    return { ...response, stdout: JSON.stringify({ ...view, headRefOid: 'another-commit' }) };
  };
  await publicationReadStop(f, 'target_changed', 'Reconcile', 'head=another-commit');
});

testDevelopment('ci_failure', async (f) => {
  const prView = f.prView;
  f.prView = async (argv, ...rest) => {
    const response = await prView(argv, ...rest);
    return argv.at(-1) === publicationFields
      ? { ...response, stdout: response.stdout.replace('SUCCESS', 'FAILURE') }
      : response;
  };
  const { saved, details } = await ciStop(f, 'failed', 'Inspect failing');
  expect(f.prReads).toEqual([publicationFields, finalFields]);
  const published: unknown = JSON.parse(await readFile(join(f.dir, 'pr.json'), 'utf8'));
  assert(isRecord(published));
  expect(published.headRefOid).toBe(saved.commit);
  expect(details.logs).toContain(join(f.dir, 'pr-publication'));
  expect(await readFile(join(f.dir, 'pr-publication.stdout'), 'utf8')).toContain('headRefOid');
});

for (const [name, failure, status, action, output] of [
  [
    'ci_final_unavailable',
    { code: 1, stdout: 'raw API response', stderr: 'API unavailable in fixture' },
    'unavailable',
    'Check gh',
    'raw API response',
  ],
  ['ci_final_target_changed', {}, 'target_changed', 'Reconcile', 'headRefOid'],
] as const) {
  testDevelopment(name, async (f) => {
    const prView = f.prView;
    f.prView = async (argv, cwd, timeout) => {
      if (argv.at(-1) !== finalFields) {
        return prView(argv, cwd, timeout);
      }
      expect(timeout).toBe(660000);
      if ('code' in failure) {
        return { ...ok(), ...failure };
      }
      return ok(
        JSON.stringify({
          headRefOid: 'another-commit',
          baseRefName: f.settings.baseBranch,
          state: 'OPEN',
          isDraft: true,
        }),
      );
    };
    const { saved, details } = await ciStop(f, status, action);
    expect(f.prReads).toEqual([publicationFields, finalFields]);
    const published: unknown = JSON.parse(await readFile(join(f.dir, 'pr.json'), 'utf8'));
    assert(isRecord(published));
    expect(published.headRefOid).toBe(saved.commit);
    const log = join(f.dir, 'ci-final-target');
    expect(details.logs).toContain(log);
    expect(details.lastObservation).toMatchObject({ status: 'passed' });
    expect(await readFile(`${log}.stdout`, 'utf8')).toContain(output);
    if ('stderr' in failure) {
      expect(await readFile(`${log}.stderr`, 'utf8')).toBe('API unavailable in fixture');
    }
  });
}

testDevelopment(
  'success',
  async (f) => {
    const { dir, history, args, io, prReads } = f;
    const internal = JSON.stringify(history);
    const implement = f.implement;
    f.implement = async (...args) => {
      const input = args[2];
      expect(input).toContain(JSON.stringify(f.settings));
      expect(input).toContain(issue);

      return { ...(await implement(...args)), ms: 1200001 };
    };
    const verify = f.verify;
    f.verify = async (config) => {
      expect(config.capture?.length).toBeGreaterThan(0);
      return verify(config);
    };
    const prView = f.prView;
    f.prView = async (...args) => {
      const response = await prView(...args);
      // CI must use the observation after attachment, not stale pre-attachment checks.
      return f.calls.attachments === 0
        ? { ...response, stdout: response.stdout.replace('SUCCESS', 'FAILURE') }
        : response;
    };
    const result = await runDevelopment(f);
    assert(result.ciDetails);
    const beforeCollision = await readFile(join(dir, 'result.json'), 'utf8');
    expect(JSON.parse(beforeCollision)).toEqual(result);
    expect(result.evidence).toBe(dir);
    expect(result.ci).toBe('passed');
    expect(prReads).toEqual([
      'url,headRefOid,baseRefName,state,isDraft,body,statusCheckRollup',
      'headRefOid,baseRefName,state,isDraft',
    ]);
    expect(result.ciDetails.logs).toEqual([
      join(dir, 'pr-publication'),
      join(dir, 'ci-final-target'),
    ]);
    expect(await readFile(join(dir, 'pr.json'), 'utf8')).toContain('Attached media');
    expect(existsSync(join(dir, 'ci-registration-1.stdout'))).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'implementation.json'), 'utf8'))).toEqual({
      code: 0,
      timedOut: false,
      ms: 1200001,
    });
    expect(JSON.parse(await readFile(join(dir, 'verification-config.json'), 'utf8'))).toMatchObject(
      {
        checkTimeMs: null,
      },
    );
    expect(result.url).toContain('/pull/100');
    expect(f.calls.publications).toBe(1);
    const body = await readFile(join(dir, 'pr.md'), 'utf8');
    expect(body).toContain('Keep the requested result visible until reset');
    expect(body).toContain('詳細は（内部パス省略）を確認済みだが実サービスのタイミングは未確認。');
    expect(body).toContain('The /home/settings route now preserves the selected filters');
    expect(body).toContain('https://example.com/results');
    expect(body).toContain('Issue #99 requires a visible result');
    expect(body).toContain('Reset and empty-input checks passed');
    expect(body).toContain('Reset now clears the result, confirmed by the reset check');
    expect(body).not.toContain('Reset left stale content.');
    expect(body).not.toContain('Readers could see an obsolete result.');
    expect(body).toContain('Live service timing is unmeasured');
    expect(body).toContain('Timing may differ in production.');
    expect(body).toContain('Report live service timing as unverified');
    expect(body).toContain('focus movement remains an unagreed proposal');
    expect(body).toContain(`/blob/${result.commit}/.dotagents.json`);
    expect(body).toContain('its success does not establish live service behavior');
    expect(body).toContain('対象commit: ' + result.commit);
    expect(body).toContain('Closes #99');
    expect(body).toContain(
      'https://github.com/thkt/dotagents/blob/main/scripts/README.md#公開後確認とreadyへの切替',
    );
    // 固定説明の綴りではなく、残作業・担当・動的な引継ぎを確認する。
    expect(body).toContain('## 残作業と担当');
    expect(body).toMatch(/CLI:[^\n]*draft[^\n]*同じheadのCI（checks）/);
    expect(body).toMatch(/CLI:[^\n]*媒体[^\n]*review\/media\/view\.png/);
    for (const responsibility of [
      'rendered_media_check',
      'published_body_check',
      'mark_ready',
      '人:',
    ]) {
      expect(body.split(responsibility)).toHaveLength(2);
    }
    expect(body).toMatch(
      /担当AI:[^\n]*実際のPR画面[^\n]*媒体[^\n]*表示・再生[^\n]*説明・配置[^\n]*確認[^\n]*rendered_media_check/,
    );
    expect(body).toMatch(
      /担当AI:[^\n]*公開本文[^\n]*Issue[^\n]*対象commit[^\n]*accepted評価[^\n]*検証結果[^\n]*照合[^\n]*published_body_check[^\n]*mark_ready/,
    );
    expect(body).toMatch(/人:[^\n]*要求[^\n]*権限[^\n]*レビュー・承認・マージ/);
    expect(body).toMatch(/draft公開[^\n]*CI[^\n]*ready切替[^\n]*人の承認[^\n]*未完了/);
    [
      '担当AI: 実サービスAの応答が遅い場合、結果の保持時間を計測する。現時点では未計測（（内部パス省略））。',
      '運用担当: 実サービスBの応答が遅い場合、結果の保持時間を計測する。現時点では未計測。',
    ].forEach((task) => {
      expect(body.split(task)).toHaveLength(2);
    });
    expect(result.remaining).toEqual([
      'published_body_check',
      'mark_ready',
      'human_review',
      'rendered_media_check',
    ]);
    [
      dir,
      'RAW_LOG_ONLY',
      'internal-old-target',
      'internal-current-target',
      'check-2.stdout',
      'review-1.json',
    ].forEach((privateDetail) => {
      expect(body).not.toContain(privateDetail);
    });
    expect(JSON.stringify(history)).toBe(internal);
    expect(body).not.toContain('Implementation claim, not verification');
    await assert.rejects(() => develop(args, io), /EEXIST.*no safe new run directory/);
    expect(await readFile(join(dir, 'result.json'), 'utf8')).toBe(beforeCollision);
    expect(f.calls.implementations).toBe(1);
    expect(f.calls.publications).toBe(1);

    await verificationEvidence(f, 'ready_for_human_review');
  },
  { capture: mediaCapture },
);

testDevelopment('other_repo', async (f) => {
  const { repo, settings } = f;
  await writeFile(join(repo, 'notes.txt'), 'committed notes');
  await gitOutput(repo, 'add', '--', 'notes.txt');
  await commitReport(repo);
  await writeFile(join(repo, 'notes.txt'), 'staged notes');
  await gitOutput(repo, 'add', '--', 'notes.txt');
  await writeFile(join(repo, 'notes.txt'), 'working notes');
  await chmod(join(repo, 'notes.txt'), 0o755);
  await writeFile(join(repo, 'unrelated.txt'), 'retain');
  await chmod(join(repo, 'unrelated.txt'), 0o751);

  const original = await gitOutput(repo, 'rev-parse', 'HEAD');
  f.args.push(
    '--no-publish',
    '--start-commit',
    original,
    '--report',
    `${reportPath}=${await gitOutput(repo, 'rev-parse', `HEAD:${reportPath}`)}`,
    '--report',
    `${secondReport}=${await gitOutput(repo, 'rev-parse', `HEAD:${secondReport}`)}`,
  );
  const implement = f.implement;
  f.implement = async (argv, cwd, input, timeout, prefix) => {
    expect(await gitOutput(cwd, 'rev-parse', 'HEAD')).toBe(original);
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('committed notes');
    expect((await stat(join(cwd, 'notes.txt'))).mode & 0o111).toBe(0);
    expect(existsSync(join(cwd, 'unrelated.txt'))).toBe(false);
    expect(await readFile(join(cwd, '.dotagents.json'), 'utf8')).toBe(JSON.stringify(settings));
    expect(input).toContain(JSON.stringify(settings));
    expect(await readFile(join(cwd, 'setup.txt'), 'utf8')).toBe('configured');
    expect(await readFile(join(cwd, reportPath), 'utf8')).toBe(reportContent);
    expect(await readFile(join(cwd, secondReport), 'utf8')).toBe(
      'Existing result tests cover reset and empty input.\n',
    );
    expect(input).toContain(reportPath);
    expect(input).toContain(secondReport);
    expect(input).toContain(original);
    expect(input).not.toContain(reportContent.trim());

    return implement(argv, cwd, input, timeout, prefix);
  };
  const verify = f.verify;
  f.verify = async (config) => {
    expect(config.baseCommit).toBe(original);
    expect(config.reports).toEqual([
      { path: reportPath, blob: await gitOutput(repo, 'rev-parse', `HEAD:${reportPath}`) },
      { path: secondReport, blob: await gitOutput(repo, 'rev-parse', `HEAD:${secondReport}`) },
    ]);
    expect(config.check).toEqual(settings.check);
    expect(config.capture).toBeUndefined();
    expect((await command(config.check, config.cwd, '', 10000)).code).toBe(0);

    return verify(config);
  };
  expect((await verifiedLocal(f)).remaining).toContain('ci');
});

async function startInputFixture(root: string) {
  const repo = join(root, 'repo');
  const dir = join(root, 'run');
  const settings = { ...targetConfig, setup: [['fixture-setup']] };
  await mkdir(repo);
  await initializeTarget(repo, settings);
  const beforeReport = await gitOutput(repo, 'rev-parse', 'HEAD');
  const blob = await commitReport(repo);
  const base = await gitOutput(repo, 'rev-parse', 'HEAD');
  const args = [
    '99',
    '--repo',
    repo,
    '--run-dir',
    dir,
    '--no-publish',
    '--report',
    `${reportPath}=${blob}`,
  ];
  const hooks: {
    setups: number;
    issue?: string;
    changeDuring?: (event: 'target' | 'issue' | 'setup', cwd: string) => Promise<void>;
  } = { setups: 0 };
  const io = {
    command: async (argv: string[], cwd: string, input: string, timeout: number | null) => {
      const reply = githubTarget(argv, settings);
      if (reply !== undefined) {
        if (argv[2] === 'user') {
          await hooks.changeDuring?.('target', cwd);
        }
        return ok(reply);
      }
      if (argv[0] === 'git') {
        return command(argv, cwd, input, timeout);
      }
      if (argv[0] === 'gh' && argv[1] === 'issue') {
        await hooks.changeDuring?.('issue', cwd);
        return ok(hooks.issue ?? issue);
      }
      if (argv[0] === 'fixture-setup') {
        hooks.setups++;
        await hooks.changeDuring?.('setup', cwd);
        return ok();
      }
      throw Error(`Implementation must not start: ${argv[0]}`);
    },
    verify: async (): Promise<State> => {
      throw Error('Verification must not start');
    },
    publish: async (): Promise<string> => {
      throw Error('Publication must not start');
    },
  };
  return { repo, dir, beforeReport, blob, base, args, hooks, io };
}

function testStartInput(
  name: string,
  run: (fixture: Awaited<ReturnType<typeof startInputFixture>>) => Promise<void>,
) {
  test(name, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'development-input-')));
    try {
      await run(await startInputFixture(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const handoffFailures = {
  missing: /Required report is missing from start commit.*docs\/research\/result-behavior.md/,
  uncommitted: /Required report is missing from start commit.*docs\/research\/result-behavior.md/,
  modified: /Required report has uncommitted content.*docs\/research\/result-behavior.md/,
  different_blob:
    /Required report differs from reviewed version.*docs\/research\/result-behavior.md/,
  different_start: /Start commit differs from handoff/,
  no_start: /Required reports need --start-commit/,
  setup_modified: /Required report has uncommitted content.*docs\/research\/result-behavior.md/,
};

for (const [mode, reason] of Object.entries(handoffFailures)) {
  testStartInput(`development stops incomplete research handoff: ${mode}`, async (fixture) => {
    const { repo, dir, beforeReport, base, args, hooks, io } = fixture;
    if (mode === 'missing' || mode === 'uncommitted') {
      await gitOutput(repo, 'reset', '--hard', beforeReport);
      if (mode === 'uncommitted') {
        await mkdir(join(repo, 'docs/research'), { recursive: true });
        await writeFile(join(repo, reportPath), reportContent);
      }
    }
    if (mode === 'modified') {
      await writeFile(join(repo, reportPath), 'Unchecked working report.\n');
    }
    if (mode === 'different_blob') {
      await writeFile(join(repo, reportPath), 'A different committed report.\n');
      await gitOutput(repo, 'add', '--', reportPath);
      await gitOutput(repo, 'commit', '-m', 'changed report');
      args.unshift(
        '--report',
        `${secondReport}=${await gitOutput(repo, 'rev-parse', `HEAD:${secondReport}`)}`,
      );
    }
    if (mode !== 'setup_modified') {
      await writeFile(join(repo, 'unrelated.txt'), 'Preserve other work');
    }
    const head = await gitOutput(repo, 'rev-parse', 'HEAD');
    const status = await gitOutput(repo, 'status', '--porcelain');
    hooks.changeDuring = async (event, cwd) => {
      if (event === 'setup') {
        await writeFile(join(cwd, reportPath), 'Setup replaced the reviewed content.\n');
      }
    };
    if (mode !== 'no_start') {
      args.push('--start-commit', mode === 'different_start' ? beforeReport : head);
    }
    await assert.rejects(() => develop(args, io), reason);
    expect(hooks.setups).toBe(mode === 'setup_modified' ? 1 : 0);
    expect(existsSync(join(dir, 'checkout'))).toBe(mode === 'setup_modified');
    expect(await gitOutput(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(await gitOutput(repo, 'status', '--porcelain')).toBe(status);
    if (mode !== 'setup_modified') {
      expect(await readFile(join(repo, 'unrelated.txt'), 'utf8')).toBe('Preserve other work');
    } else {
      expect(head).toBe(base);
      expect(await readFile(join(repo, reportPath), 'utf8')).toBe(reportContent);
    }
  });
}

const startChanges = {
  config: async (repo: string) => {
    const path = join(repo, '.dotagents.json');
    await writeFile(path, (await readFile(path, 'utf8')) + '\n');
  },
  config_index: async (repo: string) => {
    const path = join(repo, '.dotagents.json');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original + '\n');
    await gitOutput(repo, 'add', '--', '.dotagents.json');
    await writeFile(path, original);
  },
  report: async (repo: string) => {
    await writeFile(join(repo, reportPath), 'Unreviewed report.\n');
  },
  report_index: async (repo: string) => {
    await writeFile(join(repo, reportPath), 'Unreviewed report.\n');
    await gitOutput(repo, 'add', '--', reportPath);
    await writeFile(join(repo, reportPath), reportContent);
  },
  report_mode: async (repo: string) => {
    await gitOutput(repo, 'config', 'core.filemode', 'false');
    await chmod(join(repo, reportPath), 0o755);
  },
  report_missing: async (repo: string) => {
    await rm(join(repo, reportPath));
  },
  head: async (repo: string) => {
    await gitOutput(repo, 'commit', '--allow-empty', '-m', 'concurrent HEAD change');
  },
  push: async (repo: string) => {
    await gitOutput(
      repo,
      'remote',
      'set-url',
      '--push',
      targetConfig.remote,
      'https://github.com/other/repo.git',
    );
  },
};

for (const [phase, change, reason] of [
  ['initial', 'config', /Target configuration differs from start commit/],
  ['initial', 'config_index', /Required start inputs have uncommitted changes/],
  ['initial', 'report_index', /Required start inputs have uncommitted changes/],
  ['initial', 'report_mode', /Required start inputs have uncommitted changes/],
  ['initial', 'report_missing', /Required report is missing or not a regular checkout file/],
  ['target', 'head', /Start HEAD changed during preparation/],
  ['issue', 'head', /Start HEAD changed during preparation/],
  ['setup', 'config', /Target configuration differs from start commit/],
  ['setup', 'report', /Required report has uncommitted content/],
  ['setup', 'head', /Start HEAD changed during preparation/],
  ['setup', 'push', /Remote\/repository mismatch/],
  ['checkout_setup', 'config', /Target configuration or GitHub actor changed/],
  ['checkout_setup', 'report_index', /Required start inputs have uncommitted changes/],
  ['checkout_setup', 'report_mode', /Required start inputs have uncommitted changes/],
] as const) {
  testStartInput(`development rejects changed start input: ${phase} ${change}`, async (fixture) => {
    const { repo, dir, base, args, hooks, io } = fixture;
    await writeFile(join(repo, 'unrelated.txt'), 'Preserve other work');
    if (phase === 'initial') {
      await startChanges[change](repo);
    }
    hooks.changeDuring = async (event, cwd) => {
      if (phase === event) {
        await startChanges[change](repo);
      }
      if (phase === 'checkout_setup' && event === 'setup') {
        await startChanges[change](cwd);
      }
    };
    args.push('--start-commit', base);
    await assert.rejects(() => develop(args, io), reason);
    expect(hooks.setups).toBe(phase.endsWith('setup') ? 1 : 0);
    expect(existsSync(join(dir, 'checkout'))).toBe(phase.endsWith('setup'));
    expect(await readFile(join(repo, 'unrelated.txt'), 'utf8')).toBe('Preserve other work');
  });
}

for (const location of ['checkout', 'git', 'symlink'] as const) {
  testStartInput(
    `development does not save into unsafe ${location} storage`,
    async ({ repo, args, base, hooks, io }) => {
      const dir = join(repo, location === 'git' ? '.git/unsafe-run' : 'unsafe-run');
      if (location === 'git') {
        // With a linked checkout, common Git storage lies outside the checkout guard.
        const checkout = join(repo, '..', 'linked-checkout');
        await gitOutput(repo, 'worktree', 'add', '-b', 'fixture-linked', checkout, base);
        args[args.indexOf('--repo') + 1] = checkout;
      }
      let requested = dir;
      if (location === 'symlink') {
        const link = join(repo, '..', 'repository-link');
        await symlink(repo, link);
        requested = join(link, 'unsafe-run');
      }
      const index = args.indexOf('--run-dir');
      args[index + 1] = requested;
      args.push('--start-commit', base);
      await assert.rejects(
        () => develop(args, io),
        /Run directory.*result not saved: no safe new run directory/,
      );
      expect(hooks.setups).toBe(0);
      expect(existsSync(dir)).toBe(false);
    },
  );
}

for (const suffix of ['', '\n']) {
  testDevelopment(
    `Issue acquisition and verification share saved JSON: suffix=${JSON.stringify(suffix)}`,
    async (f) => {
      const text = JSON.stringify({
        title: '日本語',
        body: '  Show the requested result. 本文\n\n末尾 \n',
        state: 'OPEN',
        updatedAt: '1',
      });
      const raw = text + suffix;
      const github = f.github;
      f.github = async (argv, ...rest) => (argv[1] === 'issue' ? ok(raw) : github(argv, ...rest));
      f.args.push('--no-publish');
      f.verify = (config) =>
        run({
          ...config,
          issue: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(raw)})`],
          review: [
            process.execPath,
            '-e',
            `const {readFileSync}=require('node:fs'); const role='review'; ${reviewReplySource} console.log(JSON.stringify(reviewReply('accepted','Verified')));`,
          ],
        });
      const result = await runDevelopment(f);
      expect(result.status).toBe('verified_local');
      const saved = await readFile(join(f.dir, 'issue.json'), 'utf8');
      expect(saved).toBe(text);
      expect(await readFile(join(f.dir, 'issue.stdout'), 'utf8')).toBe(raw);
      const state: unknown = JSON.parse(
        await readFile(join(f.dir, 'verification/state.json'), 'utf8'),
      );
      assert(isRecord(state));
      expect(state.issueHash).toBe(createHash('sha256').update(saved).digest('hex'));
      noPublication(f);
    },
  );
}
