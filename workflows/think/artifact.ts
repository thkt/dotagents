/** @file Outcome: One reviewed Think result has one compact JSON handoff and readable view. */

import { renderPlanMarkdown } from '../plan/contracts.ts';
import { artifactPaths } from '../shared/artifacts.ts';
import { atomicWrite, atomicWriteText, thinkArtifactDirectory } from '../shared/storage.ts';
import { oneLine } from '../shared/text.ts';
import { thinkNextStep, type ThinkReport } from './contracts.ts';

function renderThinkMarkdown(report: ThinkReport): string {
  const labels = { title: 'Design decision', research: 'Research required', next: 'Next state' };
  const lines = [
    `# ${labels.title}: ${oneLine(report.request)}`,
    '',
    `- Generated: ${report.generated_at}`,
    `- Status: ${report.status}`,
    '',
  ];
  if (report.plan) lines.push(renderPlanMarkdown(report.plan).trimEnd(), '');
  if (report.research_questions.length) {
    lines.push(
      `## ${labels.research}`,
      '',
      ...report.research_questions.map((item) => `- ${oneLine(item)}`),
      '',
    );
  }
  lines.push(`## ${labels.next}`, '', thinkNextStep(report.status), '');
  return `${lines.join('\n')}\n`;
}

export function persistThinkReport(
  repo: string,
  report: ThinkReport,
): { json: string; markdown: string } {
  const paths = artifactPaths(
    thinkArtifactDirectory(repo),
    report.request,
    new Date(report.generated_at),
    'think',
  );
  atomicWrite(paths.json, report);
  atomicWriteText(paths.markdown, renderThinkMarkdown(report));
  return paths;
}
