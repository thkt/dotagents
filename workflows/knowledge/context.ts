/** @file Outcome: Compiles authoritative artifacts into ephemeral read-only workflow context. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  issueArtifactDirectory,
  researchArtifactDirectory,
  thinkArtifactDirectory,
} from '../shared/storage.ts';
import { readRepositoryEvidence, sha256 } from '../shared/evidence.ts';
import { parseResearchReport } from '../research/contracts.ts';
import { parseThinkReport } from '../think/contracts.ts';
import { parseIssueDraft } from '../issue/contracts.ts';
import { parsePublishedIssueReceipt } from '../issue/receipt.ts';

interface ContextEntry {
  id: string;
  kind: 'knowledge' | 'decision';
  status: 'active' | 'review_required';
  statement: string;
  source_artifact: string;
  source_id: string;
}
export interface ContextResult {
  status: 'loaded' | 'degraded';
  entries: ContextEntry[];
}
const id = (kind: string, artifact: string, source: string) => `${kind}:${artifact}:${source}`;
function artifactFiles(dir: string): { paths: string[]; degraded: boolean } {
  try {
    const directory = fs.lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      return { paths: [], degraded: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { paths: [], degraded: false };
    return { paths: [], degraded: true };
  }
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return { paths: [], degraded: true };
  }
  let degraded = false;
  const paths = names.flatMap((name) => {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        degraded = true;
        return [];
      }
      return [file];
    } catch {
      degraded = true;
      return [];
    }
  });
  return { paths, degraded };
}

function collectKnowledgeEntries(
  repo: string,
  includeLeads: boolean,
): { entries: ContextEntry[]; degraded: boolean } {
  const entries: ContextEntry[] = [];
  const scan = artifactFiles(researchArtifactDirectory(repo));
  let degraded = scan.degraded;
  for (const file of scan.paths)
    try {
      const report = parseResearchReport(JSON.parse(fs.readFileSync(file, 'utf8')));
      for (const finding of report.findings) {
        const repositoryEvidence = finding.evidence.filter((e) => e.kind === 'repository');
        const current =
          repositoryEvidence.length > 0 &&
          repositoryEvidence.every((e) => {
            try {
              return (
                readRepositoryEvidence(repo, e.source, e.locator, 'knowledge').source_sha256 ===
                e.source_sha256
              );
            } catch {
              return false;
            }
          });
        if (!current && repositoryEvidence.length > 0) continue;
        const active =
          finding.kind === 'fact' &&
          finding.confidence === 'high' &&
          finding.qualification === null &&
          repositoryEvidence.length > 0 &&
          current;
        if (active || includeLeads)
          entries.push({
            id: id('knowledge', path.basename(file), finding.id),
            kind: 'knowledge',
            status: active ? 'active' : 'review_required',
            statement: finding.statement,
            source_artifact: path.basename(file),
            source_id: finding.id,
          });
      }
    } catch {
      degraded = true;
    }
  return { entries, degraded };
}

function collectDecisionEntries(repo: string): { entries: ContextEntry[]; degraded: boolean } {
  const entries: ContextEntry[] = [];
  const scan = artifactFiles(issueArtifactDirectory(repo));
  let degraded = scan.degraded;
  for (const receiptFile of scan.paths.filter((file) => file.endsWith('.published.json')))
    try {
      const raw = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as unknown;
      const receipt = parsePublishedIssueReceipt(raw, repo);
      const draftFile = receiptFile.slice(0, -'.published.json'.length);
      if (
        !path
          .resolve(draftFile)
          .startsWith(`${path.resolve(issueArtifactDirectory(repo))}${path.sep}`)
      )
        throw new Error('draft path');
      const draftStat = fs.lstatSync(draftFile);
      if (!draftStat.isFile() || draftStat.isSymbolicLink()) throw new Error('draft file');
      const draftBytes = fs.readFileSync(draftFile);
      if (sha256(draftBytes) !== receipt.draft_sha256) throw new Error('digest');
      const draft = parseIssueDraft(JSON.parse(draftBytes.toString('utf8')));
      const thinkFile = path.resolve(draft.think_report);
      const thinkDir = path.resolve(thinkArtifactDirectory(repo));
      if (!thinkFile.startsWith(`${thinkDir}${path.sep}`)) throw new Error('think path');
      const thinkStat = fs.lstatSync(thinkFile);
      if (!thinkStat.isFile() || thinkStat.isSymbolicLink()) throw new Error('think file');
      const thinkBytes = fs.readFileSync(thinkFile);
      if (sha256(thinkBytes) !== draft.think_sha256) throw new Error('think digest');
      const think = parseThinkReport(JSON.parse(thinkBytes.toString('utf8')));
      if (think.readiness !== 'ready') throw new Error('not ready');
      entries.push({
        id: id('decision', path.basename(draft.think_report), draft.think_sha256),
        kind: 'decision',
        status: 'active',
        statement: think.decision,
        source_artifact: path.basename(draft.think_report),
        source_id: draft.think_sha256,
      });
    } catch {
      degraded = true;
    }
  return { entries, degraded };
}

export function compileContext(repo: string, mode: 'research' | 'think'): ContextResult {
  const includeKnowledgeLeads = mode === 'research';
  const knowledge = collectKnowledgeEntries(repo, includeKnowledgeLeads);
  const decision =
    mode === 'think' ? collectDecisionEntries(repo) : { entries: [], degraded: false };
  return {
    status: knowledge.degraded || decision.degraded ? 'degraded' : 'loaded',
    entries: [...knowledge.entries, ...decision.entries]
      .sort(
        (a, b) =>
          a.source_artifact.localeCompare(b.source_artifact) ||
          a.source_id.localeCompare(b.source_id),
      )
      .slice(0, 20),
  };
}
