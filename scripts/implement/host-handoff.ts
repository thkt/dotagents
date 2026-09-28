import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { assertConfig, assertState } from './input.ts';
import type { Config } from './input.ts';
import { recordArtifacts, snapshot } from './correction.ts';
import { hash, hostReturnShape, hostEvidenceShape, readReference } from './host-records.ts';
import { reconcileExecutions } from './revision.ts';
import { outside, isRecord } from '../shared/values.ts';
import type { readTarget } from '../shared/target.ts';

const stopShape = z.object({
  head: z.string(),
  baseCommit: z.string(),
  branch: z.string(),
  source: z.string(),
  localOnly: z.boolean(),
  findings: z.string().trim().min(1),
  records: hostReturnShape.shape.records,
});
async function reference(path: string) {
  return { path, sha256: hash(await readFile(path)) };
}
async function recordFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile()) {
      files.push(path);
    } else if (entry.isDirectory() && entry.name !== 'lock') {
      files.push(...(await recordFiles(path)));
    }
  }
  return files;
}

export async function saveHostStop(input: {
  dir: string;
  config: Config;
  head: string;
  branch: string;
  localOnly: boolean;
  findings: string;
}) {
  const { dir, config } = input;
  assert(config.baseCommit);
  const artifacts = await recordArtifacts(config.cwd, config.baseCommit);
  await writeFile(join(dir, 'host-artifacts.json'), JSON.stringify(artifacts, null, 2), {
    flag: 'wx',
  });
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() && !['result.json', 'result.json.tmp', 'report.html'].includes(entry.name),
    )
    .map((entry) => join(dir, entry.name));
  // Initial implementation stops before a verification directory exists.
  if (entries.some((entry) => entry.name === 'verification')) {
    files.push(...(await recordFiles(join(dir, 'verification'))));
  }
  const records = await Promise.all(files.map(reference));
  await writeFile(
    join(dir, 'host-stop.json'),
    JSON.stringify(
      {
        head: input.head,
        baseCommit: config.baseCommit,
        branch: input.branch,
        source: artifacts.source,
        localOnly: input.localOnly,
        findings: input.findings,
        records,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
}

export async function previousHostRun(input: {
  directory?: string;
  evidenceFile?: string;
  runDirectory?: string;
  cwd: string;
  issue: string;
  original: string;
  head: string;
  target: Awaited<ReturnType<typeof readTarget>>;
  localOnly: boolean;
}) {
  if (!input.directory) {
    return undefined;
  }
  assert(
    input.evidenceFile && input.runDirectory,
    'Host return requires evidence and a new run directory',
  );
  const dir = await realpath(input.directory);
  const resultFile = join(dir, 'result.json');
  const resultContent = await readFile(resultFile);
  const result: unknown = JSON.parse(resultContent.toString('utf8'));
  const stopFile = join(dir, 'host-stop.json');
  const stopContent = await readFile(stopFile);
  const stop = stopShape.parse(JSON.parse(stopContent.toString('utf8')));
  assert(
    isRecord(result) &&
      result.terminal === true &&
      result.status === 'stopped' &&
      result.reasonCode === 'host_verification_required' &&
      result.publication === 'not_attempted',
    'Previous run is not a completed host verification handoff',
  );
  assert(
    result.checkout === input.cwd &&
      result.startCommit === stop.head &&
      result.branch === stop.branch &&
      result.repository === input.target.config.repository &&
      result.issue === `https://github.com/${input.target.config.repository}/issues/${input.issue}`,
    'Host handoff target differs',
  );
  assert(stop.head === input.head, 'Host handoff HEAD changed; preserve original diff base');
  assert(!stop.localOnly || input.localOnly, 'Host return cannot expand publication authority');
  await reconcileExecutions(
    { previousRun: dir, runDirectory: resolve(input.runDirectory) },
    input.cwd,
  );
  const requiredPaths = new Set(
    ['verification-config.json', 'target.json', 'issue.json', 'verification/state.json']
      .filter((name) => result.phase === 'verification' || name !== 'verification/state.json')
      .map((name) => join(dir, name)),
  );
  const records = new Map<string, string>();
  for (const ref of stop.records) {
    const content = await readReference(ref);
    if (requiredPaths.has(ref.path)) {
      records.set(ref.path, content);
    }
  }
  const saved = (name: string) => {
    const content = records.get(join(dir, name));
    assert(content !== undefined, `Missing host handoff record: ${name}`);
    return content;
  };
  const config: unknown = JSON.parse(saved('verification-config.json'));
  assertConfig(config);
  assert(
    config.baseCommit === stop.baseCommit &&
      config.cwd === input.cwd &&
      config.runDir === join(dir, 'verification'),
    'Host handoff configuration differs',
  );
  const savedTarget: unknown = JSON.parse(saved('target.json'));
  assert(
    isRecord(savedTarget) &&
      savedTarget.text === input.target.text &&
      savedTarget.actor === input.target.actor &&
      savedTarget.repositoryId === input.target.repositoryId,
    'Host handoff target or actor changed',
  );
  assert(saved('issue.json') === input.original, 'Agreed Issue changed since host handoff');
  if (result.phase === 'verification') {
    const state: unknown = JSON.parse(saved('verification/state.json'));
    assertState(state);
    assert(
      state.result === 'host_verification_required' &&
        state.active === null &&
        state.source === stop.source &&
        state.configHash === hash(JSON.stringify(config)) &&
        state.issueHash === hash(input.original),
      'Host handoff verification is inconsistent',
    );
  }
  const evidenceFile = await realpath(input.evidenceFile);
  assert(
    outside(input.cwd, evidenceFile) && outside(dir, evidenceFile),
    'New host evidence must be outside checkout and previous run',
  );
  const evidenceContent = await readFile(evidenceFile);
  const evidence = hostEvidenceShape.parse(JSON.parse(evidenceContent.toString('utf8')));
  for (const ref of evidence.logs) {
    const path = await realpath(ref.path);
    assert(
      outside(input.cwd, path) && outside(dir, path),
      'New host logs must be outside checkout and previous run',
    );
    await readReference(ref);
  }
  assert(
    evidence.source === (await snapshot(input.cwd)),
    'Host evidence does not match current deliverables',
  );
  return {
    dir,
    config,
    branch: stop.branch,
    baseCommit: stop.baseCommit,
    hostReturn: {
      previousRun: dir,
      records: [
        ...stop.records,
        { path: stopFile, sha256: hash(stopContent) },
        { path: resultFile, sha256: hash(resultContent) },
      ],
      evidence: { path: evidenceFile, sha256: hash(evidenceContent) },
    },
  };
}
