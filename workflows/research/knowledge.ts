/** @file Outcome: Completed Research becomes a compact topic-based Knowledge index automatically. */

import * as fs from 'node:fs';
import path from 'node:path';
import type { ResearchReport } from './contracts.ts';
import { corpusDirectory, readCorpusReport, verifyResearchCorpus } from './corpus.ts';
import { atomicWrite, knowledgeArtifactDirectory } from '../runtime/storage.ts';
import { FlowError } from '../shared/errors.ts';

interface KnowledgeSource {
  report: string;
  research_id: string;
  generated_at: string;
}

export interface KnowledgeEntry {
  topic: string;
  sources: KnowledgeSource[];
  updated_at: string;
}

const ignoredTerms = new Set([
  'する',
  'ある',
  'いる',
  'なる',
  'できる',
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
]);
const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function terms(value: string): Set<string> {
  return new Set(
    [...segmenter.segment(value.normalize('NFKC').toLowerCase())]
      .filter(
        (part) => part.isWordLike && part.segment.length > 1 && !ignoredTerms.has(part.segment),
      )
      .map((part) => part.segment),
  );
}

function relevance(query: string, value: string): number {
  const valueTerms = terms(value);
  return [...terms(query)].reduce((score, term) => score + Number(valueTerms.has(term)), 0);
}

function sameTopic(left: string, right: string): boolean {
  const leftTerms = terms(left);
  const rightTerms = terms(right);
  const overlap = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  return overlap >= 2 || (overlap === 1 && Math.min(leftTerms.size, rightTerms.size) === 1);
}

function researchReports(repo: string): { path: string; report: ResearchReport }[] {
  // Omitting broken pairs before ranking would silently revive older topic evidence.
  return verifyResearchCorpus(repo)
    .map((report) => ({ path: `${report.research_id}.json`, report }))
    .filter(({ report }) => report.findings.length > 0)
    .sort(
      (left, right) =>
        left.report.generated_at.localeCompare(right.report.generated_at) ||
        compare(left.path, right.path),
    );
}

function latestSource(entry: KnowledgeEntry): KnowledgeSource | undefined {
  return [...entry.sources].sort(
    (left, right) =>
      right.generated_at.localeCompare(left.generated_at) || compare(left.report, right.report),
  )[0];
}

function addReport(entries: KnowledgeEntry[], artifact: string, report: ResearchReport): void {
  const existing = entries.find((entry) => sameTopic(entry.topic, report.question));
  const source = {
    report: artifact,
    research_id: report.research_id!,
    generated_at: report.generated_at,
  };
  if (!existing) {
    entries.push({
      topic: report.question,
      sources: [source],
      updated_at: report.generated_at,
    });
    return;
  }
  existing.sources.push(source);
  existing.updated_at = report.generated_at;
}

function indexPath(repo: string): string {
  return path.join(knowledgeArtifactDirectory(repo), 'index.json');
}

/** Rebuilds the derived Knowledge view so Research remains its recoverable source. */
export function updateKnowledge(repo: string): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const reports = researchReports(repo);
  const identities = new Set(reports.map(({ report }) => report.research_id));
  // The old index supplies no content. It only prevents losing a known latest reference
  // when both members have disappeared and pair validation alone cannot detect the loss.
  for (const previous of readKnowledge(repo)) {
    const latest = latestSource(previous);
    if (latest && !identities.has(latest.research_id))
      throw new FlowError('Knowledge rebuild requires unavailable latest Research', 'state_error');
  }
  for (const { path: artifact, report } of reports) addReport(entries, artifact, report);
  atomicWrite(indexPath(repo), entries);
  return entries;
}

export function readKnowledge(repo: string): KnowledgeEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(repo), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is KnowledgeEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const value = entry as Record<string, unknown>;
      return (
        typeof value.topic === 'string' &&
        typeof value.updated_at === 'string' &&
        Array.isArray(value.sources) &&
        value.sources.every((source) => {
          if (!source || typeof source !== 'object') return false;
          const item = source as Record<string, unknown>;
          return (
            typeof item.research_id === 'string' &&
            /^[a-f0-9]{64}$/u.test(item.research_id) &&
            item.report === `${item.research_id}.json` &&
            typeof item.report === 'string' &&
            path.basename(item.report) === item.report &&
            typeof item.generated_at === 'string'
          );
        })
      );
    });
  } catch {
    return [];
  }
}

export const KNOWLEDGE_RESULT_LIMIT = 3;

/** Selects one latest report per topic; dates rank leads, never establish factual freshness. */
export function searchKnowledge(
  repo: string,
  query: string,
  excludedReports: readonly string[] = [],
  snapshotRepo: string = repo,
): KnowledgeEntry[] {
  const seen = new Set(excludedReports.map((report) => path.basename(report)));
  const ranked = readKnowledge(repo)
    .map((entry) => ({ entry, score: relevance(query, entry.topic) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.entry.updated_at.localeCompare(left.entry.updated_at) ||
        compare(left.entry.topic, right.entry.topic),
    );
  const results: KnowledgeEntry[] = [];
  for (const { entry } of ranked) {
    const latest = latestSource(entry);
    // Never fall back to older evidence when the latest report is already selected.
    if (!latest || seen.has(latest.report)) continue;
    seen.add(latest.report);
    try {
      const report = readCorpusReport(
        snapshotRepo,
        path.join(corpusDirectory(snapshotRepo), latest.report),
      );
      if (report.research_id !== latest.research_id || report.generated_at !== latest.generated_at)
        continue;
    } catch {
      continue;
    }
    results.push({ topic: entry.topic, sources: [latest], updated_at: latest.generated_at });
    if (results.length === KNOWLEDGE_RESULT_LIMIT) break;
  }
  return results;
}
