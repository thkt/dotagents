/** @file Outcome: Verified research has one durable JSON record and one faithful human view. */

import {
  atomicWrite,
  atomicWriteText,
  researchArtifactDirectory,
  artifactPaths,
} from '../runtime/storage.ts';

import { oneLine } from '../shared/text.ts';
import type { ResearchReport, ResearchReportEvidence } from './contracts.ts';

function markdownEvidence(evidence: ResearchReportEvidence): string {
  const source =
    evidence.kind === 'web'
      ? `[${evidence.source}](${evidence.source})`
      : `\`${evidence.source}:${evidence.locator}\``;
  const locator = evidence.kind === 'web' ? ` — ${evidence.locator}` : '';
  return `${source}${locator} — ${evidence.supports}`;
}

/** Renders the verified JSON report without adding claims. */
function renderResearchMarkdown(report: ResearchReport): string {
  const labels = {
    title: 'Research',
    answer: 'Answer',
    findings: 'Verified findings',
    evidence: 'Evidence',
    implication: 'Implication',
    qualification: 'Qualification',
    rejected: 'Rejected candidates',
    unknowns: 'Unknowns',
    resolution: 'How to resolve',
    limitations: 'Limitations',
    next: 'Next state',
  };
  const lines = [
    `# ${labels.title}: ${oneLine(report.question)}`,
    '',
    `- Generated: ${report.generated_at}`,
    '',
    `## ${labels.answer}`,
    '',
    report.answer,
    '',
    `## ${labels.findings}`,
    '',
  ];
  for (const finding of report.findings) {
    const verification = finding.qualification === null ? 'confirmed' : 'qualified';
    lines.push(
      `### ${finding.id} — ${verification} / ${finding.confidence}`,
      '',
      finding.statement,
      '',
      `- ${labels.evidence}:`,
      ...finding.evidence.map((item) => `  - ${markdownEvidence(item)}`),
      `- ${labels.implication}: ${oneLine(finding.implication)}`,
      ...(finding.qualification === null
        ? []
        : [`- ${labels.qualification}: ${oneLine(finding.qualification)}`]),
      '',
    );
  }
  if (report.rejected.length) {
    lines.push(`## ${labels.rejected}`, '');
    for (const item of report.rejected)
      lines.push(`- ${oneLine(item.statement)} — ${oneLine(item.reason)}`);
    lines.push('');
  }
  if (report.unknowns.length) {
    lines.push(`## ${labels.unknowns}`, '');
    for (const item of report.unknowns) {
      lines.push(
        `- ${oneLine(item.question)}`,
        `  - ${labels.resolution}: ${oneLine(item.resolution)}`,
      );
    }
    lines.push('');
  }
  if (report.limitations.length) {
    lines.push(
      `## ${labels.limitations}`,
      '',
      ...report.limitations.map((item) => `- ${oneLine(item)}`),
      '',
    );
  }
  lines.push(`## ${labels.next}`, '', 'think', '');
  return `${lines.join('\n')}\n`;
}

/** Persists the validated report beneath its repository-scoped private directory. */
export function persistResearchReport(
  repo: string,
  report: ResearchReport,
): { json: string; markdown: string } {
  const paths = artifactPaths(
    researchArtifactDirectory(repo),
    report.question,
    new Date(report.generated_at),
    'research',
  );
  atomicWrite(paths.json, report);
  atomicWriteText(paths.markdown, renderResearchMarkdown(report));
  return paths;
}
