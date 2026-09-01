/** @file Outcome: Verified research has one durable JSON record and one faithful human view. */

import { atomicWrite, atomicWriteText, researchArtifactDirectory } from '../shared/storage.ts';
import { artifactPaths } from '../shared/artifacts.ts';
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
export function renderResearchMarkdown(report: ResearchReport): string {
  const japanese = report.language === 'japanese';
  const labels = japanese
    ? {
        title: '調査',
        answer: '回答',
        findings: '確認済みの事実と推論',
        evidence: '証拠',
        implication: '意味',
        qualification: '留保',
        rejected: '棄却した候補',
        unknowns: '未確定事項',
        resolution: '確認方法',
        limitations: '制約',
        prior: '参照した過去の調査',
        next: '次の状態',
      }
    : {
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
        prior: 'Prior research consulted',
        next: 'Next state',
      };
  const lines = [
    `# ${labels.title}: ${oneLine(report.question)}`,
    '',
    `- Generated: ${report.generated_at}`,
    `- Mode: ${report.mode}`,
    `- Repository HEAD: ${report.repository.head ?? 'unborn'}`,
    `- Working tree dirty: ${report.repository.dirty}`,
    `- External sources: ${report.external_sources}`,
    '',
    '## Timings (ms)',
    '',
    ...Object.entries(report.timings).map(([stage, elapsed]) => `- ${stage}: ${elapsed}`),
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
  if (report.prior_reports.length) {
    lines.push(
      `## ${labels.prior}`,
      '',
      ...report.prior_reports.map((item) => `- \`${item}\``),
      '',
    );
  }
  lines.push(`## ${labels.next}`, '', report.next_step, '');
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
