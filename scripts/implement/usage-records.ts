import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertState } from './input.ts';
import type { State } from './input.ts';
import { parseRunResult } from './run-result.ts';
import type { SelectedRun, Selection } from './usage-input.ts';
import { hash, readUsageEvents, sumUsage } from './usage-events.ts';
import { isRecord } from '../shared/values.ts';

const nonnegative = z.number().nonnegative();
const commandResult = z.object({
  code: z.number().int().nonnegative().nullable(),
  timedOut: z.boolean(),
  ms: nonnegative,
});
const metadataShape = z.strictObject({
  recordFormat: z.literal(1),
  invocationId: z.uuid(),
  role: z.enum(['repair', 'review']),
  hostPrefix: z.string().min(1).nullable(),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  sandbox: z.enum(['workspace-write', 'read-only']),
  ignoreUserConfig: z.literal(true),
});
interface Reference {
  path: string;
  sha256: string;
}
interface HostStep {
  phase: string;
  prefix: string;
  code: number | null;
  timedOut: boolean;
  ms: number | null;
  recorded: boolean;
}

function inside(path: string) {
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

class Records {
  readonly references: Reference[] = [];
  constructor(readonly root: string) {}
  async read(path: string): Promise<string | undefined> {
    assert(inside(path), 'Record path outside selected run');
    try {
      let current = this.root;
      let info;
      for (const part of path.split(sep)) {
        current = join(current, part);
        info = await lstat(current);
        assert(!info.isSymbolicLink(), `Symlink record rejected: ${path}`);
      }
      assert(info?.isFile(), `Non-file record: ${path}`);
      const raw = await readFile(current, 'utf8');
      this.references.push({ path, sha256: hash(raw) });
      return raw;
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return undefined;
      }
      throw Error(`Cannot read regular record: ${path}`);
    }
  }
  async json(path: string) {
    const raw = await this.read(path);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw Error(`Invalid JSON: ${path}`);
    }
  }
  async unchanged() {
    for (const ref of this.references) {
      assert(
        hash(await readFile(join(this.root, ref.path), 'utf8')) === ref.sha256,
        `Record changed during aggregation: ${ref.path}`,
      );
    }
  }
}

async function verificationExpected(records: Records, phase: string) {
  return (
    (await records.read('verification-config.json')) !== undefined ||
    ['verification', 'publication', 'ci'].includes(phase)
  );
}

async function hostSteps(
  records: Records,
  originalRoot: string,
  phase: string,
  problems: string[],
) {
  const steps: HostStep[] = [];
  const initial = await records.json('implementation.json');
  if (initial !== undefined) {
    const parsed = commandResult.safeParse(initial);
    assert(parsed.success, 'Invalid implementation command result');
    steps.push({
      phase: 'implementation',
      prefix: 'implementation',
      recorded: true,
      ...parsed.data,
    });
  } else if ((await records.read('implementation.prompt')) !== undefined) {
    steps.push({
      phase: 'implementation',
      prefix: 'implementation',
      code: null,
      timedOut: false,
      ms: null,
      recorded: false,
    });
    problems.push('implementation: command result missing');
  }
  const raw = await records.json('verification/state.json');
  let state: State | undefined;
  let verificationMissing = false;
  if (raw !== undefined) {
    assertState(raw);
    state = raw;
    for (const event of raw.events) {
      const prefix = relative(originalRoot, resolve(event.prefix));
      assert(inside(prefix), 'Host prefix outside recorded run');
      steps.push({
        phase: event.role,
        prefix,
        code: event.code,
        timedOut: event.timedOut,
        ms: event.ms ?? null,
        recorded: true,
      });
    }
    if (raw.active) {
      const prefix = relative(originalRoot, resolve(raw.active.prefix));
      assert(inside(prefix), 'Active prefix outside recorded run');
      if (!steps.some((step) => step.prefix === prefix)) {
        steps.push({
          phase: raw.active.role,
          prefix,
          code: null,
          timedOut: false,
          ms: null,
          recorded: false,
        });
      }
      problems.push('verification: active reservation remains');
    }
  } else if (await verificationExpected(records, phase)) {
    verificationMissing = true;
    problems.push('verification/state.json missing');
  }
  const prefixes = new Set<string>();
  for (const step of steps) {
    assert(!prefixes.has(step.prefix), 'Duplicate host command prefix');
    prefixes.add(step.prefix);
    if (step.ms === null) {
      problems.push(`${step.prefix}: duration missing`);
    }
  }
  return { steps, state, verificationMissing };
}

async function evidenceEntries(path: string) {
  const info = await lstat(path).catch(() => undefined);
  if (!info) {
    return [];
  }
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Invalid evidence directory');
  return (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

async function actorDirectories(records: Records) {
  const directories: string[] = [];
  const rootEntries = await evidenceEntries(records.root);
  const verificationEntries = await evidenceEntries(join(records.root, 'verification'));
  const parents = [
    { parent: '', entries: rootEntries },
    { parent: 'verification', entries: verificationEntries },
  ];
  for (const { parent, entries } of parents) {
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const directory = join(parent, entry.name);
      // Inspect records, not a role inferred from the directory name.
      const path = join(records.root, directory);
      const files =
        directory === 'verification'
          ? verificationEntries
          : await readdir(path, { withFileTypes: true }).catch(() => []);
      if (files.some((file) => ['events.jsonl', 'actor.json'].includes(file.name))) {
        directories.push(directory);
      }
    }
  }
  return directories;
}

async function readActor(records: Records, directory: string) {
  const path = join(directory, 'events.jsonl');
  const raw = await records.read(path);
  const events = readUsageEvents(raw ?? '');
  const value = await records.json(join(directory, 'actor.json'));
  const parsed = metadataShape.safeParse(value);
  const metadata = parsed.success ? parsed.data : null;
  if (!metadata) {
    events.problems.push('actor.json: missing or invalid host association/model settings');
  }
  return { path, ...events, metadata, phase: 'unassigned', hostPrefix: null as string | null };
}

function requireAssociations(
  actors: Awaited<ReturnType<typeof readActor>>[],
  steps: HostStep[],
  problems: string[],
) {
  for (const step of steps.filter((step) =>
    ['implementation', 'repair', 'review'].includes(step.phase),
  )) {
    if (actors.filter((actor) => actor.hostPrefix === step.prefix).length !== 1) {
      problems.push(`${step.prefix}: expected exactly one actor execution`);
    }
  }
}

function associate(
  actors: Awaited<ReturnType<typeof readActor>>[],
  steps: HostStep[],
  conditions: Selection['conditions'],
  problems: string[],
) {
  for (const actor of actors) {
    const metadata = actor.metadata;
    const step = steps.find((step) => step.prefix === metadata?.hostPrefix);
    if (!step || !metadata || !['implementation', 'repair', 'review'].includes(step.phase)) {
      actor.problems.push('No unique recorded host model command association');
      continue;
    }
    const role = step.phase === 'implementation' ? 'repair' : step.phase;
    if (
      role !== metadata.role ||
      metadata.sandbox !== (role === 'repair' ? 'workspace-write' : 'read-only')
    ) {
      actor.problems.push('Actor role/settings disagree with host phase');
      continue;
    }
    actor.phase = step.phase;
    actor.hostPrefix = step.prefix;
    if (
      metadata.model !== conditions.model ||
      metadata.reasoningEffort !== conditions.reasoningEffort
    ) {
      actor.problems.push('Recorded model/settings differ from comparison conditions');
    }
  }
  requireAssociations(actors, steps, problems);
}

function recordIdentities(
  actors: Awaited<ReturnType<typeof readActor>>[],
  identities: Set<string>,
  problems: string[],
) {
  for (const actor of actors) {
    for (const identity of [
      actor.threadId && `thread:${actor.threadId}`,
      actor.metadata && `actor:${actor.metadata.invocationId}`,
    ]) {
      if (!identity) {
        continue;
      }
      assert(!identities.has(identity), 'Duplicate actor execution/thread across selected logs');
      identities.add(identity);
    }
    problems.push(...actor.problems.map((problem) => `${actor.path}: ${problem}`));
  }
}

export async function readRun(
  selected: SelectedRun,
  base: string,
  conditions: Selection['conditions'],
  identities: Set<string>,
) {
  const root = await realpath(resolve(base, selected.directory));
  assert(!identities.has(root), 'Duplicate selected run directory');
  identities.add(root);
  const records = new Records(root);
  const rawResult = await records.json('result.json');
  const result = parseRunResult(rawResult);
  assert(
    isRecord(rawResult) && typeof rawResult.evidence === 'string',
    'Missing recorded run root',
  );
  assert(
    result.startCommit === selected.targetCommit,
    'Selected target commit differs from run startCommit',
  );
  const problems: string[] = [];
  const { steps, state, verificationMissing } = await hostSteps(
    records,
    rawResult.evidence,
    result.phase,
    problems,
  );
  const actors: Awaited<ReturnType<typeof readActor>>[] = [];
  for (const directory of await actorDirectories(records)) {
    actors.push(await readActor(records, directory));
  }
  associate(actors, steps, conditions, problems);
  recordIdentities(actors, identities, problems);
  if (!actors.length) {
    problems.push('No actor usage records');
  }
  // exec JSON documents parent turn usage, but does not establish child billing inclusion.
  problems.push(
    'Child-model usage inclusion is unverified; whole-run totals and token ratios withheld',
  );
  const observed = sumUsage(actors.flatMap((actor) => (actor.observed ? [actor.observed] : [])));
  const stages = [
    ...new Set([...steps.map((step) => step.phase), ...actors.map((actor) => actor.phase)]),
  ]
    .sort()
    .map((phase) => {
      const commands = steps.filter((step) => step.phase === phase);
      const modelActors = actors.filter((actor) => actor.phase === phase);
      return {
        phase,
        commands,
        observed: sumUsage(
          modelActors.flatMap((actor) => (actor.observed ? [actor.observed] : [])),
        ),
        commandMs:
          commands.length && commands.every((step) => step.ms !== null)
            ? commands.reduce((sum, step) => sum + (step.ms ?? 0), 0)
            : null,
      };
    });
  const run = {
    id: selected.id,
    task: selected.task,
    targetCommit: selected.targetCommit,
    retryOf: selected.retryOf,
    evaluation: selected.evaluation,
    recorded: {
      repository: result.repository,
      issue: result.issue,
      status: result.status,
      reason: result.reason,
      phase: result.phase,
      ci: result.ci ?? null,
      commit: result.commit ?? null,
      review: state?.reviewHistory.at(-1)?.status ?? null,
    },
    elapsedMs: Date.parse(result.finishedAt) - Date.parse(result.startedAt),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    executionFailed:
      steps.some((step) => step.recorded && (step.timedOut || step.code !== 0)) ||
      result.ci === 'failed',
    executionUnknown:
      verificationMissing ||
      steps.some((step) => !step.recorded) ||
      steps.length === 0 ||
      (result.ci === undefined ? result.phase === 'ci' : !['passed', 'failed'].includes(result.ci)),
    actors,
    stages,
    observed,
    total: null,
    problems,
    references: records.references,
  };
  return { run, unchanged: () => records.unchanged() };
}
