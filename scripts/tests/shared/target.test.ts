import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeTarget, git, githubTarget, targetConfig } from '../support/target.ts';
import { readTarget, pushArguments, issueNumber, targetCommand } from '../../shared/target.ts';
import { command } from '../../shared/process.ts';

test('target commands resolve the trusted harness root after source relocation', () => {
  expect(targetCommand(['bun', '{harness}/scripts/capture/capture.ts'])).toEqual([
    'bun',
    join(import.meta.dir, '../../..', 'scripts/capture/capture.ts'),
  ]);
});

test('target CLI resolves another checkout and enforces Issue and write arguments', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'target-cli-')));
  const cwd = join(root, 'checkout');
  const bin = join(root, 'bin');
  try {
    await mkdir(cwd);
    await mkdir(bin);
    await initializeTarget(cwd);
    const gh = join(bin, 'gh');
    await writeFile(
      gh,
      `#!/bin/sh
case "$*" in
  'api repos/team/component') echo '{"full_name":"team/component","id":123,"permissions":{"push":false}}' ;;
  'api repos/team/component/branches/release') echo '{"name":"release"}' ;;
  'api user') echo '{"login":"reader"}' ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(gh, 0o755);
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [join(import.meta.dir, '../../scoping/target.ts'), cwd, ...args],
        {
          cwd: root,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_HOST: 'github.com' },
          encoding: 'utf8',
          timeout: 10000,
        },
      );
    const issue = 'https://github.com/team/component/issues/12';
    const valid = run(issue);
    expect(valid.status).toBe(0);
    expect(valid.stderr).toBe('');
    expect(JSON.parse(valid.stdout)).toMatchObject({
      cwd,
      repositoryId: 123,
      actor: 'reader',
      config: targetConfig,
    });
    const denied = run(issue, '--write');
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('GitHub push permission required');
    const wrongIssue = run('https://github.com/other/component/issues/12');
    expect(wrongIssue.status).toBe(1);
    expect(wrongIssue.stdout).toBe('');
    expect(wrongIssue.stderr).toContain('Issue does not match target repository');
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('push uses the verified HTTPS target despite pushInsteadOf and rejects insteadOf', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'push-target-'));
  try {
    await initializeTarget(cwd);
    git(cwd, 'config', 'remote.upstream.pushurl', 'git@github.com:team/component.git');
    git(cwd, 'config', 'url.git@github.com:other/.pushInsteadOf', 'https://github.com/team/');
    const read = async (argv: string[]) => git(cwd, ...argv.slice(1));
    expect(git(cwd, 'remote', 'get-url', '--push', 'upstream')).toBe(
      'git@github.com:team/component.git',
    );
    const args = await pushArguments('team/component', 'codex/test', cwd, read);
    const options = args.slice(1, args.indexOf('push'));
    expect(git(cwd, ...options, 'ls-remote', '--get-url', 'dotagents-publish')).toBe(
      'https://github.com/team/component.git',
    );
    expect(args.slice(-2)).toEqual(['dotagents-publish', 'codex/test:refs/heads/codex/test']);
    // Resolve the actual push transport, but forbid it before any network access.
    const probe = spawnSync(
      'git',
      [
        ...options,
        '-c',
        'protocol.https.allow=never',
        'push',
        '--dry-run',
        'dotagents-publish',
        'HEAD:refs/heads/codex/test',
      ],
      { cwd, encoding: 'utf8', timeout: 10000 },
    );
    expect(probe.status).toBe(128);
    expect(probe.stderr).toContain("transport 'https' not allowed");

    git(cwd, 'config', 'url.git@github.com:other/.insteadOf', 'https://github.com/team/');
    await assert.rejects(
      () => pushArguments('team/component', 'codex/test', cwd, read),
      /Effective push URL/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('target preserves empty and whitespace command arguments', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'target-argv-'));
  try {
    const args = [' tool ', '', ' \t ', 'last', 'first'];
    const settings = {
      ...targetConfig,
      setup: [args],
      check: args,
      capture: { command: args, destination: 'media', required: false },
    };
    await initializeTarget(cwd, settings);
    const target = await readTarget(
      cwd,
      async (argv) => githubTarget(argv) ?? git(cwd, ...argv.slice(1)),
    );
    expect(target.config.setup).toEqual(settings.setup);
    expect(target.config.check).toEqual(settings.check);
    expect(target.config.capture).toEqual(settings.capture);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('target shell checks preserve quoting, checkout, source text and exit status', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'target-shell-')));
  try {
    await initializeTarget(cwd);
    for (const code of [0, 7]) {
      const check = `  printf '%s\\n' "quoted value" '' "$PWD"; cat 'result.txt'; exit ${code}  `;
      const text = JSON.stringify({ ...targetConfig, check });
      await writeFile(join(cwd, '.dotagents.json'), text);
      const target = await readTarget(
        cwd,
        async (argv) => githubTarget(argv) ?? git(cwd, ...argv.slice(1)),
      );
      expect(target.text).toBe(text);
      expect(target.config.check).toEqual(['/bin/sh', '-c', check]);
      const result = await command(target.config.check, target.cwd, '', 10000);
      expect(result).toMatchObject({
        code,
        stdout: `quoted value\n\n${cwd}\nold`,
        stderr: '',
        timedOut: false,
      });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('target shell setup runs in the checkout and preserves its exit status', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'target-shell-setup-')));
  try {
    await initializeTarget(cwd);
    for (const code of [0, 7]) {
      const setup = `printf '%s\\n' "quoted value" "$PWD" > 'setup result.txt'; exit ${code}`;
      const text = JSON.stringify({ ...targetConfig, setup });
      await writeFile(join(cwd, '.dotagents.json'), text);
      const target = await readTarget(
        cwd,
        async (argv) => githubTarget(argv) ?? git(cwd, ...argv.slice(1)),
      );
      expect(target.text).toBe(text);
      expect(target.config.setup).toEqual([['/bin/sh', '-c', setup]]);
      const setupArgv = target.config.setup[0];
      assert(setupArgv);
      const result = await command(setupArgv, target.cwd, '', 10000);
      expect(result).toMatchObject({ code, stderr: '', timedOut: false });
      expect(await Bun.file(join(cwd, 'setup result.txt')).text()).toBe(`quoted value\n${cwd}\n`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('target rejects invalid commands before further target access', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'target-invalid-argv-')));
  const read = async (argv: string[]) => {
    expect(argv).toEqual(['git', 'rev-parse', '--show-toplevel']);
    return cwd;
  };
  try {
    for (const [change, reason] of [
      [{ setup: undefined }, /Explicit setup commands required/],
      [{ setup: [['']] }, /Explicit setup commands required/],
      [{ setup: [['tool', 1]] }, /Explicit setup commands required/],
      [{ check: undefined }, /Verification command is required/],
      [{ check: ' \t\n' }, /Verification command is required/],
      [{ check: [] }, /Verification command is required/],
      [{ check: false }, /Verification command is required/],
      [{ capture: undefined }, /Explicit capture configuration or null required/],
      [
        { capture: { command: false, destination: 'media', required: false } },
        /Explicit capture configuration or null required/,
      ],
      [
        { capture: { command: ['tool'], destination: 'media' } },
        /Explicit capture configuration or null required/,
      ],
      [
        { capture: { command: [''], destination: 'media', required: false } },
        /Explicit capture configuration or null required/,
      ],
    ] as const) {
      await writeFile(join(cwd, '.dotagents.json'), JSON.stringify({ ...targetConfig, ...change }));
      await assert.rejects(() => readTarget(cwd, read), reason);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('target rejects invalid top-level setup values', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'target-invalid-setup-')));
  try {
    await initializeTarget(cwd);
    for (const setup of ['', ' \t\n', ['tool'], ['tool', 'other']]) {
      await writeFile(join(cwd, '.dotagents.json'), JSON.stringify({ ...targetConfig, setup }));
      await assert.rejects(
        () => readTarget(cwd, async (argv) => git(cwd, ...argv.slice(1))),
        /Explicit setup commands required/,
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Issue identifiers accept exact supported forms, never embedded URLs', () => {
  for (const input of ['12', '#12', 'https://github.com/team/component/issues/12']) {
    expect(issueNumber(input, 'team/component')).toBe('12');
  }
  for (const input of [
    '1https://github.com/team/component/issues/2',
    'https://github.com/other/component/issues/12',
    'https://github.com/team/component/issues/#12',
  ]) {
    expect(() => issueNumber(input, 'team/component')).toThrow(
      'Issue does not match target repository',
    );
  }
});

test('branch publication does not publish reachable annotated tags from user push settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'push-refs-'));
  const cwd = join(root, 'checkout'),
    remote = join(root, 'remote.git');
  try {
    await mkdir(cwd);
    await mkdir(remote);
    await initializeTarget(cwd);
    git(remote, 'init', '--bare');
    git(cwd, 'switch', '-c', 'codex/test');
    git(cwd, 'tag', '-a', 'unpublished-release', '-m', 'Keep this tag local');
    git(cwd, 'config', 'push.followTags', 'true');
    const args = await pushArguments('team/component', 'codex/test', cwd, async (argv) =>
      git(cwd, ...argv.slice(1)),
    );
    // Substitute only the transport destination so real ref publication stays local.
    const local = args
      .slice(1)
      .map((arg) => arg.replace('https://github.com/team/component.git', remote));
    local.splice(local.indexOf('push'), 0, '-c', 'protocol.file.allow=always');
    git(cwd, ...local);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/codex/test');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CI check policy must be explicit with unique nonempty names', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ci-policy-'));
  try {
    await initializeTarget(cwd);
    const read = async (argv: string[]) => githubTarget(argv) ?? git(cwd, ...argv.slice(1));
    for (const ciChecks of [undefined, [''], ['checks', 'checks']]) {
      await writeFile(join(cwd, '.dotagents.json'), JSON.stringify({ ...targetConfig, ciChecks }));
      await assert.rejects(() => readTarget(cwd, read), /Explicit unique CI check names/);
    }
    await writeFile(
      join(cwd, '.dotagents.json'),
      JSON.stringify({ ...targetConfig, ciChecks: [] }),
    );
    expect((await readTarget(cwd, read)).config.ciChecks).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('target rejects unknown settings before GitHub access', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'unknown-setting-'));
  try {
    await initializeTarget(cwd);
    let githubReads = 0;
    const read = async (argv: string[]) => {
      if (argv[0] === 'gh') {
        githubReads++;
        return githubTarget(argv) ?? '';
      }
      return git(cwd, ...argv.slice(1));
    };
    const text = JSON.stringify({ ...targetConfig, unexpected: true });
    await writeFile(join(cwd, '.dotagents.json'), text);
    await assert.rejects(() => readTarget(cwd, read), /Unknown target configuration field/);
    expect(await Bun.file(join(cwd, '.dotagents.json')).text()).toBe(text);
    expect(githubReads).toBe(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
