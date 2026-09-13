import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRecord } from './input.ts';
import { readTarget } from './target.ts';
import { command as runCommand, assertRunning, withInterrupts } from './correction.ts';

async function command(argv: string[], cwd: string) {
  const env = { ...process.env };
  delete env.GH_DEBUG;
  const result = await runCommand(argv, cwd, '', 120000, undefined, env);
  assert(result.code === 0 && !result.timedOut, `Command failed: ${argv[0]}`);
  return result.stdout.trim();
}
const runtime = { command };

async function checkAuthor(
  io: typeof runtime,
  repo: string,
  url: string,
  actor: string,
  cwd: string,
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
}

export async function publish(args: string[], io = runtime) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      actor: { type: 'string' },
      preflight: { type: 'boolean' },
      head: { type: 'string' },
      title: { type: 'string' },
      'body-file': { type: 'string' },
    },
    strict: true,
  });
  const { head, title, 'body-file': bodyPath } = values;
  assert(
    values.repo && (values.preflight || (head && title?.trim() && bodyPath)),
    'Required: --repo CHECKOUT and --preflight or --head BRANCH --title TITLE --body-file PATH',
  );
  const bodyFile = bodyPath ? resolve(bodyPath) : '';
  if (!values.preflight) {
    assert((await readFile(bodyFile, 'utf8')).trim(), 'PR body must not be empty');
  }
  const target = await readTarget(
    values.repo,
    async (argv, cwd) => (await io.command(argv, cwd)).trim(),
    true,
  );
  const { repository: repo, baseBranch: base } = target.config;
  assert(values.preflight || head !== base, 'Head must differ from base');
  assert(!values.actor || target.actor === values.actor, 'GitHub actor changed');
  assertRunning();
  if (values.preflight) {
    return JSON.stringify({ repository: repo, base, actor: target.actor });
  }
  assert(head && title);
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
  if (existing) {
    await checkAuthor(io, repo, existing, target.actor, target.cwd);
    return existing;
  }
  const actor: unknown = JSON.parse(await io.command(['gh', 'api', 'user'], target.cwd));
  assert(isRecord(actor) && actor.login === target.actor, 'GitHub actor changed');
  assertRunning();
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
  await checkAuthor(io, repo, url, target.actor, target.cwd);
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
