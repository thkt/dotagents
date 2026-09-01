/** @file Outcome: Shared Markdown text is normalized to compact one-line values. */

export function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
