/** @file Outcome: Shared Markdown text is normalized to compact one-line values. */

export function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Splits readable prose at sentence boundaries while preserving every character. */
export function sentenceItems(value: string): string[] {
  return (oneLine(value).match(/[^。！？!?]+(?:[。！？!?]+|$)/gu) ?? [oneLine(value)]).flatMap(
    (item) => item.trim().split(/(?<=\.)\s+(?=\S)/u),
  );
}
