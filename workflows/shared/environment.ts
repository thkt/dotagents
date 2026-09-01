/** @file Outcome: Runtime paths and entrypoint detection remain portable across users and installations. */

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FLOW_COMMAND = 'codex-flow';
export const ISSUE_COMMAND = 'codex-issue';
export const RESEARCH_COMMAND = 'codex-research';
export const THINK_COMMAND = 'codex-think';

export function isMainModule(
  metaUrl: string,
  entry: string | undefined = process.argv[1],
): boolean {
  if (!entry) return false;
  const modulePath = fileURLToPath(metaUrl);
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(entry) === modulePath;
  }
}

export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(home, '.codex');
}

export function defaultWorkflowStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return path.join(resolveCodexHome(env, home), 'workflow-state', 'v6');
}
