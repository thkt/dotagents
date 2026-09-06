/** @file Outcome: Only one local process may drive or cancel a workflow at a time. */

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import path from 'node:path';
import { workflowRunDirectory } from './storage.ts';
import { FlowError, errorCode } from '../shared/errors.ts';

/** Keep the lock inode permanently; deleting it would allow two independent owners. */
export function acquireWorkflowOwnership(runId: string): Disposable {
  const directory = workflowRunDirectory(runId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'ownership.sqlite');
  const existing = fs.lstatSync(file, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new FlowError('workflow ownership must be a regular local file', 'state_error');
  }
  const db = new Database(file, { create: true });
  try {
    // SQLite's OS lock survives asynchronous agent work and releases on process death.
    // Never reclaim locks based on a timeout or PID liveness guess.
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    fs.chmodSync(file, 0o600);
  } catch (error) {
    db.close();
    if (errorCode(error) === 'SQLITE_BUSY' || errorCode(error) === 'SQLITE_LOCKED') {
      throw new FlowError('workflow already has an active runtime owner', 'workflow_busy');
    }
    throw error;
  }
  return {
    [Symbol.dispose]() {
      db.close();
    },
  };
}
