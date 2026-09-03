/** @file Outcome: Research and Think receive only Knowledge related to their current request. */

import path from 'node:path';

import { readKnowledge, relevance, type KnowledgeEntry } from './update.ts';

export function searchKnowledge(
  repo: string,
  query: string,
  excludedReports: readonly string[] = [],
): KnowledgeEntry[] {
  const excluded = new Set(excludedReports.map((report) => path.basename(report)));
  return readKnowledge(repo)
    .filter((entry) => entry.sources.every((source) => !excluded.has(source.report)))
    .map((entry) => ({ entry, score: relevance(query, `${entry.topic}\n${entry.summary}`) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.entry.updated_at.localeCompare(left.entry.updated_at) ||
        left.entry.topic.localeCompare(right.entry.topic),
    )
    .map(({ entry }) => entry);
}
