#!/usr/bin/env bun
/** @file Outcome: Cleanup starts only from a task-bound preview followed by an explicit exact-digest approval. */
import fs from 'node:fs';
import path from 'node:path';
import { parseCommand, readAbsoluteJson, requireExactFlags, runCli } from '../runtime/cli.ts';
import { CLEANUP_COMMAND, isMainModule } from '../runtime/environment.ts';
import { clearIntent, requireCleanupIntent } from '../runtime/invocation.ts';
import { acquireWorkflowOwnership } from '../runtime/ownership.ts';
import { workflowInputPath } from '../runtime/storage.ts';
import { FlowError } from '../shared/errors.ts';
import { canonical, closed, recordExists, text } from './state.ts';
import { approveCleanup, prepareCleanup, runCleanup } from './controller.ts';
import { type EvidenceGateway, githubEvidence } from './evidence.ts';

export function cleanupCommand(
  command: string,
  runId: string,
  inputFile: string,
  gateway: EvidenceGateway = githubEvidence,
): unknown {
  using _task = acquireWorkflowOwnership(runId);
  if (!['prepare', 'run', 'resume'].includes(command))
    throw new FlowError('unknown cleanup command');
  if (path.resolve(inputFile) !== workflowInputPath(runId, 'cleanup'))
    throw new FlowError('cleanup requires the hook-supplied input path', 'authorization_error');
  const input = closed(
    readAbsoluteJson(inputFile, 'cleanup input'),
    command === 'prepare' ? ['repo', 'command', 'issue'] : ['repo', 'command', 'prepared_digest'],
    'cleanup input',
  );
  const repo = fs.realpathSync(text(input.repo, 'repository'));
  if (input.repo !== repo || input.command !== (command === 'resume' ? 'run' : command))
    throw new FlowError('cleanup input binding changed', 'authorization_error');
  if (command !== 'resume') {
    const intent = requireCleanupIntent(runId, repo, inputFile);
    const { repo: _repo, ...invocation } = input;
    if (canonical(intent.cleanup) !== canonical(invocation))
      throw new FlowError('cleanup input differs from explicit invocation', 'authorization_error');
  }
  if (command === 'prepare') {
    const preview = prepareCleanup(repo, runId, Number(input.issue), null, gateway);
    clearIntent(runId);
    const p = preview.prepared;
    return {
      protocol: 'codex-cleanup-preview',
      prepared_digest: preview.prepared_digest,
      repository: p.repository,
      repository_owner: p.source.repository,
      issue: p.issue,
      base: { ref: p.source.proof.base_ref, oid: p.base_oid },
      targets: {
        endpoint: p.source.endpoint,
        topic_ref: p.source.proof.head_ref,
        expected_oid: p.source.proof.head_oid,
        tracking_ref: p.tracking_ref,
      },
      saved_paths: Object.keys(p.inventory.files),
      ownership_id: p.ownership_id,
      approval: `$cleanup approve ${preview.prepared_digest}`,
    };
  }
  const id = text(input.prepared_digest, 'prepared digest');
  if (command === 'run') {
    // A durable approval may survive interruption before intent consumption.
    if (!recordExists(repo, 'approval', id)) approveCleanup(repo, runId, id);
    clearIntent(runId);
  }
  return runCleanup(repo, runId, id, gateway);
}
export function main(argv: string[] = process.argv.slice(2)): unknown {
  const { command, flags } = parseCommand(argv);
  if (command === 'describe') {
    requireExactFlags(flags, []);
    return {
      protocol: 'codex-cleanup-description',
      outcome:
        'Restore saved local state onto the verified merged base before deleting exact approved topic refs.',
      commands: ['prepare', 'run', 'resume'].map(
        (c) => `${CLEANUP_COMMAND} ${c} --input <hook-supplied-json>`,
      ),
      approval: '$cleanup approve <prepared digest>',
      task_binding: 'hook-injected',
      recovery:
        'Resume only the original input. Ambiguous pending remote deletion requires manual resolution.',
    };
  }
  requireExactFlags(flags, ['--input', '--run-id']);
  return cleanupCommand(command, flags['--run-id']!, flags['--input']!);
}
if (isMainModule(import.meta.url)) runCli(main, 'codex-cleanup-result');
