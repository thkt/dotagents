/** @file Outcome: Nested Codex processes receive one private writable home without sharing host operational state. */

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultWorkflowRuntimeDirectory, resolveCodexHome } from '../runtime/environment.ts';
import { FlowError } from './errors.ts';

const SDK_HOME_PREFIX = 'sdk-home-';
const STALE_SDK_HOME_MS = 24 * 60 * 60_000;
const temporaryCodexHomes = new Set<string>();
let cleanupRegistered = false;

/** Removes API-key overrides so workflow agents consume the signed-in Codex account. */
export function cleanCodexEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'OPENAI_API_KEY' && entry[0] !== 'CODEX_API_KEY',
    ),
  );
}

function removeTemporaryCodexHome(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Process cleanup is best effort and must not replace the workflow result.
  }
}

function cleanupTemporaryCodexHomes(): void {
  for (const directory of temporaryCodexHomes) removeTemporaryCodexHome(directory);
  temporaryCodexHomes.clear();
}

function registerTemporaryCodexHome(directory: string): void {
  temporaryCodexHomes.add(directory);
  if (cleanupRegistered) return;
  process.once('exit', cleanupTemporaryCodexHomes);
  cleanupRegistered = true;
}

function prepareRuntimeRoot(temporaryDirectory: string, now: number): string {
  const runtimeRoot = defaultWorkflowRuntimeDirectory(temporaryDirectory);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const root = fs.lstatSync(runtimeRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new FlowError('Codex runtime root must be a regular directory', 'execution_error');
  }
  fs.chmodSync(runtimeRoot, 0o700);
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(SDK_HOME_PREFIX) || !entry.isDirectory()) continue;
    const directory = path.join(runtimeRoot, entry.name);
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat && now - stat.mtimeMs >= STALE_SDK_HOME_MS) removeTemporaryCodexHome(directory);
  }
  return runtimeRoot;
}

function readSignedInAuth(env: NodeJS.ProcessEnv): Buffer {
  const configuredHome = env.HOME?.trim() || os.homedir();
  const sourceAuth = path.join(resolveCodexHome(env, configuredHome), 'auth.json');
  const auth = fs.lstatSync(sourceAuth, { throwIfNoEntry: false });
  if (!auth?.isFile() || auth.isSymbolicLink()) {
    throw new FlowError('signed-in Codex auth.json must be a regular file', 'execution_error');
  }
  return fs.readFileSync(sourceAuth);
}

/** Gives one nested Codex client writable private state and only the minimum signed-in credential. */
export function sandboxCodexEnvironment(
  env: NodeJS.ProcessEnv,
  temporaryDirectory: string = os.tmpdir(),
  now: number = Date.now(),
): Record<string, string> {
  const auth = readSignedInAuth(env);
  const runtimeRoot = prepareRuntimeRoot(temporaryDirectory, now);
  const sandboxHome = fs.mkdtempSync(path.join(runtimeRoot, SDK_HOME_PREFIX));
  try {
    fs.chmodSync(sandboxHome, 0o700);
    fs.writeFileSync(path.join(sandboxHome, 'auth.json'), auth, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    removeTemporaryCodexHome(sandboxHome);
    throw error;
  }
  registerTemporaryCodexHome(sandboxHome);
  return {
    ...cleanCodexEnvironment(env),
    HOME: sandboxHome,
    CODEX_HOME: sandboxHome,
  };
}
