/** @file Outcome: Shared Markdown text is normalized to compact one-line values. */

import type { ConfiguredLanguage } from './environment.ts';

export function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Splits readable prose at sentence boundaries while preserving every character. */
export function sentenceItems(value: string): string[] {
  return (oneLine(value).match(/[^。！？!?]+(?:[。！？!?]+|$)/gu) ?? [oneLine(value)]).flatMap(
    (item) => item.trim().split(/(?<=\.)\s+(?=\S)/u),
  );
}

/** Checks human prose against the language selected in Codex config. */
export function textMatchesLanguage(value: string, language: ConfiguredLanguage): boolean {
  const containsJapanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value);
  return language === 'japanese' ? containsJapanese : !containsJapanese;
}
