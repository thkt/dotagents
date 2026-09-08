/** @file Outcome: Verified handoffs own at most two durable read-only children across a root invocation. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, workflowRunDirectory, workflowInputPath } from './storage.ts';
import {
  inputAnswerDelta,
  sameValue,
  parseClarificationAnswer,
  type WaitingResult,
  type ClarificationAnswer,
} from './clarification.ts';
import { saveThinkState, thinkWaitingOwner, thinkContractDigest } from '../think/state.ts';
import {
  loadResearchState,
  reportForCandidate,
  researchDigest,
  researchWaitingOwner,
  researchSnapshotPath,
} from '../research/state.ts';
import { FlowError } from '../shared/errors.ts';
import { thinkDigest, loadThinkState, thinkSnapshotPath } from '../think/state.ts';
import { sealRepository } from '../execution/source-seal.ts';
import { loadWorkflowState } from '../execution/controller.ts';
import type { ResearchAgent } from '../research/agent.ts';
import type { ThinkAgent } from '../think/agent.ts';

export interface StageAgents {
  research?: ResearchAgent;
  think?: ThinkAgent;
}
export interface StageAccess {
  root: string;
  task: string;
  binding: string;
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
  answers: ClarificationAnswer[];
  inherited: ClarificationAnswer[];
  snapshot: string;
  source: string;
}
interface Returns {
  protocol: 'codex-stage-returns-v7';
  root: string;
  entries: ReturnEntry[];
  started: string[];
  task: string;
  workflow: 'think' | 'build';
  input: unknown;
  waiting: WaitingResult | null;
  adoption: {
    answer: ClarificationAnswer;
    phase: 'adopting' | 'routed';
    root_after: string;
  } | null;
  parents: Record<string, string>;
  parent_transition: { parent: string; before: string; after: string } | null;
}
function read(file: string, root: string): Returns {
  if (!fs.existsSync(file))
    throw new FlowError(
      'missing cross-stage ownership record; retain this run and restore its original journal or start a new explicitly authorized task',
      'state_error',
    );
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      raw.digest !== thinkDigest(raw.state) ||
      raw.state?.protocol !== 'codex-stage-returns-v7' ||
      raw.state.root !== root ||
      !Array.isArray(raw.state.entries) ||
      !Array.isArray(raw.state.started) ||
      !raw.state.task ||
      !raw.state.parents ||
      !('waiting' in raw.state) ||
      !('adoption' in raw.state) ||
      !('parent_transition' in raw.state) ||
      raw.state.entries.length > 2
    )
      throw new Error('invalid record');
    const state = raw.state as Returns;
    if (state.parent_transition !== null) {
      const transition = state.parent_transition;
      if (
        !transition ||
        state.adoption?.phase !== 'routed' ||
        !Object.hasOwn(state.parents, transition.parent) ||
        state.parents[transition.parent] !== transition.before ||
        !/^[a-f0-9]{64}$/u.test(transition.before) ||
        !/^[a-f0-9]{64}$/u.test(transition.after)
      )
        throw new Error('invalid parent transition');
    }
    if (
      new Set(state.entries.map((e) => e.id)).size !== state.entries.length ||
      new Set(state.entries.map((e) => e.key)).size !== state.entries.length ||
      new Set(state.started).size !== state.started.length ||
      state.started.some((id) => !state.entries.some((entry) => entry.id === id))
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
        !('input' in entry) ||
        !Array.isArray(entry.answers) ||
        !Array.isArray(entry.inherited)
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

/** Initialize ownership before publishing a new root state, never while resuming one.
 * An interruption can leave an unused empty journal; a persisted root requires its original journal.
 * Child reservations and accounting remain exclusively in this record.
 */
export function initializeStageReturns(
  task: string,
  workflow: 'think' | 'build',
  root: string,
  input: unknown,
): void {
  const file = path.join(workflowRunDirectory(task), `returns-${root}.json`);
  if (fs.existsSync(file))
    throw new FlowError('cross-stage ownership already exists for this invocation', 'state_error');
  save(file, {
    protocol: 'codex-stage-returns-v7',
    root,
    task,
    workflow,
    input,
    waiting: null,
    adoption: null,
    parents: {},
    parent_transition: null,
    entries: [],
    started: [],
  });
}

/** Validate every captured parent, allowing only the exact write-ahead transition, if any. */
function validateParents(state: Returns): Record<string, string> {
  const current = parentDigests(state);
  const expected = { ...state.parents };
  const transition = state.parent_transition;
  if (transition && current[transition.parent] === transition.after)
    expected[transition.parent] = transition.after;
  if (!sameValue(current, expected))
    throw new FlowError(
      'routed parent authority changed outside a journaled transition',
      'state_error',
    );
  return current;
}

/** A crash or thrown write may leave either side of this exact runtime-authored transition. */
function settleParentTransition(file: string, state: Returns): void {
  const current = validateParents(state);
  if (!state.parent_transition) return;
  state.parents = current;
  state.parent_transition = null;
  save(file, state);
}

/** Journal each suspended parent's state write before it can affect resumed child reasoning. */
export function saveStageReturnTransition<T>(
  parent: string,
  workflow: 'think' | 'build',
  before: string,
  after: string,
  persist: () => T,
  access?: StageAccess,
): T {
  requireStageAccess(parent, access);
  const current = workflow === 'think' ? loadThinkState(parent)! : loadWorkflowState(parent).state;
  if (thinkDigest(current) !== before)
    throw new FlowError('stale parent before stage-return persistence', 'state_error');
  const root =
    access?.root ?? ('invocation' in current ? current.invocation : current.invocation_id);
  const file = access?.file ?? path.join(workflowRunDirectory(parent), `returns-${root}.json`);
  const state = read(file, root);
  if (state.adoption?.phase !== 'routed') return persist();
  settleParentTransition(file, state);
  if (state.parents[parent] !== before)
    throw new FlowError('routed parent authority changed before persistence', 'state_error');
  state.parent_transition = { parent, before, after };
  save(file, state);
  const result = persist();
  settleParentTransition(file, state);
  return result;
}

/** Journal initialization after the first child state write, before any model dispatch. */
export function markStageStarted(access?: StageAccess): void {
  if (!access) return;
  requireStageAccess(access.child, access);
  const state = read(access.file, access.root);
  const entry = state.entries.find((item) => item.id === access.child);
  if (!entry || entryBinding(state, entry) !== access.binding)
    throw new FlowError('cross-stage dispatch entry changed', 'state_error');
  if (!state.started.includes(entry.id)) {
    state.started.push(entry.id);
    save(access.file, state);
  }
}

/** Inheritance comes only from adopted leaf deltas or the root Think's accepted history. */
function rootHistory(state: Returns, submitted: unknown): ClarificationAnswer[] {
  const original =
    (state.input as { clarification_answers?: unknown[] }).clarification_answers ?? [];
  const history = (
    (submitted as { clarification_answers?: unknown[] }).clarification_answers ?? []
  ).map(parseClarificationAnswer);
  inputAnswerDelta(state.input, { ...(submitted as object), clarification_answers: original });
  const accepted = [
    ...state.entries.flatMap((entry) => entry.answers),
    ...(state.workflow === 'think' ? loadThinkState(state.task)!.clarification_history : []),
  ];
  if (
    !sameValue(original, history.slice(0, original.length)) ||
    new Set(history.map((answer) => answer.question_id)).size !== history.length ||
    history.some((answer) => !accepted.some((stored) => sameValue(stored, answer)))
  )
    throw new FlowError(
      'root answer history requires journaled waiting-owner adoption',
      'state_error',
    );
  return history;
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
  if (state.adoption?.phase === 'routed') settleParentTransition(file, state);
  const rootInput = JSON.parse(
    fs.readFileSync(workflowInputPath(state.task, state.workflow), 'utf8'),
  );
  const inherited = rootHistory(state, rootInput);
  if (!access && !state.waiting) state.input = rootInput;
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
      answers: [],
      inherited,
      snapshot: options.snapshot,
      source,
    };
    state.entries.push(entry);
    save(file, state);
  }
  const childState =
    entry.route === 'research' ? loadResearchState(entry.id) : loadThinkState(entry.id);
  if (state.started.includes(entry.id) && !childState)
    throw new FlowError(
      'started cross-stage child state is missing; retain the run for recovery',
      'state_error',
    );
  const childInput = workflowInputPath(entry.id, entry.route);
  const desiredInput = entryInput(entry);
  if (fs.existsSync(childInput)) {
    if (thinkDigest(JSON.parse(fs.readFileSync(childInput, 'utf8'))) !== thinkDigest(desiredInput))
      throw new FlowError('child input changed', 'state_error');
  } else atomicWrite(childInput, desiredInput);
  const childAccess: StageAccess = {
    root,
    task: state.task,
    binding: entryBinding(state, entry),
    file,
    child: entry.id,
    snapshot: entry.snapshot,
  };
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
    if (state.adoption?.phase === 'routed') validateParents(state);
    const current = state.entries.find((item) => item.key === key)!;
    if (
      thinkDigest(current) !== pending ||
      sealRepository(entry.snapshot, options.logical ? { logical: options.logical } : {})
        .source_digest !== entry.source
    )
      throw new FlowError('stale child result or changed parent snapshot', 'state_error');
    // A waiting result must not establish a new baseline for edited parent authority.
    // Each level checks its own parent; a child Think may legitimately advance itself.
    const parents = parentDigests(state);
    if (parents[options.parent] !== options.authority)
      throw new FlowError(
        `stale ${workflow === 'build' ? 'Build' : 'Think'} parent authority after child execution`,
        'state_error',
      );
    if (!access) {
      inputAnswerDelta(
        state.input,
        JSON.parse(fs.readFileSync(workflowInputPath(parent, workflow), 'utf8')),
      );
      if ('status' in result) {
        state.waiting = result;
        state.adoption = null;
        state.parents = parents;
      } else {
        state.waiting = null;
        state.adoption = null;
        state.parents = {};
      }
      save(file, state);
    }
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
      authority: thinkDigest(state),
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
  const { step_id: _step, ...escalationData } = state.escalation!;
  if (
    state.actor_binding?.attempt !== state.actor_attempt ||
    state.handoff.binding !==
      thinkDigest({
        invocation: state.invocation_id,
        actor: state.actor_binding,
        plan: state.build_plan,
        escalationData,
      })
  )
    throw new FlowError('Build handoff authority changed before child execution', 'state_error');
  const logical = sealRepository(state.manifest.repo);
  const source = sealRepository(state.handoff.snapshot, { logical }).source_digest;
  if (source !== state.handoff.source_digest)
    throw new FlowError('Build caller snapshot changed', 'state_error');
  const question = `${state.escalation!.question}\nConfirmed handoff: ${state.escalation!.summary}`;
  return {
    parent,
    authority: thinkDigest(state),
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

function entryInput(entry: ReturnEntry): unknown {
  const history = [...entry.inherited, ...entry.answers];
  return history.length
    ? { ...(entry.input as object), clarification_answers: history }
    : entry.input;
}
function parentDigests(state: Returns): Record<string, string> {
  const values: Record<string, string> = {};
  // A waiting Think leaf may become an intermediate parent after its answer.
  // Capture it before routing so reserving Research cannot establish a new baseline.
  const ids = new Set([
    ...state.entries.map((e) => e.parent),
    ...state.entries.filter((e) => e.route === 'think').map((e) => e.id),
  ]);
  for (const id of ids) {
    const value =
      id === state.task && state.workflow === 'build'
        ? loadWorkflowState(id).state
        : loadThinkState(id);
    if (value && 'contract_digest' in value && value.contract_digest !== thinkContractDigest())
      throw new FlowError('Think governing contract changed', 'state_error');
    values[id] = thinkDigest(value);
  }
  return values;
}
async function rootReturns(runId: string, workflow: 'think' | 'build') {
  const build =
    workflow === 'build'
      ? (await import('../execution/controller.ts')).loadWorkflowState(runId).state
      : null;
  if (build?.status === 'cancelled') return null;
  const invocation =
    workflow === 'think' ? loadThinkState(runId)?.invocation : build!.invocation_id;
  if (!invocation) return null;
  const file = path.join(workflowRunDirectory(runId), `returns-${invocation}.json`);
  return { file, state: read(file, invocation) };
}
export function validateWaitingLeaf(waiting: WaitingResult): void {
  const { owner } = waiting;
  const state =
    owner.workflow === 'research' ? loadResearchState(owner.leaf) : loadThinkState(owner.leaf);
  if (state && 'contract_digest' in state && state.contract_digest !== thinkContractDigest())
    throw new FlowError('Think governing contract changed', 'state_error');
  if (!state || state.phase !== 'waiting')
    throw new FlowError('waiting leaf changed', 'state_error');
  const expected =
    owner.workflow === 'research'
      ? researchWaitingOwner(
          state as NonNullable<ReturnType<typeof loadResearchState>>,
          owner.root,
          owner.task,
        )
      : thinkWaitingOwner(
          state as NonNullable<ReturnType<typeof loadThinkState>>,
          owner.root,
          owner.task,
        );
  const question = 'pending_question' in state ? state.pending_question : state.candidate?.question;
  const snapshot =
    owner.workflow === 'research'
      ? researchSnapshotPath(owner.leaf, state)
      : thinkSnapshotPath(owner.leaf, state);
  if (
    !sameValue(expected, owner) ||
    !sameValue(state.pending_owner, owner) ||
    !sameValue(question, waiting.question) ||
    sealRepository(snapshot).source_digest !== owner.snapshot
  )
    throw new FlowError('waiting leaf question, acceptance or snapshot changed', 'state_error');
}
/** Called under root ownership before any controller, actor or child dispatch. */
export async function resumeRootWaiting(
  runId: string,
  workflow: 'think' | 'build',
  inputFile: string,
): Promise<WaitingResult | null> {
  if (path.resolve(inputFile) !== workflowInputPath(runId, workflow))
    throw new FlowError('use the original hook input path', 'state_error');
  const record = await rootReturns(runId, workflow);
  if (!record) return null;
  const { file, state } = record;
  const submitted = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  if (state.parent_transition) {
    inputAnswerDelta(state.input, submitted);
    settleParentTransition(file, state);
  }
  if (!state.waiting) {
    if (workflow === 'think') return null;
    inputAnswerDelta(state.input, submitted);
    return null;
  }
  if (workflow === 'build') {
    const build = (await import('../execution/controller.ts')).loadWorkflowState(runId).state;
    if (
      !build.handoff ||
      sealRepository(build.manifest.repo).source_digest !== build.handoff.source_digest
    )
      throw new FlowError('Build source changed while waiting', 'state_error');
  }
  if (state.waiting.owner.task !== runId || state.waiting.owner.root !== state.root)
    throw new FlowError('cross-owner root submission', 'state_error');
  for (const entry of state.entries) {
    const child =
      entry.route === 'research' ? loadResearchState(entry.id) : loadThinkState(entry.id);
    if (
      child ? child.stage_binding !== entryBinding(state, entry) : state.started.includes(entry.id)
    )
      throw new FlowError('cross-stage dispatch entry changed', 'state_error');
    if (!child) {
      // A routed answer may let Think reserve its Research child before a process exit.
      // Re-establish that exact reservation from the independently reviewed parent.
      const parent = await parentReturn(
        entry.parent,
        entry.parent === state.task ? workflow : 'think',
      );
      if (
        state.adoption?.phase !== 'routed' ||
        entry.id === state.waiting.owner.leaf ||
        entry.key !== thinkDigest({ parent: parent.parent, binding: parent.binding }) ||
        entry.route !== parent.route ||
        !sameValue(entry.input, parent.input) ||
        entry.answers.length !== 0 ||
        !sameValue(entry.inherited, rootHistory(state, state.input)) ||
        entry.snapshot !== parent.snapshot ||
        entry.source !== parent.source
      )
        throw new FlowError('cross-stage reservation changed', 'state_error');
    }
    // Read-only snapshots are immutable throughout waiting and routing.
    const logical =
      workflow === 'build' ? sealRepository((state.input as { repo: string }).repo) : undefined;
    const actual = sealRepository(entry.snapshot, logical ? { logical } : {}).source_digest;
    // Think's private snapshot has its own Git identity, unlike Build's handoff snapshot.
    if (actual !== entry.source && sealRepository(entry.snapshot).source_digest !== entry.source)
      throw new FlowError('cross-stage snapshot changed', 'state_error');
    const childFile = workflowInputPath(entry.id, entry.route);
    if (!fs.existsSync(childFile) && !child) continue;
    if (!sameValue(JSON.parse(fs.readFileSync(childFile, 'utf8')), entryInput(entry))) {
      const prior = { ...entry, answers: entry.answers.slice(0, -1) };
      if (
        state.adoption?.phase !== 'adopting' ||
        entry.id !== state.waiting.owner.leaf ||
        !sameValue(JSON.parse(fs.readFileSync(childFile, 'utf8')), entryInput(prior))
      )
        throw new FlowError('child input changed', 'state_error');
    }
  }
  if (!state.adoption) {
    if (!sameValue(parentDigests(state), state.parents))
      throw new FlowError('waiting parent authority changed', 'state_error');
    validateWaitingLeaf(state.waiting);
    const answer = inputAnswerDelta(state.input, submitted, state.waiting);
    if (!answer) return state.waiting;
    const nextRoot = workflow === 'think' ? answeredThinkState(runId, submitted) : null;
    state.adoption = {
      answer,
      phase: 'adopting',
      root_after: nextRoot ? thinkDigest(nextRoot) : state.parents[runId]!,
    };
    state.input = submitted;
    const leaf = state.entries.find((e) => e.id === state.waiting!.owner.leaf);
    if (!leaf) throw new FlowError('waiting leaf is not owned by this root', 'state_error');
    leaf.answers.push(answer);
    save(file, state); // root adoption and desired child input are one journal write
  } else inputAnswerDelta(state.input, submitted);
  const target = state.entries.find((entry) => entry.id === state.waiting!.owner.leaf);
  const rootAnswers =
    (state.input as { clarification_answers?: unknown[] }).clarification_answers ?? [];
  if (
    !target ||
    !sameValue(rootAnswers.at(-1), state.adoption.answer) ||
    !sameValue(target.answers.at(-1), state.adoption.answer) ||
    !sameValue(state.adoption.answer.owner, state.waiting.owner)
  )
    throw new FlowError('answer routing journal conflicts with its root or leaf', 'state_error');
  if (state.adoption.phase === 'adopting') {
    const currentParents = parentDigests(state);
    for (const [id, digest] of Object.entries(state.parents)) {
      if (
        currentParents[id] !== digest &&
        !(id === runId && currentParents[id] === state.adoption.root_after)
      )
        throw new FlowError('parent changed before child answer routing', 'state_error');
    }
    const leaf = state.entries.find((e) => e.id === state.waiting!.owner.leaf)!;
    atomicWrite(workflowInputPath(leaf.id, leaf.route), entryInput(leaf));
    if (workflow === 'think') {
      const parent = loadThinkState(runId)!;
      const next = answeredThinkState(runId, state.input);
      const digest = thinkDigest(parent);
      if (
        ![state.parents[runId], state.adoption.root_after].includes(digest) ||
        thinkDigest(next) !== state.adoption.root_after
      )
        throw new FlowError('root changed during answer routing', 'state_error');
      saveThinkState(runId, next);
      state.parents[runId] = thinkDigest(next);
    }
    state.adoption.phase = 'routed';
    save(file, state);
  }
  validateParents(state);
  return null;
}

/** The original Build authority hash stays immutable; only the journaled full input is accepted. */
export function requireRoutedBuildInput(
  runId: string,
  invocation: string,
  input: unknown,
): boolean {
  const file = path.join(workflowRunDirectory(runId), `returns-${invocation}.json`);
  const state = read(file, invocation);
  return (
    state.task === runId &&
    state.workflow === 'build' &&
    state.entries.some((e) => e.answers.length) &&
    sameValue(state.input, input)
  );
}

export function storedRootQuestion(runId: string, invocation: string): WaitingResult | null {
  const file = path.join(workflowRunDirectory(runId), `returns-${invocation}.json`);
  const state = read(file, invocation);
  if (state.adoption || !state.waiting) return null;
  const leaf = state.entries.find((entry) => entry.id === state.waiting!.owner.leaf);
  if (
    state.task !== runId ||
    state.waiting.owner.task !== runId ||
    state.waiting.owner.root !== invocation ||
    !leaf ||
    leaf.route !== state.waiting.owner.workflow ||
    entryBinding(state, leaf) !== state.waiting.owner.handoff ||
    !sameValue(parentDigests(state), state.parents)
  )
    throw new FlowError('waiting parent authority changed', 'state_error');
  validateWaitingLeaf(state.waiting);
  return state.waiting;
}

function answeredThinkState(runId: string, input: unknown) {
  const next = structuredClone(loadThinkState(runId)!);
  next.raw_input = input;
  next.input = {
    ...next.input,
    clarification_answers: (input as { clarification_answers: unknown[] }).clarification_answers,
  };
  next.input_digest = thinkDigest(input);
  next.clarification_history = (next.input.clarification_answers ?? []).map(
    parseClarificationAnswer,
  );
  return next;
}

/** Answer appends change neither the reserved child identity nor its original dispatch authority. */
function entryBinding(state: Returns, entry: ReturnEntry): string {
  const { answers: _answers, ...original } = entry;
  return thinkDigest({
    root: state.root,
    task: state.task,
    workflow: state.workflow,
    entry: original,
  });
}

/** Standalone selection captures completed child evidence; it never grants publication authority. */
export function captureRetainedResearch(repo: string, selection: string) {
  const file = path.resolve(selection);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new FlowError(
      'Retained Research must select readable completed child JSON',
      'state_error',
    );
  const root = path.dirname(workflowRunDirectory('retained-research-lookup'));
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const record = path.join(root, directory.name, 'research-state.json');
    if (!fs.existsSync(record)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(record, 'utf8'));
    } catch {
      continue;
    }
    if (raw.state?.publication?.json !== file) continue;
    const child = loadResearchState(raw.state.run_id);
    if (
      !child ||
      child.phase !== 'completed' ||
      !child.stage_binding ||
      !child.child_owner ||
      fs.realpathSync(child.input.repo) !== fs.realpathSync(repo)
    )
      throw new FlowError('Retained Research has no accepted child ownership', 'state_error');
    const journal = read(child.child_owner.file, child.child_owner.root);
    const entry = journal.entries.find(
      (item) => item.id === child.run_id && item.route === 'research',
    );
    if (
      !entry ||
      !journal.started.includes(child.run_id) ||
      entryBinding(journal, entry) !== child.stage_binding ||
      !sameValue(entryInput(entry), child.raw_input)
    )
      throw new FlowError('Retained Research ownership or answers changed', 'state_error');
    const report = reportForCandidate(child);
    if (fs.readFileSync(file, 'utf8') !== `${JSON.stringify(report, null, 2)}\n`)
      throw new FlowError('Retained Research report changed', 'state_error');
    return {
      report: structuredClone(report),
      identity: researchDigest(report),
      clarification_answers: structuredClone(child.clarification_history),
    };
  }
  throw new FlowError(
    'Retained Research requires its original completed child state and audit',
    'state_error',
  );
}
