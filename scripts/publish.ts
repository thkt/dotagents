import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRecord } from './values.ts';
import { assertConfig } from './input.ts';
import { checkRevision } from './revision.ts';
import { readTarget } from './target.ts';
import { command as runCommand, assertRunning, withInterrupts } from './process.ts';

async function command(argv: string[], cwd: string) {
  const env = { ...process.env };
  delete env.GH_DEBUG;
  const result = await runCommand(argv, cwd, '', 120000, undefined, env);
  assert(result.code === 0 && !result.timedOut, `Command failed: ${argv[0]}`);
  return result.stdout.trim();
}
const runtime = { command };

async function checkPr(
  io: typeof runtime,
  repo: string,
  url: string,
  actor: string,
  cwd: string,
  body: string,
) {
  const prefix = `https://github.com/${repo}/pull/`;
  const number = url.startsWith(prefix) ? url.slice(prefix.length) : '';
  assert(/^[1-9]\d*$/.test(number), 'Unexpected PR URL');
  const prior: unknown = JSON.parse(
    await io.command(['gh', 'api', `repos/${repo}/pulls/${number}`], cwd),
  );
  assert(
    isRecord(prior) && isRecord(prior.user) && prior.user.login === actor,
    'PR author differs from authenticated user',
  );
  assert(
    prior.body === body,
    'Existing PR body differs from reviewed body; reconcile before continuing',
  );
}

export async function publish(args: string[], io = runtime) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      actor: { type: 'string' },
      head: { type: 'string' },
      title: { type: 'string' },
      'body-file': { type: 'string' },
      'revision-file': { type: 'string' },
    },
    strict: true,
  });
  const { head, title, 'body-file': bodyPath } = values;
  assert(
    values.repo && head && title && title.trim() && bodyPath,
    'Required: --repo CHECKOUT --head BRANCH --title TITLE --body-file PATH',
  );
  const bodyFile = resolve(bodyPath);
  const body = await readFile(bodyFile, 'utf8');
  assert(body.trim(), 'PR body must not be empty');
  const target = await readTarget(
    values.repo,
    async (argv, cwd) => (await io.command(argv, cwd)).trim(),
    true,
  );
  const { repository: repo, baseBranch: base } = target.config;
  assert(head !== base, 'Head must differ from base');
  assert(!values.actor || target.actor === values.actor, 'GitHub actor changed');
  assertRunning();
  if (values['revision-file']) {
    const config: unknown = JSON.parse(await readFile(values['revision-file'], 'utf8'));
    assertConfig(config);
    const revision = config.revision;
    assert(
      revision && config.cwd === target.cwd && revision.branch === head,
      'Revision publication target differs',
    );
    const commit = await io.command(['git', 'rev-parse', 'HEAD'], target.cwd);
    await checkRevision(revision, target.cwd, io.command, { head: commit.trim(), target });
    assertRunning();
    await io.command(
      ['gh', 'pr', 'edit', revision.url, '--repo', repo, '--body-file', bodyFile],
      target.cwd,
    );
    assertRunning();
    await checkRevision(revision, target.cwd, io.command, { head: commit.trim(), body });
    return revision.url;
  }
  const existing = (
    await io.command(
      [
        'gh',
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--head',
        head,
        '--base',
        base,
        '--limit',
        '1',
        '--json',
        'url',
        '--jq',
        '.[0].url // empty',
      ],
      target.cwd,
    )
  ).trim();
  assertRunning();
  const actor: unknown = JSON.parse(await io.command(['gh', 'api', 'user'], target.cwd));
  assert(isRecord(actor) && actor.login === target.actor, 'GitHub actor changed');
  assertRunning();
  if (existing) {
    await checkPr(io, repo, existing, target.actor, target.cwd, body);
    return existing;
  }
  const url = (
    await io.command(
      [
        'gh',
        'pr',
        'create',
        '--repo',
        repo,
        '--base',
        base,
        '--head',
        head,
        '--title',
        title,
        '--body-file',
        bodyFile,
      ],
      target.cwd,
    )
  ).trim();
  await checkPr(io, repo, url, target.actor, target.cwd, body);
  return url;
}

if (import.meta.main) {
  try {
    console.log(await withInterrupts(() => publish(process.argv.slice(2))));
  } catch (error) {
    console.error(
      `Publish failed: ${error instanceof Error ? error.message : String(error)}. Check arguments, gh authentication and the PR state before retrying.`,
    );
    process.exitCode = 1;
  }
}
