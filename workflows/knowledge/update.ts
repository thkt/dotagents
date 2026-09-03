/** @file Outcome: Completed Research becomes a compact topic-based Knowledge index automatically. */

import * as fs from 'node:fs';
import path from 'node:path';

import { parseResearchReport, type ResearchReport } from '../research/contracts.ts';
import {
  atomicWrite,
  knowledgeArtifactDirectory,
  researchArtifactDirectory,
} from '../shared/storage.ts';

interface KnowledgeSource {
  report: string;
  findings: string[];
}

export interface KnowledgeEntry {
  topic: string;
  summary: string;
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
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

function terms(value: string): Set<string> {
  return new Set(
    [...segmenter.segment(value.normalize('NFKC').toLocaleLowerCase())]
      .filter(
        (part) => part.isWordLike && part.segment.length > 1 && !ignoredTerms.has(part.segment),
      )
      .map((part) => part.segment),
  );
}

export function relevance(query: string, value: string): number {
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
  const directory = researchArtifactDirectory(repo);
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
    .flatMap((entry) => {
      try {
        return [
          {
            path: entry.name,
            report: parseResearchReport(
              JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')) as unknown,
            ),
          },
        ];
      } catch {
        return [];
      }
    })
    .filter(({ report }) => report.findings.length > 0)
    .sort(
      (left, right) =>
        left.report.generated_at.localeCompare(right.report.generated_at) ||
        left.path.localeCompare(right.path),
    );
}

function knowledgeStatement(finding: ResearchReport['findings'][number]): string {
  const notes = [
    ...(finding.kind === 'inference' ? ['inference'] : []),
    ...(finding.confidence === 'high' ? [] : [`${finding.confidence} confidence`]),
    ...(finding.qualification ? [finding.qualification] : []),
  ];
  return notes.length ? `${finding.statement} (${notes.join('; ')})` : finding.statement;
}

function addReport(entries: KnowledgeEntry[], artifact: string, report: ResearchReport): void {
  const existing = entries.find((entry) => sameTopic(entry.topic, report.question));
  const statements = report.findings.map(knowledgeStatement);
  const source = { report: artifact, findings: report.findings.map((finding) => finding.id) };
  if (!existing) {
    entries.push({
      topic: report.question,
      summary: statements.join('\n'),
      sources: [source],
      updated_at: report.generated_at,
    });
    return;
  }
  const priorStatements = existing.summary.split('\n').filter(Boolean);
  existing.summary = [...new Set([...priorStatements, ...statements])].join('\n');
  existing.sources.push(source);
  existing.updated_at = report.generated_at;
}

function indexPath(repo: string): string {
  return path.join(knowledgeArtifactDirectory(repo), 'index.json');
}

/** Rebuilds the derived Knowledge view so Research remains its recoverable source. */
export function updateKnowledge(repo: string): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  for (const { path: artifact, report } of researchReports(repo))
    addReport(entries, artifact, report);
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
        typeof value.summary === 'string' &&
        typeof value.updated_at === 'string' &&
        Array.isArray(value.sources) &&
        value.sources.every((source) => {
          if (!source || typeof source !== 'object') return false;
          const item = source as Record<string, unknown>;
          return (
            typeof item.report === 'string' &&
            Array.isArray(item.findings) &&
            item.findings.every((finding) => typeof finding === 'string')
          );
        })
      );
    });
  } catch {
    return [];
  }
}
