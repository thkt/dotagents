/** @file Outcome: One reviewed Think result has one compact JSON handoff and readable view. */

import fs from 'node:fs';
import { FlowError } from '../shared/errors.ts';
import { renderPlanMarkdown } from '../plan/contracts.ts';
import {
  artifactPaths,
  atomicWrite,
  atomicWriteText,
  thinkArtifactDirectory,
} from '../runtime/storage.ts';

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
  publicationPaths?: { json: string; markdown: string },
): { json: string; markdown: string } {
  const paths =
    publicationPaths ??
    artifactPaths(
      thinkArtifactDirectory(repo),
      report.request,
      new Date(report.generated_at),
      'think',
    );
  if (
    fs.existsSync(paths.json) &&
    fs.readFileSync(paths.json, 'utf8') !== `${JSON.stringify(report, null, 2)}\n`
  )
    throw new FlowError('Think publication conflicts with an existing report', 'state_error');
  if (!fs.existsSync(paths.json)) atomicWrite(paths.json, report);
  const markdown = renderThinkMarkdown(report);
  if (!fs.existsSync(paths.markdown) || fs.readFileSync(paths.markdown, 'utf8') !== markdown)
    atomicWriteText(paths.markdown, markdown);
  return paths;
}
