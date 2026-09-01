/** @file Outcome: Tests allocate isolated temporary state and always restore process state. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, onTestFinished } from 'bun:test';

/** Allocates a directory owned by the current test and removes it after the test. */
export function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Gives one test module a private workflow state root and restores the environment at exit. */
export function useTemporaryStateDirectory(prefix: string): string {
  const previous = process.env.CODEX_FLOW_STATE_DIR;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CODEX_FLOW_STATE_DIR = directory;
  afterAll(() => {
    if (previous === undefined) delete process.env.CODEX_FLOW_STATE_DIR;
    else process.env.CODEX_FLOW_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
