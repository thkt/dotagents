/** @file Outcome: Explicitly approved cleanup restores saved state before journaled expected-OID deletion. */
import fs from 'node:fs';
import path from 'node:path';
import { FlowError, errorCode, errorMessage } from '../shared/errors.ts';
import { cleanupArtifactDirectory, cleanupRepository } from '../runtime/storage.ts';
import {
  canonical,
  flush,
  parseCleanupResult,
  type CleanupResult,
  closed,
  counter,
  digest,
  oid,
  ownCleanup,
  probeDurability,
  publishRecord,
  readRecord,
  recordExists,
  recordIdentities,
  replaceDurable,
  assertNoCleanup,
  assertNoImplementation,
  text,
} from './state.ts';
import {
  commonDirectory,
  git,
  gitDirectory,
  gitText,
  inventoryRepository,
  parseInventory,
  requireSame,
  type Inventory,
  type Entries,
} from './inventory.ts';
import {
  githubEvidence,
  parseProof,
  parseSource,
  selectSource,
  sourceIdentity,
  verifySource,
  type EvidenceGateway,
  type Proof,
  type SourceReceipt,
} from './evidence.ts';
import {
  captureRecovery,
  readRecovery,
  recoveryIdentity,
  restoration,
  requireFileTransition,
  verifyRecoveryPreimage,
  writeFiles,
  writeIndex,
  type Recovery,
  type RestorePlan,
} from './recovery.ts';

export interface Prepared {
  repository: string;
  run_id: string;
  issue: number;
  source: SourceReceipt;
  inventory: Inventory;
  merged: Proof;
  base_oid: string;
  local_base_oid: string;
  tracking_ref: string | null;
  ownership_id: string;
}
const steps = [
  'capture',
  'register',
  'fetch',
  'materialize',
  'checkout',
  'restore',
  'remote',
  'config',
  'local',
  'recovery',
  'fetch_cleanup',
  'audit',
] as const;
type Step = (typeof steps)[number];
interface Journal {
  approval: string;
  sequence: number;
  previous: string | null;
  step: Step | 'genesis';
  phase: 'pending' | 'done';
}
function parsePrepared(raw: unknown): Prepared {
  const p = closed(
    raw,
    [
      'repository',
      'run_id',
      'issue',
      'source',
      'inventory',
      'merged',
      'base_oid',
      'local_base_oid',
      'tracking_ref',
      'ownership_id',
    ],
    'prepared cleanup',
  );
  const source = parseSource(p.source),
    inventory = parseInventory(p.inventory),
    merged = parseProof(p.merged);
  const repository = text(p.repository, 'repository');
  const result = {
    repository,
    run_id: text(p.run_id, 'run id'),
    issue: counter(p.issue, 'Issue'),
    source,
    inventory,
    merged,
    base_oid: oid(p.base_oid, source.format),
    local_base_oid: oid(p.local_base_oid, source.format),
    tracking_ref: p.tracking_ref === null ? null : text(p.tracking_ref, 'tracking ref'),
    ownership_id: text(p.ownership_id, 'ownership'),
  };
  if (
    inventory.repository !== repository ||
    inventory.format !== source.format ||
    source.issue !== result.issue ||
    result.ownership_id !== recoveryIdentity(sourceIdentity(source), inventory)
  )
    throw new FlowError('prepared cleanup bindings changed', 'cleanup_record_invalid');
  return result;
}
function parseJournal(raw: unknown): Journal {
  const j = closed(raw, ['approval', 'sequence', 'previous', 'step', 'phase'], 'journal');
  if (
    !['genesis', ...steps].includes(String(j.step)) ||
    !['pending', 'done'].includes(String(j.phase)) ||
    !(j.previous === null || typeof j.previous === 'string')
  )
    throw new FlowError('invalid journal transition', 'cleanup_record_invalid');
  return {
    approval: text(j.approval, 'approval'),
    sequence: counter(j.sequence, 'sequence'),
    previous: j.previous as string | null,
    step: j.step as Journal['step'],
    phase: j.phase as Journal['phase'],
  };
}
const journalId = (approval: string, sequence: number) => digest('journal', { approval, sequence });
const watermark = (repo: string, id: string) =>
  path.join(cleanupArtifactDirectory(repo), 'journal-tip', `${id}.json`);
function append(
  repo: string,
  list: Journal[],
  record: Omit<Journal, 'sequence' | 'previous'>,
): void {
  const entry = {
    ...record,
    sequence: list.length,
    previous: list.length ? digest('journal-revision', list.at(-1)) : null,
  };
  publishRecord(repo, 'journal', journalId(record.approval, list.length), entry);
  replaceDurable(
    watermark(repo, record.approval),
    canonical({ sequence: entry.sequence, digest: digest('journal-revision', entry) }) + '\n',
  );
  list.push(entry);
}
function loadJournal(repo: string, id: string): Journal[] {
  const list = recordIdentities(repo, 'journal')
    .map((key) => readRecord(repo, 'journal', key, parseJournal))
    .filter((j) => j.approval === id)
    .sort((a, b) => a.sequence - b.sequence);
  for (const [n, j] of list.entries()) {
    if (
      j.sequence !== n ||
      j.previous !== (n ? digest('journal-revision', list[n - 1]) : null) ||
      j.step !== (n === 0 ? 'genesis' : steps[Math.floor((n - 1) / 2)]) ||
      j.phase !== (n === 0 || n % 2 === 0 ? 'done' : 'pending')
    )
      throw new FlowError(
        'forked, truncated or incompatible cleanup journal',
        'cleanup_record_invalid',
      );
  }
  const tip = watermark(repo, id);
  if (fs.existsSync(tip)) {
    const t = closed(
      JSON.parse(fs.readFileSync(tip, 'utf8')),
      ['sequence', 'digest'],
      'journal tip',
    );
    const at = list[counter(t.sequence, 'tip sequence')];
    if (!at || digest('journal-revision', at) !== t.digest)
      throw new FlowError('cleanup journal was truncated', 'cleanup_record_invalid');
  }
  if (list.length)
    replaceDurable(
      tip,
      canonical({
        sequence: list.at(-1)!.sequence,
        digest: digest('journal-revision', list.at(-1)),
      }) + '\n',
    );
  return list;
}
function activeOperations(inventory: Inventory): void {
  if (
    Object.keys(inventory.metadata).some((p) =>
      /(?:^|\/)(?:MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|BISECT_LOG|rebase-merge|rebase-apply|sequencer|shallow|sharedindex\.[^/]+)(?:\/|$)/u.test(
        p,
      ),
    )
  )
    throw new FlowError('active or unsupported Git operation/index state', 'cleanup_unsupported');
}
export function prepareCleanup(
  repo: string,
  runId: string,
  issue: number,
  trackingRef: string | null = null,
  gateway: EvidenceGateway = githubEvidence,
): { prepared_digest: string; prepared: Prepared } {
  repo = fs.realpathSync(repo);
  using _owner = ownCleanup(repo);
  assertNoImplementation(repo);
  assertNoCleanup(repo);
  probeDurability(repo);
  const source = selectSource(repo, issue);
  const merged = verifySource(repo, source, gateway, true);
  const inventory = inventoryRepository(repo);
  activeOperations(inventory);
  if (
    inventory.branch !== source.proof.head_ref ||
    inventory.head !== source.proof.head_oid ||
    inventory.refs[source.proof.head_ref] !== source.proof.head_oid
  )
    throw new FlowError('local topic differs from shipped source', 'cleanup_drift');
  for (const w of Object.values(inventory.worktrees))
    if ([source.proof.head_ref, source.proof.base_ref].includes(w.branch))
      throw new FlowError('another worktree uses the topic or return branch', 'cleanup_busy');
  if (
    trackingRef &&
    (trackingRef !== `refs/remotes/${source.remote}/${source.proof.head_ref.slice(11)}` ||
      inventory.refs[trackingRef] !== source.proof.head_oid ||
      inventory.symrefs[trackingRef])
  )
    throw new FlowError('tracking ref is not the selected expected-OID target', 'cleanup_drift');
  const base_oid = gateway.remote(repo, source.endpoint, source.proof.base_ref),
    topic = gateway.remote(repo, source.endpoint, source.proof.head_ref);
  if (!base_oid || topic !== source.proof.head_oid)
    throw new FlowError('remote base/topic missing or changed before preparation', 'cleanup_drift');
  const local_base_oid = inventory.refs[source.proof.base_ref];
  if (
    !local_base_oid ||
    inventory.symrefs[source.proof.base_ref] ||
    inventory.symrefs[source.proof.head_ref]
  )
    throw new FlowError('return base/topic must be local direct branches', 'cleanup_drift');
  const prepared: Prepared = {
    repository: repo,
    run_id: runId,
    issue,
    source,
    inventory,
    merged,
    base_oid,
    local_base_oid,
    tracking_ref: trackingRef,
    ownership_id: recoveryIdentity(sourceIdentity(source), inventory),
  };
  // If the object is already available, discover restore conflicts without any repository mutation.
  if (hasObject(repo, base_oid)) validateBase(repo, prepared);
  const id = digest('prepared', prepared);
  publishRecord(repo, 'prepared', id, prepared);
  return { prepared_digest: id, prepared };
}
function hasObject(repo: string, object: string): boolean {
  try {
    return gitText(repo, ['cat-file', '-t', object]) === 'commit';
  } catch {
    return false;
  }
}
function validateBase(repo: string, p: Prepared): RestorePlan {
  git(repo, ['merge-base', '--is-ancestor', p.local_base_oid, p.base_oid]);
  return restoration(repo, p.inventory, p.base_oid);
}
function readPrepared(repo: string, id: string, runId: string): Prepared {
  const p = readRecord(repo, 'prepared', id, parsePrepared);
  if (
    digest('prepared', p) !== id ||
    p.run_id !== runId ||
    p.repository !== fs.realpathSync(repo) ||
    p.source.repository !== cleanupRepository(repo)
  )
    throw new FlowError(
      'cleanup approval belongs to different input/task/repository',
      'authorization_error',
    );
  return p;
}
/** The runtime calls this only after validating its durable, digest-bound explicit approval intent. */
export function approveCleanup(repo: string, runId: string, id: string): void {
  using _owner = ownCleanup(repo);
  assertNoImplementation(repo);
  assertNoCleanup(repo);
  probeDurability(repo);
  const p = readPrepared(repo, id, runId);
  requireSame(inventoryRepository(repo), p.inventory, 'prepared preimage');
  publishRecord(repo, 'approval', id, { prepared_digest: id, run_id: runId });
}
function recoveryRef(p: Prepared): string {
  return `refs/codex-cleanup/stashes/${p.ownership_id}`;
}
function fetchRef(p: Prepared): string {
  return `refs/codex-cleanup/fetch/${p.ownership_id}`;
}
function marker(id: string): string {
  return `cleanup ${id}`;
}
function configAfter(repo: string, p: Prepared): Entries {
  const result: Entries = {};
  for (const [key, value] of Object.entries(p.inventory.metadata)) {
    if (!/^(?:common|worktree)\/config(?:\.worktree)?$/u.test(key)) continue;
    const file = path.join(cleanupArtifactDirectory(repo), 'config-preview');
    fs.writeFileSync(file, Buffer.from(value.bytes, 'base64'), { mode: 0o600 });
    try {
      git(repo, [
        'config',
        '--file',
        file,
        '--remove-section',
        `branch.${p.source.proof.head_ref.slice(11)}`,
      ]);
    } catch (error) {
      if (
        gitText(repo, ['config', '--file', file, '--list'])
          .split('\n')
          .some((l) => l.startsWith(`branch.${p.source.proof.head_ref.slice(11)}.`))
      )
        throw error;
    }
    result[key] = { ...value, bytes: fs.readFileSync(file).toString('base64') };
    fs.rmSync(file);
  }
  return result;
}
/** Only approved identities are excluded from protection; each excluded value is checked separately. */
function protect(
  repo: string,
  p: Prepared,
  actual: Inventory,
  id: string,
  done: Set<Step>,
  pending: Step | null,
  restore: RestorePlan | null,
  recovery: Recovery | null,
): void {
  const allowed = (step: Step) => done.has(step) || pending === step;
  requireSame(actual.repository, p.repository, 'repository');
  requireSame(actual.format, p.inventory.format, 'format');
  requireSame(actual.worktrees, p.inventory.worktrees, 'other worktrees');
  const topic = p.source.proof.head_ref,
    base = p.source.proof.base_ref,
    targets = [topic, ...(p.tracking_ref ? [p.tracking_ref] : [])],
    own = [recoveryRef(p), fetchRef(p)];
  const filter = (map: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(map).filter(([k]) => ![base, ...targets, ...own].includes(k)),
    );
  requireSame(filter(actual.refs), filter(p.inventory.refs), 'unrelated refs');
  requireSame(actual.symrefs, p.inventory.symrefs, 'symbolic refs');
  const expectedBase = done.has('checkout') ? p.base_oid : p.local_base_oid;
  if (
    actual.refs[base] !== expectedBase &&
    !(pending === 'checkout' && actual.refs[base] === p.base_oid)
  )
    throw new FlowError('return base moved', 'cleanup_drift');
  for (const ref of targets) {
    const v = actual.refs[ref];
    if (v === undefined ? !allowed('local') : v !== p.source.proof.head_oid || done.has('local'))
      throw new FlowError(`topic ref moved/recreated: ${ref}`, 'cleanup_drift');
  }
  const r = actual.refs[recoveryRef(p)];
  if (
    r !== undefined &&
    (!allowed('register') || !recovery || r !== recovery.recovery_oid || done.has('recovery'))
  )
    throw new FlowError('recovery ref mismatch', 'cleanup_drift');
  if (r === undefined && done.has('register') && !allowed('recovery'))
    throw new FlowError('owned recovery ref disappeared', 'cleanup_drift');
  const f = actual.refs[fetchRef(p)];
  if (f !== undefined && (f !== p.base_oid || !allowed('fetch') || done.has('fetch_cleanup')))
    throw new FlowError('owned fetch ref mismatch', 'cleanup_drift');
  if (
    actual.head !== (done.has('checkout') ? p.base_oid : p.inventory.head) &&
    !(pending === 'checkout' && actual.head === p.base_oid)
  )
    throw new FlowError('HEAD changed', 'cleanup_drift');
  if (
    actual.branch !== (done.has('checkout') ? base : topic) &&
    !(pending === 'checkout' && actual.branch === base)
  )
    throw new FlowError('checkout changed', 'cleanup_drift');
  const expectedFiles = done.has('restore')
    ? restore!.restored
    : done.has('materialize')
      ? restore!.materialized
      : p.inventory.files;
  if (pending === 'materialize')
    requireFileTransition(actual.files, p.inventory.files, restore!.materialized);
  else if (pending === 'restore')
    requireFileTransition(actual.files, restore!.materialized, restore!.restored);
  else requireSame(actual.files, expectedFiles, 'working files');
  const expectedIndex = done.has('restore') ? restore!.restored_index : p.inventory.index;
  if (pending === 'restore') {
    if (
      canonical(actual.index) !== canonical(p.inventory.index) &&
      canonical(actual.index) !== canonical(restore!.restored_index)
    )
      throw new FlowError('index changed during restore', 'cleanup_drift');
  } else requireSame(actual.index, expectedIndex, 'index');
  const config = configAfter(repo, p);
  const indexKey = gitDirectory(repo) === commonDirectory(repo) ? 'common/index' : 'worktree/index';
  for (const key of new Set([
    ...Object.keys(actual.metadata),
    ...Object.keys(p.inventory.metadata),
  ])) {
    if (key === indexKey) continue; // semantic entries are compared above; Git stat-cache bytes are derived.
    const before = p.inventory.metadata[key],
      value = actual.metadata[key];
    if (key in config && allowed('config')) {
      if (
        canonical(value ?? null) !== canonical(config[key]) &&
        !(pending === 'config' && canonical(value ?? null) === canonical(before ?? null))
      )
        throw new FlowError('unrelated config changed', 'cleanup_drift');
      continue;
    }
    if (
      key === (indexKey === 'common/index' ? 'common/HEAD' : 'worktree/HEAD') &&
      allowed('checkout')
    ) {
      const expected = { ...before!, bytes: Buffer.from(`ref: ${base}\n`).toString('base64') };
      if (
        canonical(value ?? null) === canonical(expected) ||
        (pending === 'checkout' && canonical(value ?? null) === canonical(before ?? null))
      )
        continue;
      throw new FlowError('HEAD metadata changed', 'cleanup_drift');
    }
    const logRef = key.startsWith('common/logs/')
      ? key.slice(12)
      : key.startsWith('worktree/logs/')
        ? key.slice(14)
        : null;
    if (
      key.startsWith('common/logs/') &&
      logRef &&
      targets.includes(logRef) &&
      allowed('local') &&
      !value
    )
      continue;
    if (logRef && own.includes(logRef) && !value) continue;
    const currentHeadLog = indexKey === 'common/index' ? 'common/logs/HEAD' : 'worktree/logs/HEAD';
    if (
      (key === currentHeadLog || key === `common/logs/${base}`) &&
      allowed('checkout') &&
      value?.kind === 'file'
    ) {
      const old = Buffer.from(before?.bytes ?? '', 'base64').toString(),
        now = Buffer.from(value.bytes, 'base64').toString();
      const suffix = now.startsWith(old) ? now.slice(old.length) : null;
      if (
        suffix !== null &&
        (!suffix ||
          (suffix.split('\n').filter(Boolean).length === 1 &&
            suffix.endsWith(`\t${marker(id)}\n`) &&
            suffix.split(' ')[1] === p.base_oid))
      )
        continue;
    }
    requireSame(value ?? null, before ?? null, `Git metadata ${key}`);
  }
}
function localDelete(repo: string, p: Prepared, actual: Inventory): void {
  const targets = [p.source.proof.head_ref, ...(p.tracking_ref ? [p.tracking_ref] : [])];
  const present = targets.filter((r) => actual.refs[r] !== undefined);
  if (!present.length) return;
  if (present.length !== targets.length)
    throw new FlowError('partially missing local targets before atomic deletion', 'cleanup_drift');
  git(
    repo,
    ['update-ref', '--stdin'],
    `start\n${targets.map((r) => `delete ${r} ${p.source.proof.head_oid}\n`).join('')}prepare\ncommit\n`,
  );
}
export function runCleanup(
  repo: string,
  runId: string,
  id: string,
  gateway: EvidenceGateway = githubEvidence,
  afterEffect?: (step: Step) => void,
): CleanupResult {
  repo = fs.realpathSync(repo);
  using _owner = ownCleanup(repo);
  assertNoImplementation(repo);
  probeDurability(repo);
  const p = readPrepared(repo, id, runId);
  const list = loadJournal(repo, id);
  if (recordExists(repo, 'report', id)) return readRecord(repo, 'report', id, parseCleanupResult);
  if (!list.length) {
    const approval = readRecord(repo, 'approval', id, (v) =>
      closed(v, ['prepared_digest', 'run_id'], 'approval'),
    );
    if (approval.prepared_digest !== id || approval.run_id !== runId)
      throw new FlowError('approval binding mismatch', 'authorization_error');
    requireSame(inventoryRepository(repo), p.inventory, 'approval preimage');
    append(repo, list, { approval: id, step: 'genesis', phase: 'done' });
  }
  const done = new Set<Step>(
    list.filter((j) => j.phase === 'done' && j.step !== 'genesis').map((j) => j.step as Step),
  );
  let recovery: Recovery | null = recordExists(repo, 'recovery', p.ownership_id)
    ? readRecovery(repo, p.ownership_id, p.source.format)
    : null;
  let pending: Step | null = list.at(-1)?.phase === 'pending' ? (list.at(-1)!.step as Step) : null;
  let restore: RestorePlan | null = null;
  const result = (status: CleanupResult['status'], reason: string | null): CleanupResult => ({
    protocol: 'codex-cleanup-result',
    status,
    prepared_digest: id,
    base_ref: p.source.proof.base_ref,
    topic_ref: p.source.proof.head_ref,
    tracking_ref: p.tracking_ref,
    endpoint: p.source.endpoint,
    base_oid: p.base_oid,
    completed: [...done],
    pending,
    unattempted: steps.filter((s) => !done.has(s) && s !== pending),
    recovery_oid: recovery?.recovery_oid ?? null,
    recovery_ref:
      recovery &&
      gitText(repo, ['for-each-ref', '--format=%(objectname)', recoveryRef(p)]) ===
        recovery.recovery_oid
        ? recoveryRef(p)
        : null,
    reason,
  });
  try {
    for (const step of steps) {
      if (done.has(step)) continue;
      const resumed = pending === step;
      if (!restore && done.has('fetch')) restore = validateBase(repo, p);
      let actual = inventoryRepository(repo);
      protect(repo, p, actual, id, done, pending, restore, recovery);
      requireSame(verifySource(repo, p.source, gateway, true), p.merged, 'merged proof');
      if (gateway.remote(repo, p.source.endpoint, p.source.proof.base_ref) !== p.base_oid)
        throw new FlowError('remote base drift', 'cleanup_drift');
      const remote = gateway.remote(repo, p.source.endpoint, p.source.proof.head_ref);
      if (
        done.has('remote')
          ? remote !== null
          : remote !== p.source.proof.head_oid && !(step === 'remote' && resumed && remote === null)
      )
        throw new FlowError('remote topic moved, recreated or disappeared', 'cleanup_drift');
      if (!resumed) {
        append(repo, list, { approval: id, step, phase: 'pending' });
        pending = step;
      }
      switch (step) {
        case 'fetch':
          if (!hasObject(repo, p.base_oid)) {
            git(repo, [
              '-c',
              'gc.auto=0',
              '-c',
              'core.logAllRefUpdates=false',
              '-c',
              'maintenance.auto=false',
              '-c',
              'core.hooksPath=/dev/null',
              'fetch',
              '--no-tags',
              '--no-write-fetch-head',
              p.source.endpoint,
              `${p.source.proof.base_ref}:${fetchRef(p)}`,
            ]);
          }
          restore = validateBase(repo, p);
          break;
        case 'capture':
          recovery = captureRecovery(repo, sourceIdentity(p.source), p.inventory);
          verifyRecoveryPreimage(repo, recovery, p.inventory);
          break;
        case 'register':
          if (!actual.refs[recoveryRef(p)])
            git(repo, [
              '-c',
              'core.logAllRefUpdates=false',
              'update-ref',
              recoveryRef(p),
              recovery!.recovery_oid,
              '0'.repeat(p.source.format === 'sha1' ? 40 : 64),
            ]);
          break;
        case 'materialize':
          writeFiles(repo, p.inventory.files, restore!.materialized);
          break;
        case 'checkout':
          if (actual.refs[p.source.proof.base_ref] !== p.base_oid)
            git(repo, [
              'update-ref',
              '-m',
              marker(id),
              p.source.proof.base_ref,
              p.base_oid,
              p.local_base_oid,
            ]);
          if (actual.branch !== p.source.proof.base_ref)
            git(repo, ['symbolic-ref', '-m', marker(id), 'HEAD', p.source.proof.base_ref]);
          break;
        case 'restore':
          writeFiles(repo, restore!.materialized, restore!.restored);
          writeIndex(repo, restore!.restored_index);
          break;
        case 'remote':
          if (resumed && remote !== null)
            throw new FlowError(
              'pending remote deletion is ambiguous; retain local/recovery refs and resolve it manually before resuming',
              'cleanup_remote_ambiguous',
            );
          if (remote !== null)
            gateway.deleteRemote(
              repo,
              p.source.endpoint,
              p.source.proof.head_ref,
              p.source.proof.head_oid,
            );
          if (gateway.remote(repo, p.source.endpoint, p.source.proof.head_ref) !== null)
            throw new FlowError('remote deletion not confirmed', 'cleanup_remote_ambiguous');
          break;
        case 'config':
          for (const [key, entry] of Object.entries(configAfter(repo, p))) {
            const root = key.startsWith('common/') ? commonDirectory(repo) : gitDirectory(repo);
            replaceDurable(
              path.join(root, key.slice(key.indexOf('/') + 1)),
              Buffer.from(entry.bytes, 'base64').toString(),
            );
          }
          break;
        case 'local':
          localDelete(repo, p, actual);
          break;
        case 'recovery':
          if (actual.refs[recoveryRef(p)])
            git(repo, ['update-ref', '-d', recoveryRef(p), recovery!.recovery_oid]);
          break;
        case 'fetch_cleanup':
          if (actual.refs[fetchRef(p)]) git(repo, ['update-ref', '-d', fetchRef(p), p.base_oid]);
          break;
        case 'audit':
          break;
      }
      afterEffect?.(step);
      actual = inventoryRepository(repo);
      protect(repo, p, actual, id, new Set([...done, step]), null, restore, recovery);
      for (const root of new Set([commonDirectory(repo), gitDirectory(repo)])) {
        const visit = (directory: string): void => {
          for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
            if (e.name === 'objects') continue;
            const file = path.join(directory, e.name);
            if (e.isDirectory()) visit(file);
            else if (e.isFile()) flush(file);
          }
          flush(directory);
        };
        visit(root);
      }
      append(repo, list, { approval: id, step, phase: 'done' });
      done.add(step);
      pending = null;
    }
    restore ??= validateBase(repo, p);
    protect(repo, p, inventoryRepository(repo), id, done, null, restore, recovery);
    requireSame(verifySource(repo, p.source, gateway, true), p.merged, 'merged proof');
    if (
      gateway.remote(repo, p.source.endpoint, p.source.proof.head_ref) !== null ||
      gateway.remote(repo, p.source.endpoint, p.source.proof.base_ref) !== p.base_oid
    )
      throw new FlowError('remote state changed before final audit', 'cleanup_drift');
    const report = result('cleaned', null);
    publishRecord(repo, 'report', id, report);
    return report;
  } catch (error) {
    const report = result(
      errorCode(error) === 'cleanup_restore_conflict' ? 'blocked' : 'resumable',
      `${errorCode(error) ?? 'cleanup_error'}: ${errorMessage(error)}`,
    );
    publishRecord(repo, 'report', digest('retained-report', report), report);
    return report;
  }
}
