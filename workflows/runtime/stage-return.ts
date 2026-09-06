/** @file Outcome: Verified handoffs own at most two durable read-only children across a root invocation. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, workflowRunDirectory, workflowInputPath } from './storage.ts';
import { FlowError } from '../shared/errors.ts';
import { thinkDigest, loadThinkState, thinkSnapshotPath } from '../think/state.ts';
import { sealRepository } from '../execution/source-seal.ts';
import type { ResearchAgent } from '../research/agent.ts';
import type { ThinkAgent } from '../think/agent.ts';

export interface StageAgents {
  research?: ResearchAgent;
  think?: ThinkAgent;
}
export interface StageAccess {
  root: string;
  file: string;
  child: string;
  snapshot: string;
}
const granted = new WeakSet<StageAccess>();
export const CHILD_PREFIX = 'stage-child:';

export function requireStageAccess(runId: string, access?: StageAccess): void {
  if (runId.startsWith(CHILD_PREFIX) && (!access || !granted.has(access) || access.child !== runId))
    throw new FlowError(
      'child execution requires its authorized parent runner',
      'authorization_error',
    );
  if (access && (!granted.has(access) || access.child !== runId))
    throw new FlowError('invalid parent execution authority', 'authorization_error');
}

interface ReturnEntry {
  key: string;
  parent: string;
  id: string;
  route: 'research' | 'think';
  input: unknown;
  snapshot: string;
  source: string;
}
interface Returns {
  protocol: 'codex-stage-returns-v2';
  root: string;
  entries: ReturnEntry[];
}
function read(file: string, root: string): Returns {
  if (!fs.existsSync(file)) return { protocol: 'codex-stage-returns-v2', root, entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      raw.digest !== thinkDigest(raw.state) ||
      raw.state?.protocol !== 'codex-stage-returns-v2' ||
      raw.state.root !== root ||
      !Array.isArray(raw.state.entries) ||
      raw.state.entries.length > 2
    )
      throw new Error('invalid record');
    const state = raw.state as Returns;
    if (
      new Set(state.entries.map((e) => e.id)).size !== state.entries.length ||
      new Set(state.entries.map((e) => e.key)).size !== state.entries.length
    )
      throw new Error('duplicate child identity');
    for (const entry of state.entries) {
      if (
        !entry ||
        typeof entry.key !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(entry.key) ||
        typeof entry.id !== 'string' ||
        !entry.id.startsWith(CHILD_PREFIX) ||
        typeof entry.parent !== 'string' ||
        !['research', 'think'].includes(entry.route) ||
        typeof entry.snapshot !== 'string' ||
        !path.isAbsolute(entry.snapshot) ||
        typeof entry.source !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(entry.source) ||
        !('input' in entry)
      )
        throw new Error('invalid child record');
    }
    return state;
  } catch (error) {
    throw new FlowError(
      `cross-stage state cannot resume: ${String(error)}; retain it and use its original runtime or a new task`,
      'state_error',
    );
  }
}
function save(file: string, state: Returns) {
  atomicWrite(file, { state, digest: thinkDigest(state) });
}

/** Derive child scope and input from the accepted parent record, never caller-supplied authority. */
export async function runStageReturn(
  parent: string,
  workflow: 'think' | 'build',
  agents: StageAgents = {},
  access?: StageAccess,
) {
  requireStageAccess(parent, access);
  const options = await parentReturn(parent, workflow);
  const root = access?.root ?? options.invocation;
  const file =
    access?.file ?? path.join(workflowRunDirectory(options.parent), `returns-${root}.json`);
  let state = read(file, root);
  const key = thinkDigest({ parent: options.parent, binding: options.binding });
  let entry = state.entries.find((item) => item.key === key);
  const source = options.source;
  if (
    entry &&
    (entry.route !== options.route ||
      thinkDigest(entry.input) !== thinkDigest(options.input) ||
      entry.source !== source)
  )
    throw new FlowError('cross-stage governing input or snapshot changed', 'state_error');
  if (!entry) {
    if (state.entries.length === 2)
      throw new FlowError(
        'cross-stage return limit of two exhausted; retain evidence and start a new authorized invocation after resolving the remaining facts',
        'stage_return_blocked',
      );
    entry = {
      key,
      parent: options.parent,
      id: `${CHILD_PREFIX}${crypto.randomUUID()}`,
      route: options.route,
      input: options.input,
      snapshot: options.snapshot,
      source,
    };
    state.entries.push(entry);
    save(file, state);
  }
  const childInput = workflowInputPath(entry.id, entry.route);
  if (fs.existsSync(childInput)) {
    if (thinkDigest(JSON.parse(fs.readFileSync(childInput, 'utf8'))) !== thinkDigest(entry.input))
      throw new FlowError('child input changed', 'state_error');
  } else atomicWrite(childInput, entry.input);
  const childAccess: StageAccess = { root, file, child: entry.id, snapshot: entry.snapshot };
  granted.add(childAccess);
  const pending = thinkDigest(entry);
  try {
    const result =
      entry.route === 'research'
        ? await (
            await import('../research/pipeline.ts')
          ).runResearch(entry.id, childInput, agents.research, childAccess)
        : await (
            await import('../think/pipeline.ts')
          ).runThink(entry.id, childInput, agents.think, childAccess, agents);
    state = read(file, root);
    const current = state.entries.find((item) => item.key === key)!;
    if (
      thinkDigest(current) !== pending ||
      sealRepository(entry.snapshot, options.logical ? { logical: options.logical } : {})
        .source_digest !== entry.source
    )
      throw new FlowError('stale child result or changed parent snapshot', 'state_error');
    return result;
  } finally {
    granted.delete(childAccess);
  }
}

async function parentReturn(parent: string, workflow: 'think' | 'build') {
  if (workflow === 'think') {
    const state = loadThinkState(parent);
    if (
      !state ||
      state.phase !== 'research' ||
      state.candidate?.status !== 'research_required' ||
      !state.review ||
      state.review.findings.some((f) => f.severity === 'blocking')
    )
      throw new FlowError('a verified parent Think handoff is required', 'authorization_error');
    const source = sealRepository(thinkSnapshotPath(parent, state)).source_digest;
    if (source !== state.source_digest)
      throw new FlowError('Think caller snapshot changed', 'state_error');
    return {
      parent,
      source,
      logical: undefined,
      invocation: state.invocation,
      binding: { candidate: state.candidate, review: state.review, research: state.research },
      route: 'research' as const,
      snapshot: thinkSnapshotPath(parent, state),
      input: {
        repo: state.input.repo,
        question: state.candidate.research_questions.join('\n'),
        scope_paths: [],
        allow_external_sources: false,
      },
    };
  }
  const { state } = (await import('../execution/controller.ts')).loadWorkflowState(parent);
  const route = state.escalation?.next_step;
  if (
    state.workflow !== 'build' ||
    state.status !== 'blocked' ||
    !state.handoff ||
    state.handoff.proposal ||
    (route !== 'research' && route !== 'think')
  )
    throw new FlowError('a verified parent Build handoff is required', 'authorization_error');
  const logical = sealRepository(state.manifest.repo);
  const source = sealRepository(state.handoff.snapshot, { logical }).source_digest;
  if (source !== state.handoff.source_digest)
    throw new FlowError('Build caller snapshot changed', 'state_error');
  const question = `${state.escalation!.question}\nConfirmed handoff: ${state.escalation!.summary}`;
  return {
    parent,
    source,
    logical,
    invocation: state.invocation_id,
    binding: state.handoff.binding,
    route,
    snapshot: state.handoff.snapshot,
    input:
      route === 'research'
        ? { repo: state.manifest.repo, question, scope_paths: [], allow_external_sources: false }
        : {
            repo: state.manifest.repo,
            request: `${question}\nPrepare a proposed decision. This captured public Plan remains the old Build authority and cannot be replaced here:\n${JSON.stringify(state.build_plan)}`,
            research_reports: [],
          },
  };
}
