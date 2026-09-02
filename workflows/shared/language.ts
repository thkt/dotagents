/** @file Outcome: Every workflow resolves and enforces one language from Codex configuration. */

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCodexHome } from './environment.ts';
import { FlowError } from './errors.ts';

export const CONFIGURED_LANGUAGES = ['english', 'japanese'] as const;
export type ConfiguredLanguage = (typeof CONFIGURED_LANGUAGES)[number];

export function resolveConfiguredLanguage(
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
  const start = /^\[desktop\]\s*$/mu.exec(config);
  if (!start) return fallback;
  const remainder = config.slice(start.index + start[0].length);
  const nextSection = remainder.search(/^\[/mu);
  const desktop = nextSection === -1 ? remainder : remainder.slice(0, nextSection);
  const locale = /^localeOverride\s*=\s*["']([^"'\r\n]+)["']\s*(?:#.*)?$/mu.exec(desktop)?.[1];
  if (!locale) return fallback;
  if (/^ja(?:[-_]|$)/iu.test(locale)) return 'japanese';
  if (/^en(?:[-_]|$)/iu.test(locale)) return 'english';
  throw new FlowError(`Codex localeOverride is not supported by workflows: ${locale}`);
}

export function requireConfiguredLanguage(declared: ConfiguredLanguage): void {
  const configured = resolveConfiguredLanguage(declared);
  if (declared !== configured) {
    throw new FlowError(`input language must match Codex config: ${configured}`);
  }
}

export function requireLanguageText(
  value: string,
  language: ConfiguredLanguage,
  label: string,
): void {
  const containsJapanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value);
  if ((language === 'japanese') !== containsJapanese) {
    throw new FlowError(`${label} must be written in ${language}`, 'decision_error');
  }
}
