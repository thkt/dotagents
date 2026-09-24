import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRecord } from './values.ts';
import { assertConfig } from './input.ts';
import { checkRevision } from './revision.ts';
import type { Revision } from './input.ts';
import { readTarget } from './target.ts';
import { restPrPublication, matchPrPublication } from './pr-identity.ts';
import { command as runCommand, assertRunning, withInterrupts } from './process.ts';

async function command(argv: string[], cwd: string) {
  const env = { ...process.env };
  delete env.GH_DEBUG;
  const result = await runCommand(argv, cwd, '', 120000, undefined, env);
  assert(result.code === 0 && !result.timedOut, `Command failed: ${argv[0]}`);
  return result.stdout.trim();
}
const runtime = { command };

export class PublicationError extends Error {
  constructor(
    public url: string,
    cause: unknown,
  ) {
    super(
      `PR ${url}: ${cause instanceof Error ? cause.message : String(cause)}; reconcile actual state before retrying`,
      { cause },
    );
  }
}

export async function checkPublishedPr(
  input: {
    cwd: string;
    repository: string;
    url: string;
    actor: string;
    body: string;
    head: string;
    base: string;
    commit: string;
  },
  read: typeof command,
) {
  const { cwd, repository: repo, url, actor, body, head, base, commit } = input;
  try {
    const prefix = `https://github.com/${repo}/pull/`;
    const number = url.startsWith(prefix) ? url.slice(prefix.length) : '';
    assert(/^[1-9]\d*$/.test(number), 'Unexpected PR URL');
    const pr: unknown = JSON.parse(await read(['gh', 'api', `repos/${repo}/pulls/${number}`], cwd));
    assert(isRecord(pr), 'PR author differs from authenticated user');
    const observation = restPrPublication(pr);
    const match = matchPrPublication(observation, {
      url,
      actor,
      branch: head,
      repository: repo,
      commit,
      base,
      body,
    });
    assert(match.author, 'PR author differs from authenticated user');
    assert(
      match.target && observation.baseRepository === repo,
      'Published PR target differs from expected repository, branch or commit',
    );
    assert(match.body, 'Existing PR body differs from generated body; reconcile before continuing');
    assert(match.draft, 'Published PR is not confirmed draft; reconcile before continuing');
  } catch (error) {
    throw new PublicationError(url, error);
  }
}

export interface PublishInput {
  cwd: string;
  actor?: string;
  head: string;
  title: string;
  bodyFile: string;
  revision?: Revision;
}

export async function publishCli(args: string[], io = runtime) {
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
  let cwd = values.repo;
  let revision: Revision | undefined;
  if (values['revision-file']) {
    const config: unknown = JSON.parse(await readFile(values['revision-file'], 'utf8'));
    assertConfig(config);
    assert(
      config.revision && config.cwd === (await realpath(cwd)),
      'Revision publication target differs',
    );
    cwd = config.cwd;
    revision = config.revision;
  }
  return publish({ cwd, actor: values.actor, head, title, bodyFile: bodyPath, revision }, io);
}

export async function publish(input: PublishInput, io = runtime) {
  const { head, title, revision } = input;
  const bodyFile = resolve(input.bodyFile);
  const body = await readFile(bodyFile, 'utf8');
  assert(body.trim(), 'PR body must not be empty');
  const target = await readTarget(
    input.cwd,
    async (argv, cwd) => (await io.command(argv, cwd)).trim(),
    true,
  );
  const { repository: repo, baseBranch: base } = target.config;
  assert(head !== base, 'Head must differ from base');
  assert(!input.actor || target.actor === input.actor, 'GitHub actor changed');
  const commit = (await io.command(['git', 'rev-parse', 'HEAD'], target.cwd)).trim();
  assertRunning();
  if (revision) {
    assert(revision.branch === head, 'Revision publication target differs');
    await checkRevision(revision, target.cwd, io.command, {
      head: commit,
      target,
      draft: 'require',
    });
    assertRunning();
    await io.command(
      ['gh', 'pr', 'edit', revision.url, '--repo', repo, '--body-file', bodyFile],
      target.cwd,
    );
    assertRunning();
    await checkRevision(revision, target.cwd, io.command, { head: commit, body, draft: 'require' });
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
  const url =
    existing ||
    (
      await io.command(
        [
          'gh',
          'pr',
          'create',
          '--draft',
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
  await checkPublishedPr(
    { cwd: target.cwd, repository: repo, url, actor: target.actor, body, head, base, commit },
    io.command,
  );
  return url;
}

if (import.meta.main) {
  try {
    console.log(await withInterrupts(() => publishCli(process.argv.slice(2))));
  } catch (error) {
    console.error(
      `Publish failed: ${error instanceof Error ? error.message : String(error)}. Check arguments, gh authentication and the PR state before retrying.`,
    );
    process.exitCode = 1;
  }
}
