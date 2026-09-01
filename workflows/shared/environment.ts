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
export type ConfiguredLanguage = 'english' | 'japanese';

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

/** Resolves the workflow language from Codex config, with an explicit portable fallback. */
export function configuredCodexLanguage(
  fallback: ConfiguredLanguage,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ConfiguredLanguage {
  let config: string;
  try {
    config = fs.readFileSync(path.join(resolveCodexHome(env, home), 'config.toml'), 'utf8');
  } catch {
    return fallback;
  }
  const desktopStart = /^\[desktop\]\s*$/mu.exec(config);
  if (!desktopStart) return fallback;
  const remainder = config.slice(desktopStart.index + desktopStart[0].length);
  const nextSection = remainder.search(/^\[/mu);
  const desktop = nextSection === -1 ? remainder : remainder.slice(0, nextSection);
  const locale = /^localeOverride\s*=\s*["']([^"'\r\n]+)["']\s*(?:#.*)?$/mu.exec(desktop)?.[1];
  if (!locale) return fallback;
  if (/^ja(?:[-_]|$)/iu.test(locale)) return 'japanese';
  if (/^en(?:[-_]|$)/iu.test(locale)) return 'english';
  throw new Error(`Codex localeOverride is not supported by workflows: ${locale}`);
}

export function defaultWorkflowStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return path.join(resolveCodexHome(env, home), 'workflow-state', 'v6');
}
